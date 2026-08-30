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
}

export interface ImageRow {
  mime: string;
  bytes: Buffer;
}

export interface MessageRow {
  id: number;
  body: string;
  created_at: number;
  user_id: string;
  author_name: string;
  author_avatar: string | null;
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
       SET name = ?,
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
  patch: { bio?: string; statusText?: string },
): User {
  if (patch.bio !== undefined) stmts.updateBio.run(patch.bio, userId);
  if (patch.statusText !== undefined) stmts.updateStatusText.run(patch.statusText, userId);
  return findUserById(userId)!;
}

export function saveImage(id: string, mime: string, bytes: Buffer): void {
  stmts.insertImage.run(id, mime, bytes, Date.now());
}

export function loadImage(id: string): ImageRow | undefined {
  return stmts.findImage.get(id) as ImageRow | undefined;
}

export function deleteImage(id: string): void {
  stmts.deleteImage.run(id);
}

export function saveMessage(userId: string, body: string): number {
  const info = stmts.insertMessage.run(userId, body, Date.now());
  return Number(info.lastInsertRowid);
}

export function recentMessages(limit = 100): MessageRow[] {
  return (stmts.recentMessages.all(limit) as MessageRow[]).reverse();
}
