import Fastify from 'fastify';
import { AccessToken } from 'livekit-server-sdk';
import {
  config, CHANNELS, isValidChannel, MAX_MESSAGE_LENGTH,
  MAX_POLL_QUESTION, MAX_POLL_OPTION, MIN_POLL_OPTIONS, MAX_POLL_OPTIONS,
  REACTION_EMOJIS, isValidReaction,
} from './config.js';
import { registerAuthRoutes, userFromRequest } from './auth.js';
import {
  recentMessages, saveMessage, touchPresence, setStatus, findUserById,
  findPoll, setVote, messageById, messageOwner, editMessage, deleteMessage,
  toggleReaction, purgeMessage, allUsers, lastReadMessageId, markRead,
  type User, type NovaPoll, type MessageRow,
} from './db.js';
import { mencionadosEm } from './texto.js';
import { rateLimit } from './ratelimit.js';
import { presence, usersPresence, statusEfetivo } from './presence.js';
import { registerProfileRoutes } from './profile.js';
import { registerFileRoutes, paraCliente, apagarAnexo } from './arquivos.js';
import { iniciarContagemDeTempo } from './tempo.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  trustProxy: true, // está atrás do Caddy
});

registerAuthRoutes(app);
registerProfileRoutes(app);
registerFileRoutes(app);

/** Exige sessão válida. Responde 401 e retorna null se não houver. */
async function requireUser(req: any, reply: any): Promise<User | null> {
  const user = await userFromRequest(req);
  if (!user) {
    reply.code(401).send({ error: 'não autenticado' });
    return null;
  }
  return user;
}

/**
 * Quem pode apagar mensagem dos outros. Ver config.admins.
 *
 * A comparação é por e-mail em minúsculas dos dois lados: o config já
 * normaliza a lista, e o e-mail no banco entra normalizado pelo callback do
 * Google (ver auth.ts). Um admin que não funciona por causa de uma
 * maiúscula seria o tipo de bug que ninguém procura no lugar certo.
 */
function isAdmin(user: User): boolean {
  return config.admins.includes(user.email.toLowerCase());
}

/**
 * A mensagem com as URLs dos anexos prontas.
 *
 * Único lugar que faz essa passagem, e por isso todas as rotas que devolvem
 * mensagem passam por aqui — a lista, o envio, a edição e a reação.
 */
function paraOCliente(m: MessageRow) {
  return { ...m, attachments: m.attachments.map(paraCliente) };
}

/**
 * Quem o texto menciona, resolvido AQUI e não no cliente.
 *
 * É esta lista que decide quem recebe notificação, então ela não pode
 * depender de cada app reinterpretar a frase — um cliente numa versão
 * anterior deixaria alguém sem aviso sem ninguém perceber. O tokenizer é
 * literalmente o mesmo arquivo dos dois lados (ver texto.ts), então o que
 * vira chip na tela e o que vira notificação nunca discordam.
 */
function mencoesDe(corpo: string, autorId: string): string[] {
  return mencionadosEm(
    corpo,
    allUsers().map((u) => ({ id: u.id, name: u.name })),
    autorId,
  );
}

app.get('/health', async () => ({ ok: true }));

app.get('/api/me', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatar_url,
    channels: CHANNELS,
    livekitUrl: config.livekit.url,
    // Só pra tela decidir se mostra o botão de apagar a mensagem dos outros.
    // Quem MANDA continua sendo o servidor, que confere de novo na rota — o
    // cliente esconder um botão não é controle de acesso.
    isAdmin: isAdmin(user),
    // A tirinha de reações vem do servidor pra não existirem duas listas.
    reactionEmojis: REACTION_EMOJIS,
    // Até onde esta pessoa já leu, nas DUAS máquinas — ver message_reads.
    lastReadMessageId: lastReadMessageId(user.id),
  };
});

/**
 * Emite token de sala do LiveKit.
 * Curto (10min), escopado a UMA sala e UMA identidade, assinado aqui no servidor.
 * O cliente nunca escolhe suas próprias permissões.
 */
