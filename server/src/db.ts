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

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id),
    body       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);
`);

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  created_at: number;
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
  insertUser: db.prepare(
    'INSERT INTO users (id, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)',
  ),
  updateProfile: db.prepare('UPDATE users SET name = ?, avatar_url = ? WHERE id = ?'),
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
    stmts.updateProfile.run(u.name, u.avatarUrl, existing.id);
    return { ...existing, name: u.name, avatar_url: u.avatarUrl };
  }
  stmts.insertUser.run(u.id, u.email, u.name, u.avatarUrl, Date.now());
  return findUserById(u.id)!;
}

export function saveMessage(userId: string, body: string): number {
  const info = stmts.insertMessage.run(userId, body, Date.now());
  return Number(info.lastInsertRowid);
}

export function recentMessages(limit = 100): MessageRow[] {
  return (stmts.recentMessages.all(limit) as MessageRow[]).reverse();
}
