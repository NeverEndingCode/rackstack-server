import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'rackstack.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    username TEXT,
    avatar_url TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(provider, provider_id)
  );

  CREATE TABLE IF NOT EXISTS saves (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    data TEXT NOT NULL,
    last_save INTEGER NOT NULL
  );
`);

export function upsertUser({ provider, providerId, username, avatarUrl }) {
  const id = `${provider}:${providerId}`;
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (existing) {
    db.prepare('UPDATE users SET username = ?, avatar_url = ? WHERE id = ?').run(username, avatarUrl, id);
    return { ...existing, username, avatar_url: avatarUrl };
  }
  const user = {
    id, provider, provider_id: providerId, username, avatar_url: avatarUrl, created_at: Date.now(),
  };
  db.prepare(`
    INSERT INTO users (id, provider, provider_id, username, avatar_url, created_at)
    VALUES (@id, @provider, @provider_id, @username, @avatar_url, @created_at)
  `).run(user);
  return user;
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export function getAllUsersWithSaves() {
  return db.prepare(`
    SELECT u.id, u.provider, u.username, u.avatar_url, u.created_at,
           s.data, s.last_save
    FROM users u
    LEFT JOIN saves s ON s.user_id = u.id
    ORDER BY u.created_at DESC
  `).all();
}

export function getSave(userId) {
  return db.prepare('SELECT * FROM saves WHERE user_id = ?').get(userId);
}

export function putSave(userId, data, lastSave) {
  db.prepare(`
    INSERT INTO saves (user_id, data, last_save) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, last_save = excluded.last_save
  `).run(userId, JSON.stringify(data), lastSave);
}

export function deleteSave(userId) {
  db.prepare('DELETE FROM saves WHERE user_id = ?').run(userId);
}