app.post('/api/rooms/:channelId/token', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  const { channelId } = req.params as { channelId: string };
  if (!isValidChannel(channelId)) {
    return reply.code(404).send({ error: 'canal inexistente' });
  }

  if (!rateLimit(`token:${user.id}`, 30, 60_000)) {
    return reply.code(429).send({ error: 'muitas tentativas, aguarde' });
  }

  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: user.id,
    name: user.name,
    metadata: JSON.stringify({ avatarUrl: user.avatar_url }),
    ttl: '10m',
  });

  at.addGrant({
    roomJoin: true,
    room: channelId,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    // Ninguém administra sala pelo cliente
    roomAdmin: false,
    roomCreate: false,
  });

  return { token: await at.toJwt(), url: config.livekit.url, channelId };
});

/**
 * Token de ingress WHIP — é o que o OBS usa pra publicar com NVENC.
 * Reaproveita a identidade do usuário, com sufixo pra não colidir com a sessão de voz.
 */
app.post('/api/rooms/:channelId/whip', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  const { channelId } = req.params as { channelId: string };
  if (!isValidChannel(channelId)) {
    return reply.code(404).send({ error: 'canal inexistente' });
  }

  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: `${user.id}_obs`,
    name: `${user.name} (tela)`,
    ttl: '2h',
  });
  at.addGrant({ roomJoin: true, room: channelId, canPublish: true, canSubscribe: false });

  return {
    endpoint: `${config.publicUrl}/whip`,
    bearerToken: await at.toJwt(),
    channelId,
  };
});

/**
 * Quem está em cada canal, inclusive nos que você não entrou.
 * Serve a lista da sidebar — ver presence.ts.
 */
app.get('/api/presence', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;
  return { channels: await presence(), users: usersPresence() };
});

/**
 * Batimento do app aberto.
 *
 * `ativo` é o que separa os dois relógios: toda batida diz "ainda estou
 * aqui", mas só quem estava com o microfone aberto renova o contador dos 10
 * minutos. Vem junto o status efetivo próprio, pra que o app mostre
 * "Ausente" no seletor sem ter que refazer a mesma conta do lado de cá.
 *
 * `falou` era o nome deste campo até a 0.17.0, quando o critério era falar
 * em vez de estar com o microfone aberto. Aceito aqui só para que um app
 * ainda não atualizado não apareça ausente sem motivo; pode sair quando
 * ninguém estiver mais nessa versão.
 */
app.post('/api/me/heartbeat', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  const { ativo, falou } = (req.body ?? {}) as { ativo?: unknown; falou?: unknown };
  touchPresence(user.id, ativo === true || falou === true);

  return { status: statusEfetivo(findUserById(user.id)!) };
});

/** O status que a pessoa escolhe no seletor. */
app.patch('/api/me/status', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  const { status } = (req.body ?? {}) as { status?: unknown };
  if (status !== 'disponivel' && status !== 'ausente' && status !== 'invisivel') {
    return reply.code(400).send({ error: 'status inválido' });
  }

  setStatus(user.id, status);
  return { status };
});

/**
 * Avança o ponteiro de leitura. O corpo é a maior mensagem que o app tem na
 * tela, não um incremento — mandar o mesmo valor duas vezes dá o mesmo
 * resultado, e chegar atrasado (a outra máquina já leu mais longe) não
 * anda pra trás: ver o MAX no setLastRead.
 */
app.put('/api/me/read', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  if (!rateLimit(`read:${user.id}`, 30, 10_000)) {
    return reply.code(429).send({ error: 'devagar aí' });
  }

  const { messageId } = (req.body ?? {}) as { messageId?: unknown };
  if (!Number.isInteger(messageId) || (messageId as number) < 0) {
    return reply.code(400).send({ error: 'id inválido' });
  }

  return { lastReadMessageId: markRead(user.id, messageId as number) };
});

/**
 * Valida a enquete que chegou no corpo da mensagem.
 *
 * Devolve a enquete pronta ou o motivo da recusa — nunca as duas coisas.
 * Está numa função à parte porque a rota de mensagem já é comprida e
 * porque validar enquete é o tipo de coisa que se lê melhor de uma vez.
 */
