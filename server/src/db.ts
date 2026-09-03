import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

// Perguntado ANTES do CREATE TABLE IF NOT EXISTS de message_reads, mais
// abaixo: é o que distingue banco novo de banco que está ganhando a tabela
// agora, e só o segundo caso precisa do backfill logo depois do exec.
const messageReadsEraNova = db
  .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_reads'`)
  .get() === undefined;

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    email      TEXT UNIQUE NOT NULL,
    name       TEXT NOT NULL,
    avatar_url TEXT,
    created_at INTEGER NOT NULL
  );

  -- Fotos de perfil e capas. Ficam aqui, e não numa pasta de uploads, porque
  -- o banco já é o único volume que o compose persiste — um segundo lugar
  -- pra lembrar no backup seria um lugar a mais pra esquecer.
  CREATE TABLE IF NOT EXISTS images (
    id         TEXT PRIMARY KEY,
    mime       TEXT NOT NULL,
    bytes      BLOB NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id),
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

  -- Anexos do chat. Só os METADADOS ficam aqui; os bytes vão pra
  -- config.filesDir, um arquivo por id. Ver o comentário do filesDir.
  --
  -- message_id nasce NULL: o upload acontece antes de a mensagem existir,
  -- porque é ele que demora e é ele que pode falhar. Quem sobe e desiste de
  -- mandar deixa um órfão, e a faxina recolhe (ver arquivos.ts).
  CREATE TABLE IF NOT EXISTS attachments (
    id         TEXT PRIMARY KEY,
    message_id INTEGER REFERENCES messages(id),
    user_id    TEXT NOT NULL REFERENCES users(id),
    name       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    size       INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
  -- A faxina varre em ordem de idade, e os órfãos são procurados por
  -- message_id IS NULL: os dois passam por aqui.
  CREATE INDEX IF NOT EXISTS idx_attachments_created ON attachments(created_at);

  -- Enquete: uma mensagem com um lado, o mesmo desenho do anexo.
  --
  -- Diferente dele num ponto: message_id nasce PREENCHIDO e NOT NULL. O
  -- anexo sobe antes da mensagem porque é ele que demora e é ele que pode
  -- falhar; uma enquete são três strings, então nasce junto, na mesma
  -- transação. Não há órfão esperando faxina.
  --
  -- A coluna options é JSON num TEXT, e não uma tabela poll_options. As
  -- opções são imutáveis depois de criadas e sempre lidas inteiras —
  -- normalizar traria um JOIN por enquete pra sustentar um UPDATE que
  -- nunca acontece.
  CREATE TABLE IF NOT EXISTS polls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id),
    question   TEXT NOT NULL,
    options    TEXT NOT NULL,
    multi      INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_polls_message ON polls(message_id);

  -- A CHAVE PRIMÁRIA COMPOSTA é quem impede votar duas vezes na mesma
  -- opção — não há uma linha de lógica no Node pra isso, e é de propósito:
  -- uma regra que o banco garante não tem como ser esquecida num caminho
  -- de código novo.
  CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id      INTEGER NOT NULL REFERENCES polls(id),
    user_id      TEXT    NOT NULL REFERENCES users(id),
    option_index INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (poll_id, user_id, option_index)
  );

  CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id);

  -- Reações. A CHAVE PRIMÁRIA COMPOSTA é o que impede a mesma pessoa reagir
  -- duas vezes com o mesmo emoji na mesma mensagem — pelo mesmo motivo do
  -- poll_votes: uma regra garantida pelo banco não tem como ser esquecida
  -- num caminho de código novo. Ela também é o que faz o toggle funcionar
  -- sem ler antes de escrever (ver toggleReaction).
  --
  -- O emoji é TEXT e não um índice numa tabela de emojis: a lista vive no
  -- config.ts, é fechada, e o servidor valida contra ela na entrada. Uma
  -- tabela de seis linhas imutáveis só traria um JOIN por reação.
  CREATE TABLE IF NOT EXISTS message_reactions (
    message_id INTEGER NOT NULL REFERENCES messages(id),
    user_id    TEXT    NOT NULL REFERENCES users(id),
    emoji      TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );

  CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);

  -- Quem foi mencionado em cada mensagem.
  --
  -- Resolvido no SERVIDOR na hora de gravar, e não relido do texto na hora
  -- de exibir: é isto que decide quem recebe notificação, e essa decisão
  -- não pode depender de cada cliente reinterpretar a frase do mesmo jeito.
  -- Um app numa versão mais velha continuaria notificando certo.
  --
  -- O "@todos" não tem linha própria: vira uma linha por pessoa (ver
  -- mencionadosEm). Assim o cliente pergunta sempre a mesma coisa — "meu id
  -- está aqui?" — em vez de ter um segundo caminho só pro caso do grupo.
  --
  -- (Sem crase neste comentário: ele mora dentro de um template literal, e
  -- uma crase aqui fecha a string no meio do schema.)
  CREATE TABLE IF NOT EXISTS message_mentions (
    message_id INTEGER NOT NULL REFERENCES messages(id),
    user_id    TEXT    NOT NULL REFERENCES users(id),
    PRIMARY KEY (message_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_mentions_message ON message_mentions(message_id);

  -- Até onde cada pessoa já leu o chat. Uma linha por pessoa, e não uma
  -- coluna em users: nasceu depois, e teria exigido a mesma migração de
  -- backfill de um jeito ou de outro.
  --
  -- Fica NO SERVIDOR de propósito — quem usa duas máquinas precisa ver a
  -- mesma marca de "não lida" nas duas, e isso não existe se o ponteiro
  -- morar só no disco local.
  CREATE TABLE IF NOT EXISTS message_reads (
    user_id               TEXT PRIMARY KEY REFERENCES users(id),
    last_read_message_id  INTEGER NOT NULL DEFAULT 0,
    updated_at            INTEGER NOT NULL
  );

  -- Os canais de voz. Antes era uma lista fixa no config.ts (canais fixos,
  -- nada de criar sala em runtime); virou tabela na 0.37 pra que o admin
  -- crie, renomeie e apague sem mexer no código.
  --
  -- O id e um slug mais um sufixo aleatorio e NUNCA muda: e o nome da sala
  -- no LiveKit e a chave da presenca. Renomear troca so o nome. A coluna
  -- position da a ordem na coluna da esquerda.
  --
  -- (Sem crase neste comentario: ele mora dentro de um template literal.)
  CREATE TABLE IF NOT EXISTS channels (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

/**
 * Semeia os dois canais que sempre existiram.
 *
 * Roda quando a tabela está vazia — banco novo, ou banco antigo que ganhou a
 * tabela agora. Os ids `sala-1`/`sala-2` são os mesmos de quando eram fixos
 * no config: quem estava numa call na hora do deploy não é derrubado, e o
 * histórico de presença continua batendo.
 */
if ((db.prepare('SELECT COUNT(*) AS n FROM channels').get() as { n: number }).n === 0) {
  const agora = Date.now();
  const ins = db.prepare(
    'INSERT INTO channels (id, name, position, created_at) VALUES (?, ?, ?, ?)',
  );
  db.transaction(() => {
    ins.run('sala-1', 'Sala 1', 0, agora);
    ins.run('sala-2', 'Sala 2', 1, agora);
  })();
}

/**
 * Backfill de quem já tinha conversa: sem isto, todo mundo abriria esta
 * versão vendo o histórico INTEIRO marcado como não lido, porque a tabela
 * nasce vazia. Roda uma vez só — na próxima abertura do servidor a tabela
 * já existe, e `messageReadsEraNova` dá false.
 *
 * Gente que se junta DEPOIS desta versão não passa por aqui, e é assim que
 * tem que ser: pra ela, o histórico inteiro é mesmo novidade.
 */
if (messageReadsEraNova) {
  const maxId = (
    db.prepare('SELECT COALESCE(MAX(id), 0) AS max FROM messages').get() as { max: number }
  ).max;
  if (maxId > 0) {
    const agora = Date.now();
    const usuarios = db.prepare('SELECT id FROM users').all() as { id: string }[];
    const marcar = db.prepare(
      'INSERT OR IGNORE INTO message_reads (user_id, last_read_message_id, updated_at) VALUES (?, ?, ?)',
    );
    db.transaction(() => {
      for (const u of usuarios) marcar.run(u.id, maxId, agora);
    })();
  }
}

/**
 * Colunas que nasceram depois do primeiro banco.
 *
 * CREATE TABLE IF NOT EXISTS não mexe em tabela que já existe, então um banco
 * antigo nunca veria estes campos. Perguntamos ao pragma antes de alterar em
 * vez de engolir o erro do ALTER — engolir esconderia falha de verdade junto.
 */
function garantirColunas(tabela: string, colunas: readonly (readonly [string, string])[]): void {
  const existentes = new Set(
    (db.pragma(`table_info(${tabela})`) as { name: string }[]).map((c) => c.name),
  );
  for (const [name, decl] of colunas) {
    if (!existentes.has(name)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${name} ${decl}`);
  }
}

garantirColunas('users', [
  ['banner_url', 'TEXT'],
  ['bio', 'TEXT'],
  ['status_text', 'TEXT'],
  // A foto do Google fica guardada à parte pra que "remover foto" tenha pra
  // onde voltar depois que a pessoa subiu uma própria.
  ['google_avatar_url', 'TEXT'],
  ['avatar_custom', 'INTEGER NOT NULL DEFAULT 0'],
  // Mesmo esquema do avatar_custom: sem isto, o próximo login pelo Google
  // reescreveria o apelido escolhido de volta pro nome da conta Google.
  ['name_custom', 'INTEGER NOT NULL DEFAULT 0'],
  // Presença. `status` é a ESCOLHA da pessoa; o que os outros veem sai de
  // combinar isso com os dois carimbos de tempo (ver statusEfetivo).
  ['status', "TEXT NOT NULL DEFAULT 'disponivel'"],
  // last_seen: último sinal de vida do app aberto — sem isto, "offline".
  // last_active: última vez que a pessoa FALOU. É o relógio dos 5 minutos.
  ['last_seen', 'INTEGER'],
  ['last_active', 'INTEGER'],
  // Tempo acumulado dentro de sala de voz, em ms. Quem soma é o ticker do
  // tempo.ts, a partir do que o LiveKit responde — nunca o cliente.
  ['voice_ms', 'INTEGER NOT NULL DEFAULT 0'],
  // Enfeite de perfil que os OUTROS veem, ao contrário do tema (que é
  // preferência de máquina e nem chega aqui). Um dos ids de EFEITOS.
  ['profile_effect', "TEXT NOT NULL DEFAULT 'nenhum'"],
] as const);

garantirColunas('messages', [
  // Quando foi editada. NULL = nunca foi, e é isso que decide o "(editado)".
  ['edited_at', 'INTEGER'],
  /**
   * Quando foi apagada. NULL = viva.
   *
   * Lápide, não DELETE: a linha continua existindo porque outras apontam pra
   * ela — uma resposta cita esta mensagem, e uma enquete é filha dela. Apagar
   * de verdade deixaria a resposta apontando pro vazio, sem nada que a
   * consertasse depois. Quem esvazia o conteúdo é o montarMensagens.
   */
  ['deleted_at', 'INTEGER'],
  // A mensagem que esta responde. NULL = não é resposta.
  ['reply_to_id', 'INTEGER REFERENCES messages(id)'],
] as const);

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  created_at: number;
  banner_url: string | null;
  bio: string | null;
  status_text: string | null;
  google_avatar_url: string | null;
  /** 1 depois que a pessoa sobe a própria foto — ver upsertUser. */
  avatar_custom: number;
  /** 1 depois que a pessoa escolhe um apelido — ver upsertUser. */
  name_custom: number;
  /** O que a pessoa escolheu no seletor, não o que os outros veem. */
  status: StatusEscolhido;
  last_seen: number | null;
  last_active: number | null;
  /** Tempo acumulado em sala de voz, em ms. Somado pelo ticker do tempo.ts. */
  voice_ms: number;
  /** Id de um dos efeitos de perfil. 'nenhum' quando não escolheu. */
  profile_effect: string;
}

/** O que a pessoa pode escolher. 'invisivel' aparece como offline pros outros. */
export type StatusEscolhido = 'disponivel' | 'ausente' | 'invisivel';

/** O que os outros veem. Nunca 'invisivel': quem se esconde vira offline. */
export type StatusEfetivo = 'disponivel' | 'ausente' | 'offline';

export interface ImageRow {
  mime: string;
  bytes: Buffer;
}

/**
 * Como o chat desenha o anexo. Decidido no upload, a partir do mime.
 *
 * 'image' aparece na conversa e amplia no clique, 'audio' e 'video' ganham
 * player, 'file' vira um cartão pra baixar. Guardado em vez de deduzido na
 * hora de desenhar porque a regra pode mudar, e o que já foi mandado deve
 * continuar aparecendo do jeito que apareceu quando foi mandado — é por isso
 * que vídeo enviado antes desta versão segue sendo cartão de download.
 */
export type AttachmentKind = 'image' | 'audio' | 'video' | 'file';

/** O que o cliente precisa saber de um anexo pra desenhá-lo. */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
}

/**
 * Uma opção da enquete, já com a apuração feita.
 *
 * `voters` traz os ids em vez de só a contagem porque quem votou APARECE.
 * São seis pessoas: esconder quem votou aqui seria atrito, não privacidade
 * — e o número sozinho não deixaria ninguém cobrar o voto de quem faltou.
 */
export interface PollOption {
  text: string;
  voters: string[];
}

export interface Poll {
  id: number;
  question: string;
  /** Verdadeiro quando dá pra marcar mais de uma opção. */
  multi: boolean;
  options: PollOption[];
}

/**
 * Uma reação, já agrupada por emoji.
 *
 * `users` traz os ids, e não só a contagem — mesma escolha do PollOption:
 * são seis pessoas, e quem reagiu aparece no tooltip. É também o que deixa
 * o cliente saber se VOCÊ reagiu sem uma segunda consulta.
 */
export interface Reaction {
  emoji: string;
  users: string[];
}

/**
 * O pedacinho da mensagem que está sendo respondida.
 *
 * Recalculado a cada leitura, nunca congelado no envio: assim editar ou
 * apagar a original reflete em toda resposta que aponta pra ela. Congelar o
 * texto no momento do envio deixaria uma citação dizendo o que a mensagem
 * NÃO diz mais — e sem nada que a corrigisse.
 */
export interface ReplyPreview {
  id: number;
  author_name: string;
  /** Já resolvido: o corpo, a pergunta da enquete, "anexo" ou a lápide. */
  snippet: string;
}

export interface MessageRow {
  id: number;
  body: string;
  created_at: number;
  user_id: string;
  author_name: string;
  author_avatar: string | null;
  attachments: Attachment[];
  poll: Poll | null;
  reactions: Reaction[];
  /**
   * Ids de quem foi mencionado. Resolvido na gravação, nunca relido do
   * texto na exibição — ver a tabela message_mentions.
   */
  mentions: string[];
  /** Quando foi editada, ou null. O cliente desenha "(editado)". */
  edited_at: number | null;
  /** Lápide: o conteúdo já vem vazio, e o cliente desenha "mensagem removida". */
  deleted: boolean;
  reply_to: ReplyPreview | null;
}

/** A enquete como ela chega pra ser criada, antes de existir no banco. */
export interface NovaPoll {
  question: string;
  options: string[];
  multi: boolean;
}

interface PollRow {
  id: number;
  message_id: number;
  question: string;
  options: string;
  multi: number;
  created_at: number;
}

interface VoteRow {
  poll_id: number;
  user_id: string;
  option_index: number;
}

interface ReactionRow {
  message_id: number;
  user_id: string;
  emoji: string;
}

/**
 * A linha crua da mensagem, com a original da resposta pendurada.
 *
 * Os campos `reply_*` vêm do LEFT JOIN e são todos null quando a mensagem
 * não responde ninguém. Quem os transforma em ReplyPreview é o
 * resolverCitacao — aqui eles ainda são as colunas do banco.
 */
interface MensagemBruta {
  id: number;
  body: string;
  created_at: number;
  user_id: string;
  edited_at: number | null;
  deleted_at: number | null;
  reply_to_id: number | null;
  author_name: string;
  author_avatar: string | null;
  reply_deleted: number | null;
  reply_body: string | null;
  reply_author: string | null;
  reply_question: string | null;
  reply_tem_anexo: number | null;
}

/**
 * A projeção de uma mensagem, escrita UMA vez.
 *
 * Fica em constante porque duas consultas a usam — a lista e a de uma
 * mensagem só —, e elas precisam devolver exatamente as mesmas colunas. Uma
 * projeção copiada é uma projeção que vai divergir na próxima coluna nova, e
 * o sintoma seria a mensagem recém-enviada aparecer diferente da mesma
 * mensagem três segundos depois.
 *
 * A pergunta da enquete entra por subconsulta porque uma mensagem de enquete
 * tem `body` vazio: sem ela, responder a uma enquete citaria "anexo".
 */
const COLUNAS_MENSAGEM = `
  m.id, m.body, m.created_at, m.user_id,
  m.edited_at, m.deleted_at, m.reply_to_id,
  u.name AS author_name, u.avatar_url AS author_avatar,
  r.deleted_at AS reply_deleted,
  r.body       AS reply_body,
  ru.name      AS reply_author,
  (SELECT question FROM polls WHERE message_id = r.id) AS reply_question,
  EXISTS (SELECT 1 FROM attachments WHERE message_id = r.id) AS reply_tem_anexo
`;

const JOINS_MENSAGEM = `
  FROM messages m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN messages r  ON r.id = m.reply_to_id
  LEFT JOIN users    ru ON ru.id = r.user_id
`;

const stmts = {
  findByEmail: db.prepare<[string]>('SELECT * FROM users WHERE email = ?'),
  findById: db.prepare<[string]>('SELECT * FROM users WHERE id = ?'),
  insertUser: db.prepare(`
    INSERT INTO users (id, email, name, avatar_url, google_avatar_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  // O avatar só é sobrescrito pelo do Google enquanto avatar_custom for 0.
  // Sem essa condição, todo login devolveria a foto do Google e a pessoa
  // perderia a que escolheu — uma vez por reinício do app.
  updateFromGoogle: db.prepare(`
    UPDATE users
       SET name = CASE WHEN name_custom = 1 THEN name ELSE ? END,
           google_avatar_url = ?,
           avatar_url = CASE WHEN avatar_custom = 1 THEN avatar_url ELSE ? END
     WHERE id = ?
  `),
  updateAvatar: db.prepare(
    'UPDATE users SET avatar_url = ?, avatar_custom = ? WHERE id = ?',
  ),
  updateBanner: db.prepare('UPDATE users SET banner_url = ? WHERE id = ?'),
  updateBio: db.prepare('UPDATE users SET bio = ? WHERE id = ?'),
  updateStatusText: db.prepare('UPDATE users SET status_text = ? WHERE id = ?'),
  updateName: db.prepare('UPDATE users SET name = ?, name_custom = 1 WHERE id = ?'),
  updateStatus: db.prepare('UPDATE users SET status = ? WHERE id = ?'),
  updateEffect: db.prepare('UPDATE users SET profile_effect = ? WHERE id = ?'),
  // Soma em vez de escrever: dois ticks nunca disputam o mesmo valor lido,
  // e um tick perdido custa 30s, não o acumulado inteiro.
  addVoiceMs: db.prepare('UPDATE users SET voice_ms = voice_ms + ? WHERE id = ?'),
  touchSeen: db.prepare('UPDATE users SET last_seen = ? WHERE id = ?'),
  touchAtivo: db.prepare('UPDATE users SET last_seen = ?, last_active = ? WHERE id = ?'),
  todos: db.prepare('SELECT * FROM users'),
  insertImage: db.prepare(
    'INSERT INTO images (id, mime, bytes, created_at) VALUES (?, ?, ?, ?)',
  ),
  findImage: db.prepare<[string]>('SELECT mime, bytes FROM images WHERE id = ?'),
  deleteImage: db.prepare<[string]>('DELETE FROM images WHERE id = ?'),
  insertMessage: db.prepare(
    'INSERT INTO messages (user_id, body, created_at, reply_to_id) VALUES (?, ?, ?, ?)',
  ),
  recentMessages: db.prepare<[number]>(
    `SELECT ${COLUNAS_MENSAGEM} ${JOINS_MENSAGEM} ORDER BY m.id DESC LIMIT ?`,
  ),
  // A MESMA projeção da lista, para uma mensagem só. É o que garante que a
  // mensagem devolvida no POST (o caminho rápido do data channel) seja igual
  // à que o polling traz três segundos depois — duas montagens diferentes
  // seriam duas chances de discordarem.
  messageById: db.prepare<[number]>(
    `SELECT ${COLUNAS_MENSAGEM} ${JOINS_MENSAGEM} WHERE m.id = ?`,
  ),
  // Só o que decide permissão e estado, sem os JOINs da projeção completa.
  messageOwner: db.prepare<[number]>(
    'SELECT id, user_id, deleted_at FROM messages WHERE id = ?',
  ),
  updateMessageBody: db.prepare<[string, number, number]>(
    'UPDATE messages SET body = ?, edited_at = ? WHERE id = ?',
  ),
  tombstoneMessage: db.prepare<[number, number]>(
    'UPDATE messages SET deleted_at = ? WHERE id = ?',
  ),
  attachmentsOfMessage: db.prepare<[number]>(
    'SELECT * FROM attachments WHERE message_id = ?',
  ),

  // --- Reações -----------------------------------------------------------
  // Mesmo desenho em lote dos anexos e das enquetes: uma consulta só para as
  // reações de todas as mensagens que o recentMessages devolve.
  reactionsForRecent: db.prepare<[number]>(`
    SELECT message_id, user_id, emoji FROM message_reactions
     WHERE message_id IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)
     ORDER BY created_at ASC
  `),
  reactionsOfMessage: db.prepare<[number]>(
    'SELECT message_id, user_id, emoji FROM message_reactions WHERE message_id = ? ORDER BY created_at ASC',
  ),
  deleteReaction: db.prepare<[number, string, string]>(
    'DELETE FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
  ),
  insertReaction: db.prepare(
    'INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
  ),

  // --- Remover de vez ----------------------------------------------------
  // As chaves estrangeiras estao DECLARADAS mas nao sao aplicadas: o SQLite
  // so as respeita com `PRAGMA foreign_keys = ON`, que nao ligamos. Ou seja,
  // apagar a linha da mensagem nao falharia — ela so deixaria voto, enquete
  // e reacao pendurados num id que nao existe mais, pra sempre. Por isso a
  // limpeza e explicita, e nas dependencias antes da mensagem.
  deletePollVotesOfMessage: db.prepare<[number]>(
    'DELETE FROM poll_votes WHERE poll_id IN (SELECT id FROM polls WHERE message_id = ?)',
  ),
  deletePollsOfMessage: db.prepare<[number]>('DELETE FROM polls WHERE message_id = ?'),
  deleteReactionsOfMessage: db.prepare<[number]>(
    'DELETE FROM message_reactions WHERE message_id = ?',
  ),
  clearRepliesTo: db.prepare<[number]>(
    'UPDATE messages SET reply_to_id = NULL WHERE reply_to_id = ?',
  ),
  deleteMessageRow: db.prepare<[number]>('DELETE FROM messages WHERE id = ?'),

  // --- Menções -----------------------------------------------------------
  mentionsForRecent: db.prepare<[number]>(`
    SELECT message_id, user_id FROM message_mentions
     WHERE message_id IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)
  `),
  mentionsOfMessage: db.prepare<[number]>(
    'SELECT message_id, user_id FROM message_mentions WHERE message_id = ?',
  ),
  insertMention: db.prepare<[number, string]>(
    'INSERT OR IGNORE INTO message_mentions (message_id, user_id) VALUES (?, ?)',
  ),
  deleteMentionsOfMessage: db.prepare<[number]>(
    'DELETE FROM message_mentions WHERE message_id = ?',
  ),

  // --- Anexos ------------------------------------------------------------
  insertAttachment: db.prepare(`
    INSERT INTO attachments (id, message_id, user_id, name, mime, size, kind, created_at)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?)
  `),
  findAttachment: db.prepare<[string]>('SELECT * FROM attachments WHERE id = ?'),
  // A condição toda importa: só o dono, e só enquanto ainda for órfão. Sem
  // ela, mandar o id de um anexo de outra pessoa numa mensagem sua roubaria
  // o arquivo dela pro seu balão.
  attachToMessage: db.prepare(`
    UPDATE attachments
       SET message_id = ?
     WHERE id = ? AND user_id = ? AND message_id IS NULL
  `),
  // Os anexos das mesmas mensagens que o recentMessages devolve. Uma
  // consulta só, com o mesmo LIMIT, em vez de um IN montado com N
  // interrogações (que viraria um prepared statement diferente por N).
  attachmentsForRecent: db.prepare<[number]>(`
    SELECT * FROM attachments
     WHERE message_id IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)
  `),
  totalAttachmentBytes: db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM attachments'),
  // Mais velhos primeiro: é a ordem em que a faxina apaga ao estourar o teto.
  oldestAttachments: db.prepare<[number]>(
    'SELECT * FROM attachments ORDER BY created_at ASC LIMIT ?',
  ),
  // Subiu e nunca mandou a mensagem. `created_at` é o único relógio que
  // existe pra eles, já que message_id nunca chegou.
  orphanAttachments: db.prepare<[number]>(
    'SELECT * FROM attachments WHERE message_id IS NULL AND created_at < ?',
  ),
  deleteAttachment: db.prepare<[string]>('DELETE FROM attachments WHERE id = ?'),

  // --- Enquetes ----------------------------------------------------------
  insertPoll: db.prepare(`
    INSERT INTO polls (message_id, question, options, multi, created_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  findPollRow: db.prepare<[number]>('SELECT * FROM polls WHERE id = ?'),
  pollByMessage: db.prepare<[number]>('SELECT * FROM polls WHERE message_id = ?'),
  // Mesma ideia do attachmentsForRecent: as enquetes das mesmas mensagens
  // que o recentMessages devolve, numa consulta só. Sem isto, abrir o chat
  // com cem mensagens viraria cem consultas de apuração.
  pollsForRecent: db.prepare<[number]>(`
    SELECT * FROM polls
     WHERE message_id IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)
  `),
  votesForRecent: db.prepare<[number]>(`
    SELECT poll_id, user_id, option_index FROM poll_votes
     WHERE poll_id IN (
       SELECT id FROM polls
        WHERE message_id IN (SELECT id FROM messages ORDER BY id DESC LIMIT ?)
     )
  `),
  votesForPoll: db.prepare<[number]>(
    'SELECT poll_id, user_id, option_index FROM poll_votes WHERE poll_id = ?',
  ),
  clearVote: db.prepare<[number, string]>(
    'DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?',
  ),
  insertVote: db.prepare(
    'INSERT INTO poll_votes (poll_id, user_id, option_index, created_at) VALUES (?, ?, ?, ?)',
  ),

  // --- Não lida ------------------------------------------------------------
  getLastRead: db.prepare<[string]>(
    'SELECT last_read_message_id FROM message_reads WHERE user_id = ?',
  ),
  // MAX no UPDATE é o que impede o ponteiro de ANDAR PRA TRÁS: as duas
  // máquinas mandam a maior mensagem que cada uma viu na hora, e chegar fora
  // de ordem (a mais velha depois da mais nova) não pode apagar o progresso
  // que a outra já tinha marcado.
  setLastRead: db.prepare(`
    INSERT INTO message_reads (user_id, last_read_message_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id),
      updated_at = excluded.updated_at
  `),
};

/**
 * Junta a linha da enquete com os votos dela.
 *
 * Os votos chegam de fora em vez de serem buscados aqui porque quem chama
 * em lote (o recentMessages) já os tem todos na mão — buscar por enquete
 * desfaria exatamente a consulta em lote que existe pra evitar isso.
 */
function montarPoll(row: PollRow, votos: VoteRow[]): Poll {
  const textos = JSON.parse(row.options) as string[];
  const options: PollOption[] = textos.map((text) => ({ text, voters: [] }));
  for (const v of votos) {
    // Índice fora da lista não deveria existir (as opções são imutáveis),
    // mas ler undefined aqui derrubaria a montagem do chat INTEIRO por
    // causa de uma linha estranha. O `?.` custa nada e contém o estrago.
    options[v.option_index]?.voters.push(v.user_id);
  }
  return {
    id: row.id,
    question: row.question,
    multi: row.multi === 1,
    options,
  };
}

export function findPoll(id: number): Poll | undefined {
  const row = stmts.findPollRow.get(id) as PollRow | undefined;
  if (!row) return undefined;
  return montarPoll(row, stmts.votesForPoll.all(id) as VoteRow[]);
}

export function pollForMessage(messageId: number): Poll | undefined {
  const row = stmts.pollByMessage.get(messageId) as PollRow | undefined;
  if (!row) return undefined;
  return montarPoll(row, stmts.votesForPoll.all(row.id) as VoteRow[]);
}

/**
 * Troca o voto da pessoa nesta enquete pelo conjunto que chegou.
 *
 * Apaga tudo e reinsere em vez de calcular a diferença: o conjunto que
 * chega É a resposta, e um DELETE mais N INSERTs é mais curto e mais fácil
 * de conferir que a diferença entre dois conjuntos. Lista vazia é voto
 * válido — é como se desmarca.
 *
 * Na transação porque trocar de opção passa por um instante sem voto
 * nenhum, e uma apuração lida nesse instante mostraria um voto a menos.
 */
export const setVote = db.transaction(
  (pollId: number, userId: string, indices: number[]): void => {
    stmts.clearVote.run(pollId, userId);
    const agora = Date.now();
    for (const i of indices) stmts.insertVote.run(pollId, userId, i, agora);
  },
);

export function findUserByEmail(email: string): User | undefined {
  return stmts.findByEmail.get(email) as User | undefined;
}

export function findUserById(id: string): User | undefined {
  return stmts.findById.get(id) as User | undefined;
}

export function upsertUser(u: {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}): User {
  const existing = findUserByEmail(u.email);
  if (existing) {
    stmts.updateFromGoogle.run(u.name, u.avatarUrl, u.avatarUrl, existing.id);
    return findUserById(existing.id)!;
  }
  stmts.insertUser.run(u.id, u.email, u.name, u.avatarUrl, u.avatarUrl, Date.now());
  return findUserById(u.id)!;
}

/** `custom` false = voltou pra foto do Google, e o próximo login pode mexer. */
export function setAvatar(userId: string, url: string | null, custom: boolean): User {
  stmts.updateAvatar.run(url, custom ? 1 : 0, userId);
  return findUserById(userId)!;
}

export function setBanner(userId: string, url: string | null): User {
  stmts.updateBanner.run(url, userId);
  return findUserById(userId)!;
}

export function patchProfile(
  userId: string,
  patch: { name?: string; bio?: string; statusText?: string; profileEffect?: string },
): User {
  if (patch.name !== undefined) stmts.updateName.run(patch.name, userId);
  if (patch.bio !== undefined) stmts.updateBio.run(patch.bio, userId);
  if (patch.statusText !== undefined) stmts.updateStatusText.run(patch.statusText, userId);
  if (patch.profileEffect !== undefined) stmts.updateEffect.run(patch.profileEffect, userId);
  return findUserById(userId)!;
}

/**
 * Soma tempo de call a várias pessoas de uma vez.
 *
 * Numa transação porque é um tick só: ou o minuto conta pra todo mundo que
 * estava na sala, ou não conta pra ninguém. Meio tick gravado seria uma
 * diferença que ninguém tem como perceber depois — e a soma é justamente o
 * tipo de número que só se descobre errado meses adiante.
 */
export const addVoiceTime = db.transaction((userIds: string[], ms: number): void => {
  for (const id of userIds) stmts.addVoiceMs.run(ms, id);
});

export function saveImage(id: string, mime: string, bytes: Buffer): void {
  stmts.insertImage.run(id, mime, bytes, Date.now());
}

export function loadImage(id: string): ImageRow | undefined {
  return stmts.findImage.get(id) as ImageRow | undefined;
}

export function deleteImage(id: string): void {
  stmts.deleteImage.run(id);
}

/** O registro inteiro do anexo — o que o servidor usa, não o que o chat vê. */
export interface AttachmentRecord extends Attachment {
  message_id: number | null;
  user_id: string;
  created_at: number;
}

export function saveAttachment(a: {
  id: string;
  userId: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
}): void {
  stmts.insertAttachment.run(a.id, a.userId, a.name, a.mime, a.size, a.kind, Date.now());
}

export function findAttachment(id: string): AttachmentRecord | undefined {
  return stmts.findAttachment.get(id) as AttachmentRecord | undefined;
}

export function deleteAttachmentRow(id: string): void {
  stmts.deleteAttachment.run(id);
}

export function totalAttachmentBytes(): number {
  return (stmts.totalAttachmentBytes.get() as { total: number }).total;
}

export function oldestAttachments(limit: number): AttachmentRecord[] {
  return stmts.oldestAttachments.all(limit) as AttachmentRecord[];
}

export function orphanAttachments(before: number): AttachmentRecord[] {
  return stmts.orphanAttachments.all(before) as AttachmentRecord[];
}

/**
 * Grava a mensagem e, se houver, amarra o anexo a ela — tudo ou nada.
 *
 * A transação existe porque as duas metades não fazem sentido sozinhas: uma
 * mensagem de anexo cujo anexo não amarrou é um balão vazio no chat de todo
 * mundo, e sem jeito de consertar depois. Se o UPDATE não pegar nenhuma
 * linha (anexo de outra pessoa, ou já usado em outra mensagem), o throw
 * desfaz o INSERT junto.
 */
const inserirMensagem = db.transaction(
  (
    userId: string,
    body: string,
    attachmentId: string | null,
    poll: NovaPoll | null,
    replyToId: number | null,
    mentions: string[],
  ): number => {
    const agora = Date.now();
    const info = stmts.insertMessage.run(userId, body, agora, replyToId);
    const id = Number(info.lastInsertRowid);
    // Na MESMA transação da mensagem, como a enquete: uma menção gravada
    // sem a mensagem não notificaria nada, e uma mensagem sem as menções
    // seria uma notificação que nunca aconteceu e ninguém iria procurar.
    for (const alvo of mentions) stmts.insertMention.run(id, alvo);
    if (attachmentId) {
      const r = stmts.attachToMessage.run(id, attachmentId, userId);
      if (r.changes === 0) throw new Error('anexo inválido');
    }
    // A enquete entra na MESMA transação, e é a razão de ela não precisar
    // de faxina: ou a mensagem e a enquete existem juntas, ou nenhuma das
    // duas existe. Uma enquete sem mensagem seria invisível pra sempre.
    if (poll) {
      stmts.insertPoll.run(
        id,
        poll.question,
        JSON.stringify(poll.options),
        poll.multi ? 1 : 0,
        agora,
      );
    }
    return id;
  },
);

export function saveMessage(
  userId: string,
  body: string,
  attachmentId: string | null = null,
  poll: NovaPoll | null = null,
  replyToId: number | null = null,
  mentions: string[] = [],
): number {
  return inserirMensagem(userId, body, attachmentId, poll, replyToId, mentions);
}

/** Quanto da mensagem original cabe no card de citação. */
const LIMITE_CITACAO = 80;

function encurtar(texto: string): string {
  const limpo = texto.replace(/\s+/g, ' ').trim();
  return limpo.length > LIMITE_CITACAO ? `${limpo.slice(0, LIMITE_CITACAO)}…` : limpo;
}

/**
 * O card de citação, resolvido a partir das colunas do LEFT JOIN.
 *
 * A ordem das perguntas é a ordem em que elas importam: uma mensagem apagada
 * não mostra o que dizia, mesmo que o texto ainda esteja na linha (é
 * justamente por isso que a lápide não apaga o registro). Depois vem o
 * corpo; depois a pergunta da enquete, que é o texto de uma mensagem cujo
 * body é vazio; e só então o anexo, que é o que sobra.
 */
function resolverCitacao(b: MensagemBruta): ReplyPreview | null {
  if (b.reply_to_id === null || b.reply_author === null) return null;

  const snippet = b.reply_deleted !== null
    ? 'mensagem removida'
    : b.reply_body?.trim()
      ? encurtar(b.reply_body)
      : b.reply_question?.trim()
        ? encurtar(b.reply_question)
        : b.reply_tem_anexo
          ? 'anexo'
          : 'mensagem';

  return { id: b.reply_to_id, author_name: b.reply_author, snippet };
}

function agruparReacoes(linhas: ReactionRow[]): Map<number, Reaction[]> {
  const porMensagem = new Map<number, Reaction[]>();
  for (const r of linhas) {
    let lista = porMensagem.get(r.message_id);
    if (!lista) porMensagem.set(r.message_id, (lista = []));
    // Agrupa por emoji preservando a ordem de chegada: o primeiro emoji usado
    // fica à esquerda, e a tirinha não dança a cada reação nova.
    const existente = lista.find((x) => x.emoji === r.emoji);
    if (existente) existente.users.push(r.user_id);
    else lista.push({ emoji: r.emoji, users: [r.user_id] });
  }
  return porMensagem;
}

/** Os lados de uma mensagem, buscados em lote por quem chama. */
interface Lados {
  attachments: Map<number, Attachment[]>;
  polls: Map<number, Poll>;
  reactions: Map<number, Reaction[]>;
  mentions: Map<number, string[]>;
}

function agruparMencoes(linhas: { message_id: number; user_id: string }[]): Map<number, string[]> {
  const porMensagem = new Map<number, string[]>();
  for (const m of linhas) {
    const lista = porMensagem.get(m.message_id);
    if (lista) lista.push(m.user_id);
    else porMensagem.set(m.message_id, [m.user_id]);
  }
  return porMensagem;
}

/**
 * A linha crua vira o que o cliente recebe.
 *
 * É AQUI que a lápide esvazia a mensagem, e num lugar só: o texto, os
 * anexos, a enquete e as reações somem todos juntos. Espalhar essa decisão
 * pelas rotas deixaria cada caminho novo com uma chance de esquecer um dos
 * quatro — e o esquecido seria a foto de uma mensagem apagada continuando na
 * tela de todo mundo.
 */
function montarMensagem(b: MensagemBruta, lados: Lados): MessageRow {
  const base = {
    id: b.id,
    created_at: b.created_at,
    user_id: b.user_id,
    author_name: b.author_name,
    author_avatar: b.author_avatar,
  };

  if (b.deleted_at !== null) {
    return {
      ...base,
      body: '',
      attachments: [],
      poll: null,
      reactions: [],
      mentions: [],
      edited_at: null,
      deleted: true,
      reply_to: null,
    };
  }

  return {
    ...base,
    body: b.body,
    attachments: lados.attachments.get(b.id) ?? [],
    poll: lados.polls.get(b.id) ?? null,
    reactions: lados.reactions.get(b.id) ?? [],
    mentions: lados.mentions.get(b.id) ?? [],
    edited_at: b.edited_at,
    deleted: false,
    reply_to: resolverCitacao(b),
  };
}

/**
 * Uma mensagem só, montada exatamente como a lista a montaria.
 *
 * Serve a resposta do POST, que é o que viaja pelo data channel. Chamar a
 * mesma montagem é o que impede o balão recém-enviado de aparecer diferente
 * do mesmo balão relido três segundos depois pelo polling.
 */
export function messageById(id: number): MessageRow | undefined {
  const bruta = stmts.messageById.get(id) as MensagemBruta | undefined;
  if (!bruta) return undefined;

  const anexos = stmts.attachmentsOfMessage.all(id) as AttachmentRecord[];
  const poll = pollForMessage(id);

  return montarMensagem(bruta, {
    attachments: new Map(anexos.length > 0 ? [[id, anexos.map(paraAnexo)]] : []),
    polls: new Map(poll ? [[id, poll]] : []),
    reactions: agruparReacoes(stmts.reactionsOfMessage.all(id) as ReactionRow[]),
    mentions: agruparMencoes(
      stmts.mentionsOfMessage.all(id) as { message_id: number; user_id: string }[],
    ),
  });
}

/** Só os campos que o cliente vê — o registro tem user_id e message_id a mais. */
const paraAnexo = (a: AttachmentRecord): Attachment => ({
  id: a.id, name: a.name, mime: a.mime, size: a.size, kind: a.kind,
});

export function recentMessages(limit = 100): MessageRow[] {
  const brutas = (stmts.recentMessages.all(limit) as MensagemBruta[]).reverse();

  // Os anexos vêm numa segunda consulta e são distribuídos aqui. Um JOIN
  // duplicaria a mensagem por anexo, e desduplicar depois custa mais que
  // este mapa.
  const porMensagem = new Map<number, Attachment[]>();
  for (const a of stmts.attachmentsForRecent.all(limit) as AttachmentRecord[]) {
    if (a.message_id === null) continue;
    const lista = porMensagem.get(a.message_id);
    if (lista) lista.push(paraAnexo(a));
    else porMensagem.set(a.message_id, [paraAnexo(a)]);
  }

  // As enquetes seguem o mesmo caminho, por duas consultas em lote: as
  // linhas e os votos de todas elas. A segunda só sai se houver alguma —
  // no uso normal a maioria das aberturas do chat não tem enquete nenhuma
  // nas últimas cem mensagens, e essa consulta seria puro desperdício.
  const porMensagemPoll = new Map<number, Poll>();
  const linhasPoll = stmts.pollsForRecent.all(limit) as PollRow[];
  if (linhasPoll.length > 0) {
    const votosPorPoll = new Map<number, VoteRow[]>();
    for (const v of stmts.votesForRecent.all(limit) as VoteRow[]) {
      const lista = votosPorPoll.get(v.poll_id);
      if (lista) lista.push(v);
      else votosPorPoll.set(v.poll_id, [v]);
    }
    for (const row of linhasPoll) {
      porMensagemPoll.set(row.message_id, montarPoll(row, votosPorPoll.get(row.id) ?? []));
    }
  }

  // As reações também em lote, pelo mesmo motivo. Sem chave para pular
  // quando não há nenhuma: ao contrário das enquetes, reação é barata e
  // frequente, e a consulta volta vazia sem custo.
  const porMensagemReacao = agruparReacoes(
    stmts.reactionsForRecent.all(limit) as ReactionRow[],
  );

  const lados: Lados = {
    attachments: porMensagem,
    polls: porMensagemPoll,
    reactions: porMensagemReacao,
    mentions: agruparMencoes(
      stmts.mentionsForRecent.all(limit) as { message_id: number; user_id: string }[],
    ),
  };
  return brutas.map((b) => montarMensagem(b, lados));
}

// --- Editar, apagar e reagir ---------------------------------------------
/** O mínimo pra decidir permissão: de quem é, e se já foi apagada. */
export interface MessageOwner {
  id: number;
  user_id: string;
  deleted_at: number | null;
}

export function messageOwner(id: number): MessageOwner | undefined {
  return stmts.messageOwner.get(id) as MessageOwner | undefined;
}

/**
 * Edita o texto e REFAZ as menções.
 *
 * Numa transação porque as duas metades são a mesma edição: se o texto
 * novo passasse a valer com a lista de menções do texto velho, alguém
 * continuaria marcado por uma frase que não existe mais — e quem foi
 * adicionado no meio nunca seria notificado.
 */
export const editMessage = db.transaction(
  (id: number, body: string, mentions: string[]): void => {
    stmts.updateMessageBody.run(body, Date.now(), id);
    stmts.deleteMentionsOfMessage.run(id);
    for (const userId of mentions) stmts.insertMention.run(id, userId);
  },
);

/**
 * Vira lápide e entrega os anexos que ficaram sem dono.
 *
 * Devolve os ids em vez de apagar os bytes aqui porque quem sabe onde os
 * bytes moram é o arquivos.ts — o banco guarda só metadado (ver o comentário
 * do filesDir). Quem chama passa a lista pra lá.
 *
 * Sem isso os bytes ficariam órfãos de um jeito que NADA recolhe: a faxina
 * procura anexo com message_id NULL, e o desta mensagem continua apontando
 * pra ela. Um vídeo de 200 MB de uma mensagem apagada moraria no disco pra
 * sempre.
 */
export const deleteMessage = db.transaction((id: number): string[] => {
  stmts.tombstoneMessage.run(Date.now(), id);
  const anexos = stmts.attachmentsOfMessage.all(id) as AttachmentRecord[];
  return anexos.map((a) => a.id);
});

/**
 * Some com a mensagem de vez: a linha vai embora, e tudo que pendurava nela.
 *
 * O segundo estágio de apagar. O primeiro (lápide) existe porque outras
 * linhas apontam pra esta; este só roda depois, quando a pessoa decide que
 * nem o "mensagem removida" deve continuar na conversa.
 *
 * A ordem importa: as dependências saem ANTES da mensagem. E o
 * `clearRepliesTo` é o que impede o pior caso — uma resposta com
 * `reply_to_id` apontando pra um id que não existe mais. O LEFT JOIN da
 * projeção até aguenta (a citação vira null e some da tela, que é o
 * comportamento combinado), mas deixar a referência pendurada seria confiar
 * nisso pra sempre, inclusive numa consulta futura que não use LEFT JOIN.
 *
 * Devolve os anexos que sobraram, pra quem chama passar ao arquivos.ts —
 * mesma divisão do deleteMessage, porque quem sabe onde os bytes moram é
 * ele. Normalmente é lista vazia: a lápide já levou os bytes. É cinto e
 * suspensório pra uma linha que tenha virado lápide por um caminho anterior
 * a esta versão.
 */
export const purgeMessage = db.transaction((id: number): string[] => {
  const anexos = stmts.attachmentsOfMessage.all(id) as AttachmentRecord[];

  stmts.deletePollVotesOfMessage.run(id);
  stmts.deletePollsOfMessage.run(id);
  stmts.deleteReactionsOfMessage.run(id);
  stmts.deleteMentionsOfMessage.run(id);
  stmts.clearRepliesTo.run(id);
  stmts.deleteMessageRow.run(id);

  return anexos.map((a) => a.id);
});

/**
 * Liga ou desliga uma reação, sem ler antes de escrever.
 *
 * O DELETE volta com `changes` 0 quando não havia nada pra tirar — e é
 * exatamente aí que a reação entra. Ler primeiro e decidir depois abriria
 * uma janela entre a leitura e a escrita; aqui as duas metades são a mesma
 * transação, e a chave composta recusaria a duplicata de qualquer jeito.
 *
 * Devolve true quando a reação passou a existir.
 */
export const toggleReaction = db.transaction(
  (messageId: number, userId: string, emoji: string): boolean => {
    const r = stmts.deleteReaction.run(messageId, userId, emoji);
    if (r.changes > 0) return false;
    stmts.insertReaction.run(messageId, userId, emoji, Date.now());
    return true;
  },
);

/**
 * Presença — os dois relógios.
 *
 * `last_seen` é o app aberto: o cliente bate de tempos em tempos, e parar de
 * bater é o que vira offline. `last_active` é a última vez que a pessoa
 * estava com o MICROFONE ABERTO, e é ele que conta os 10 minutos de
 * ausência. São separados porque quem está com o app aberto e mudo não é a
 * mesma coisa que quem fechou.
 */
export function touchPresence(userId: string, ativo: boolean): void {
  const agora = Date.now();
  if (ativo) stmts.touchAtivo.run(agora, agora, userId);
  else stmts.touchSeen.run(agora, userId);
}

export function setStatus(userId: string, status: StatusEscolhido): User {
  stmts.updateStatus.run(status, userId);
  return findUserById(userId)!;
}

export function allUsers(): User[] {
  return stmts.todos.all() as User[];
}

/** 0 = nunca leu nada — o histórico inteiro aparece como não lido. */
export function lastReadMessageId(userId: string): number {
  const row = stmts.getLastRead.get(userId) as { last_read_message_id: number } | undefined;
  return row?.last_read_message_id ?? 0;
}

/** Devolve o ponteiro já resolvido — pode não ser `messageId` se outra máquina leu mais longe. */
export function markRead(userId: string, messageId: number): number {
  stmts.setLastRead.run(userId, messageId, Date.now());
  return lastReadMessageId(userId);
}

// --- Canais de voz ------------------------------------------------------
/** O que o cliente vê de um canal — o resto (position, created_at) é interno. */
export interface Channel {
  id: string;
  name: string;
}

const canalStmts = {
  list: db.prepare('SELECT id, name FROM channels ORDER BY position, created_at'),
  exists: db.prepare<[string]>('SELECT 1 FROM channels WHERE id = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM channels'),
  nextPos: db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM channels'),
  insert: db.prepare(
    'INSERT INTO channels (id, name, position, created_at) VALUES (?, ?, ?, ?)',
  ),
  rename: db.prepare<[string, string]>('UPDATE channels SET name = ? WHERE id = ?'),
  remove: db.prepare<[string]>('DELETE FROM channels WHERE id = ?'),
};

export function listChannels(): Channel[] {
  return canalStmts.list.all() as Channel[];
}

export function channelExists(id: string): boolean {
  return canalStmts.exists.get(id) !== undefined;
}

export function channelCount(): number {
  return (canalStmts.count.get() as { n: number }).n;
}

/**
 * Um slug legível a partir do nome — sem acento, só letra/número e hífen.
 *
 * Vira só o começo do id; o sufixo aleatório é quem garante a unicidade.
 * Nome sem nenhum caractere aproveitável (só emoji, por ex.) cai em 'canal'.
 */
function slugificar(nome: string): string {
  const s = nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira os acentos que o NFD separou
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return s || 'canal';
}

/**
 * Cria um canal e devolve {id, name}.
 *
 * O id é slug + 4 hex e é definitivo: renomear depois mexe só no `name`.
 * O loop de colisão quase nunca roda — 16 bits de sufixo pra um punhado de
 * canais —, mas conferir é barato e o PRIMARY KEY não perdoa.
 */
export function createChannel(name: string): Channel {
  const base = slugificar(name);
  let id = `${base}-${randomBytes(2).toString('hex')}`;
  while (channelExists(id)) id = `${base}-${randomBytes(2).toString('hex')}`;

  const position = (canalStmts.nextPos.get() as { p: number }).p;
  canalStmts.insert.run(id, name, position, Date.now());
  return { id, name };
}

/** Renomeia. undefined = não existe canal com esse id. */
export function renameChannel(id: string, name: string): Channel | undefined {
  return canalStmts.rename.run(name, id).changes > 0 ? { id, name } : undefined;
}

/** Apaga. false = não havia nada pra apagar. Não mexe em quem está na sala do LiveKit. */
export function deleteChannel(id: string): boolean {
  return canalStmts.remove.run(id).changes > 0;
}
