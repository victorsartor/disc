import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

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
`);

/**
 * Colunas que nasceram depois do primeiro banco.
 *
 * CREATE TABLE IF NOT EXISTS não mexe em tabela que já existe, então um banco
 * antigo nunca veria estes campos. Perguntamos ao pragma antes de alterar em
 * vez de engolir o erro do ALTER — engolir esconderia falha de verdade junto.
 */
const userColumns = new Set(
  (db.pragma('table_info(users)') as { name: string }[]).map((c) => c.name),
);
for (const [name, decl] of [
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
] as const) {
  if (!userColumns.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${decl}`);
}

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
 * 'image' aparece na conversa e amplia no clique, 'audio' ganha um player,
 * 'file' vira um cartão pra baixar. Guardado em vez de deduzido na hora de
 * desenhar porque a regra pode mudar, e o que já foi mandado deve continuar
 * aparecendo do jeito que apareceu quando foi mandado.
 */
export type AttachmentKind = 'image' | 'audio' | 'file';

/** O que o cliente precisa saber de um anexo pra desenhá-lo. */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: AttachmentKind;
}

export interface MessageRow {
  id: number;
  body: string;
  created_at: number;
  user_id: string;
  author_name: string;
  author_avatar: string | null;
  attachments: Attachment[];
}

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
    'INSERT INTO messages (user_id, body, created_at) VALUES (?, ?, ?)',
  ),
  recentMessages: db.prepare<[number]>(`
    SELECT m.id, m.body, m.created_at, m.user_id,
           u.name AS author_name, u.avatar_url AS author_avatar
    FROM messages m
    JOIN users u ON u.id = m.user_id
    ORDER BY m.id DESC
    LIMIT ?
  `),

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
};

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
  (userId: string, body: string, attachmentId: string | null): number => {
    const info = stmts.insertMessage.run(userId, body, Date.now());
    const id = Number(info.lastInsertRowid);
    if (attachmentId) {
      const r = stmts.attachToMessage.run(id, attachmentId, userId);
      if (r.changes === 0) throw new Error('anexo inválido');
    }
    return id;
  },
);

export function saveMessage(
  userId: string,
  body: string,
  attachmentId: string | null = null,
): number {
  return inserirMensagem(userId, body, attachmentId);
}

export function recentMessages(limit = 100): MessageRow[] {
  const linhas = (stmts.recentMessages.all(limit) as MessageRow[]).reverse();

  // Os anexos vêm numa segunda consulta e são distribuídos aqui. Um JOIN
  // duplicaria a mensagem por anexo, e desduplicar depois custa mais que
  // este mapa.
  const porMensagem = new Map<number, Attachment[]>();
  for (const a of stmts.attachmentsForRecent.all(limit) as AttachmentRecord[]) {
    if (a.message_id === null) continue;
    const lista = porMensagem.get(a.message_id);
    const item: Attachment = { id: a.id, name: a.name, mime: a.mime, size: a.size, kind: a.kind };
    if (lista) lista.push(item);
    else porMensagem.set(a.message_id, [item]);
  }

  for (const m of linhas) m.attachments = porMensagem.get(m.id) ?? [];
  return linhas;
}

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