function lerPoll(bruto: unknown): { poll: NovaPoll } | { erro: string } {
  if (bruto === null || typeof bruto !== 'object') return { erro: 'enquete inválida' };

  const { question, options, multi } = bruto as {
    question?: unknown; options?: unknown; multi?: unknown;
  };

  if (typeof question !== 'string') return { erro: 'pergunta inválida' };
  const pergunta = question.trim();
  if (!pergunta) return { erro: 'pergunta vazia' };
  if (pergunta.length > MAX_POLL_QUESTION) return { erro: 'pergunta muito longa' };

  if (!Array.isArray(options)) return { erro: 'opções inválidas' };
  const opcoes: string[] = [];
  for (const o of options) {
    if (typeof o !== 'string') return { erro: 'opções inválidas' };
    const texto = o.trim();
    // Opção em branco é descartada em vez de recusada: o formulário nasce
    // com campos vazios de sobra, e quem preencheu só duas não errou nada.
    if (!texto) continue;
    if (texto.length > MAX_POLL_OPTION) return { erro: 'opção muito longa' };
    opcoes.push(texto);
  }

  if (opcoes.length < MIN_POLL_OPTIONS) return { erro: 'a enquete precisa de 2 opções' };
  if (opcoes.length > MAX_POLL_OPTIONS) return { erro: 'a enquete aceita até 6 opções' };

  return { poll: { question: pergunta, options: opcoes, multi: multi === true } };
}

app.get('/api/messages', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;
  return { messages: recentMessages(100).map(paraOCliente) };
});

app.post('/api/messages', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  if (!rateLimit(`msg:${user.id}`, 20, 10_000)) {
    return reply.code(429).send({ error: 'devagar aí' });
  }

  const { body, attachmentId, poll, replyToId } = (req.body ?? {}) as {
    body?: unknown;
    attachmentId?: unknown;
    poll?: unknown;
    replyToId?: unknown;
  };
  if (typeof body !== 'string') {
    return reply.code(400).send({ error: 'corpo inválido' });
  }
  if (attachmentId !== undefined && typeof attachmentId !== 'string') {
    return reply.code(400).send({ error: 'anexo inválido' });
  }

  // A original tem que existir E estar viva: responder a uma lápide é
  // pedir um card de citação que já nasce dizendo "mensagem removida".
  let respondendo: number | null = null;
  if (replyToId !== undefined && replyToId !== null) {
    if (!Number.isInteger(replyToId)) {
      return reply.code(400).send({ error: 'resposta inválida' });
    }
    const alvo = messageOwner(replyToId as number);
    if (!alvo || alvo.deleted_at !== null) {
      return reply.code(400).send({ error: 'a mensagem respondida não existe mais' });
    }
    respondendo = replyToId as number;
  }

  let novaPoll: NovaPoll | null = null;
  if (poll !== undefined) {
    const r = lerPoll(poll);
    if ('erro' in r) return reply.code(400).send({ error: r.erro });
    novaPoll = r.poll;
  }

  const text = body.trim();
  // Sem texto só se vier anexo ou enquete: mandar uma foto sem legenda é
  // normal, mandar um balão vazio não. A pergunta da enquete já é o texto.
  if (!text && !attachmentId && !novaPoll) {
    return reply.code(400).send({ error: 'mensagem vazia' });
  }
  if (text.length > MAX_MESSAGE_LENGTH) {
    return reply.code(400).send({ error: 'mensagem muito longa' });
  }

  // O anexo já subiu e está órfão esperando por isto. saveMessage amarra os
  // dois numa transação e recusa anexo que não seja seu.
  let id: number;
  try {
    // Guardamos o texto cru. A sanitização acontece na renderização,
    // que é o único lugar onde XSS pode virar execução.
    id = saveMessage(
      user.id, text, attachmentId ?? null, novaPoll, respondendo,
      mencoesDe(text, user.id),
    );
  } catch {
    return reply.code(400).send({ error: 'anexo inválido' });
  }

  // Relida do banco inteira, pela MESMA montagem que a lista usa. Antes esta
  // resposta era montada à mão aqui, campo a campo — e cada campo novo
  // (reação, citação, "editado") era mais uma chance de o balão que acabou
  // de sair sair diferente do mesmo balão relido três segundos depois.
  return { message: paraOCliente(messageById(id)!) };
});

