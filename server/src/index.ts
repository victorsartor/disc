import Fastify from 'fastify';
import { AccessToken } from 'livekit-server-sdk';
import { config, CHANNELS, isValidChannel, MAX_MESSAGE_LENGTH } from './config.js';
import { registerAuthRoutes, userFromRequest } from './auth.js';
import {
  recentMessages, saveMessage, touchPresence, setStatus, findUserById,
  findAttachment, type User,
} from './db.js';
import { rateLimit } from './ratelimit.js';
import { presence, usersPresence, statusEfetivo } from './presence.js';
import { registerProfileRoutes } from './profile.js';
import { registerFileRoutes, paraCliente } from './arquivos.js';
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

app.get('/api/messages', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;
  return {
    messages: recentMessages(100).map((m) => ({
      ...m,
      attachments: m.attachments.map(paraCliente),
    })),
  };
});

app.post('/api/messages', async (req, reply) => {
  const user = await requireUser(req, reply);
  if (!user) return;

  if (!rateLimit(`msg:${user.id}`, 20, 10_000)) {
    return reply.code(429).send({ error: 'devagar aí' });
  }

  const { body, attachmentId } = (req.body ?? {}) as {
    body?: unknown;
    attachmentId?: unknown;
  };
  if (typeof body !== 'string') {
    return reply.code(400).send({ error: 'corpo inválido' });
  }
  if (attachmentId !== undefined && typeof attachmentId !== 'string') {
    return reply.code(400).send({ error: 'anexo inválido' });
  }

  const text = body.trim();
  // Sem texto só se vier anexo: mandar uma foto sem legenda é normal,
  // mandar um balão vazio não.
  if (!text && !attachmentId) return reply.code(400).send({ error: 'mensagem vazia' });
  if (text.length > MAX_MESSAGE_LENGTH) {
    return reply.code(400).send({ error: 'mensagem muito longa' });
  }

  // O anexo já subiu e está órfão esperando por isto. saveMessage amarra os
  // dois numa transação e recusa anexo que não seja seu.
  let id: number;
  try {
    // Guardamos o texto cru. A sanitização acontece na renderização,
    // que é o único lugar onde XSS pode virar execução.
    id = saveMessage(user.id, text, attachmentId ?? null);
  } catch {
    return reply.code(400).send({ error: 'anexo inválido' });
  }

  const anexo = attachmentId ? findAttachment(attachmentId) : undefined;

  return {
    message: {
      id,
      body: text,
      created_at: Date.now(),
      user_id: user.id,
      author_name: user.name,
      author_avatar: user.avatar_url,
      // Um app numa versão anterior a esta ignora o campo e desenha só o
      // body — que numa foto sem legenda é vazio. Balão em branco até a
      // pessoa atualizar; o electron-updater fecha essa janela sozinho.
      attachments: anexo ? [paraCliente(anexo)] : [],
    },
  };
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