/**
 * Editar. Só o autor, e só mensagem viva.
 *
 * Admin não entra aqui de propósito: apagar o que não presta é moderação,
 * reescrever a fala de outra pessoa é outra coisa. Ninguém edita o texto de
 * ninguém.
 */
app.patch('/api/messages/:id', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  if (!rateLimit(`edit:${user.id}`, 20, 10_000)) {
    return reply.code(429).send({ error: 'devagar aí' });
  }

  const id = Number((req.params as { id: string }).id);
  const alvo = messageOwner(id);
  if (!alvo) return reply.code(404).send({ error: 'mensagem inexistente' });
  if (alvo.deleted_at !== null) {
    return reply.code(410).send({ error: 'essa mensagem foi apagada' });
  }
  if (alvo.user_id !== user.id) {
    return reply.code(403).send({ error: 'essa mensagem não é sua' });
  }

  const { body } = (req.body ?? {}) as { body?: unknown };
  if (typeof body !== 'string') {
    return reply.code(400).send({ error: 'corpo inválido' });
  }
  const text = body.trim();
  if (text.length > MAX_MESSAGE_LENGTH) {
    return reply.code(400).send({ error: 'mensagem muito longa' });
  }

  // Esvaziar não é apagar: apagar tem rota própria, e deixar o texto sumir
  // por edição daria uma segunda porta pro mesmo lugar, sem lápide e sem a
  // limpeza dos bytes do anexo. Quem quer apagar, apaga.
  const atual = messageById(id)!;
  if (!text && atual.attachments.length === 0 && !atual.poll) {
    return reply.code(400).send({ error: 'mensagem vazia — use apagar' });
  }

  // As menções são refeitas junto: quem foi tirado da frase para de estar
  // marcado, e quem foi adicionado passa a estar. Na mesma transação.
  editMessage(id, text, mencoesDe(text, user.id));
  return { message: paraOCliente(messageById(id)!) };
});

/**
 * Apagar. O autor, ou um admin.
 *
 * Vira lápide em vez de sumir com a linha: uma resposta pode estar apontando
 * pra ela, e uma enquete é filha dela. Os bytes do anexo, esses somem de
 * verdade — ver deleteMessage no db.ts.
 */
app.delete('/api/messages/:id', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  if (!rateLimit(`del:${user.id}`, 20, 10_000)) {
    return reply.code(429).send({ error: 'devagar aí' });
  }

  const id = Number((req.params as { id: string }).id);
  const alvo = messageOwner(id);
  if (!alvo) return reply.code(404).send({ error: 'mensagem inexistente' });
  if (alvo.user_id !== user.id && !isAdmin(user)) {
    return reply.code(403).send({ error: 'essa mensagem não é sua' });
  }

  // Já apagada: responde o estado atual em vez de 410. Dois cliques rápidos
  // no mesmo botão não são um erro que valha uma mensagem vermelha na tela.
  if (alvo.deleted_at === null) {
    for (const anexoId of deleteMessage(id)) apagarAnexo(anexoId);
  }

  return { message: paraOCliente(messageById(id)!) };
});

/**
 * Segundo estágio: tira a lápide da conversa de vez.
 *
 * Só funciona em mensagem que JÁ é lápide, e isso é a regra que sustenta o
 * resto: obriga a passar pelo DELETE normal antes, que é quem apaga os bytes
 * do anexo. Um atalho daqui pra uma mensagem viva pularia essa limpeza e
 * deixaria o arquivo no disco sem dono.
 *
 * Não devolve mensagem — não há mais mensagem. Devolve o id, que é o que o
 * cliente precisa pra tirar da lista.
 */
app.delete('/api/messages/:id/definitivo', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  if (!rateLimit(`purge:${user.id}`, 20, 10_000)) {
    return reply.code(429).send({ error: 'devagar aí' });
  }

  const id = Number((req.params as { id: string }).id);
  const alvo = messageOwner(id);
  // Já não existe: responde sucesso. Dois cliques na confirmação, ou duas
  // pessoas limpando a mesma lápide, não são erro — o fim pretendido é o
  // mesmo, e o cliente só quer saber que pode tirar da tela.
  if (!alvo) return { removed: true, id };

  if (alvo.user_id !== user.id && !isAdmin(user)) {
    return reply.code(403).send({ error: 'essa mensagem não é sua' });
  }
  if (alvo.deleted_at === null) {
    return reply.code(409).send({ error: 'apague a mensagem antes de removê-la de vez' });
  }

  for (const anexoId of purgeMessage(id)) apagarAnexo(anexoId);
  return { removed: true, id };
});

/**
 * Liga/desliga uma reação sua. Idempotente por emoji: mandar duas vezes
 * volta ao estado inicial, que é o que um botão de alternar faz.
 */
app.put('/api/messages/:id/reactions', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  if (!rateLimit(`react:${user.id}`, 60, 10_000)) {
    return reply.code(429).send({ error: 'devagar aí' });
  }

  const id = Number((req.params as { id: string }).id);
  const alvo = messageOwner(id);
  if (!alvo) return reply.code(404).send({ error: 'mensagem inexistente' });
  if (alvo.deleted_at !== null) {
    return reply.code(410).send({ error: 'essa mensagem foi apagada' });
  }

  const { emoji } = (req.body ?? {}) as { emoji?: unknown };
  // A lista fechada é o que impede a coluna de virar depósito de qualquer
  // string que um cliente resolva mandar. Ver REACTION_EMOJIS.
  if (typeof emoji !== 'string' || !isValidReaction(emoji)) {
    return reply.code(400).send({ error: 'emoji inválido' });
  }

  toggleReaction(id, user.id, emoji);
  return { message: paraOCliente(messageById(id)!) };
});

/**
 * A apuração de UMA enquete.
 *
 * Existe pro aviso de voto que chega pelo data channel: quem recebe
 * pergunta ao SERVIDOR quanto ficou, em vez de somar um no número que já
 * tinha. Um voto perdido no caminho deixaria dois apps com contas
 * diferentes e nada que as reconciliasse.
 */
app.get('/api/polls/:id', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  const { id } = req.params as { id: string };
  const poll = findPoll(Number(id));
  if (!poll) return reply.code(404).send({ error: 'enquete inexistente' });
  return { poll };
});

/**
 * O voto. PUT porque o corpo é o conjunto INTEIRO de opções marcadas, e
 * não um incremento: mandar duas vezes o mesmo voto dá o mesmo resultado.
 */
app.put('/api/polls/:id/vote', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  if (!rateLimit(`vote:${user.id}`, 30, 10_000)) {
    return reply.code(429).send({ error: 'devagar aí' });
  }

  const { id } = req.params as { id: string };
  const pollId = Number(id);
  const poll = findPoll(pollId);
  if (!poll) return reply.code(404).send({ error: 'enquete inexistente' });

  const { options } = (req.body ?? {}) as { options?: unknown };
  if (!Array.isArray(options)) {
    return reply.code(400).send({ error: 'voto inválido' });
  }

  // Set: marcar a mesma opção duas vezes na mesma requisição violaria a
  // chave primária e derrubaria a transação inteira. Aqui vira uma só.
  const indices = new Set<number>();
  for (const o of options) {
    if (!Number.isInteger(o) || (o as number) < 0 || (o as number) >= poll.options.length) {
      return reply.code(400).send({ error: 'opção inexistente' });
    }
    indices.add(o as number);
  }

  if (!poll.multi && indices.size > 1) {
    return reply.code(400).send({ error: 'essa enquete aceita um voto só' });
  }

  setVote(pollId, user.id, [...indices]);
  return { poll: findPoll(pollId)! };
});

const start = async () => {
  if (config.allowlist.length === 0) {
    app.log.warn('ALLOWED_EMAILS está vazio — ninguém vai conseguir entrar');
  }
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`allowlist: ${config.allowlist.length} e-mail(s)`);

  // Depois do listen: o ticker fala com o LiveKit, e não há por que começar
  // a bater lá antes de o servidor estar de pé pra ser útil.
  iniciarContagemDeTempo();
};

start().catch((err) => {
  app.log.error(err);
  process.exit(1);
});
