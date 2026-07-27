import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';

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

// Guarded ALTERs: SQLite has no "ADD COLUMN IF NOT EXISTS", so on every boot
// we attempt the ALTER and swallow only the "duplicate column name" error
// (the column already exists from a prior boot) - anything else rethrows.
function guardedAddColumn(sql) {
  try {
    db.exec(sql);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}

guardedAddColumn("ALTER TABLE users ADD COLUMN roles TEXT DEFAULT '[]'");
guardedAddColumn('ALTER TABLE users ADD COLUMN custom_username INTEGER DEFAULT 0');

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );

  CREATE TABLE IF NOT EXISTS config_history (
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );

  CREATE TABLE IF NOT EXISTS minigame_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    game TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    score INTEGER
  );
`);

/**
 * Returns a username derived from `desiredName` that `isTaken` reports as
 * free, suffixing `-2`, `-3`, ... until one is. `desiredName` itself is
 * returned unchanged if it's already free. Shared by dedupeUsernames (bulk
 * cleanup, checks an in-memory Set) and upsertUser (per-insert retry,
 * checks the DB) so both use the same suffixing convention against the
 * same COLLATE NOCASE uniqueness rule.
 */
function findAvailableUsername(desiredName, isTaken) {
  if (!isTaken(desiredName)) return desiredName;
  let n = 2;
  let candidate = `${desiredName}-${n}`;
  while (isTaken(candidate)) {
    n += 1;
    candidate = `${desiredName}-${n}`;
  }
  return candidate;
}

// Duplicate usernames (case-insensitively) can exist from before the unique
// index below was introduced. Must run before the CREATE UNIQUE INDEX or
// that statement would fail on any pre-existing collision. No-op when there
// are no duplicates, so it's cheap to run unconditionally on every boot.
export function dedupeUsernames() {
  const rows = db.prepare(
    'SELECT id, username, created_at FROM users WHERE username IS NOT NULL ORDER BY created_at ASC, id ASC',
  ).all();
  const taken = new Set();
  for (const row of rows) {
    const lower = row.username.toLowerCase();
    if (!taken.has(lower)) {
      taken.add(lower);
      continue;
    }
    const candidate = findAvailableUsername(row.username, (name) => taken.has(name.toLowerCase()));
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(candidate, row.id);
    taken.add(candidate.toLowerCase());
  }
}

dedupeUsernames();

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE)');

function isUsernameTakenInDb(name) {
  return !!db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(name);
}

const insertUserStmt = db.prepare(`
  INSERT INTO users (id, provider, provider_id, username, avatar_url, created_at)
  VALUES (@id, @provider, @provider_id, @username, @avatar_url, @created_at)
`);

export function upsertUser({ provider, providerId, username, avatarUrl }) {
  const id = `${provider}:${providerId}`;
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (existing) {
    // A user who has set a custom username keeps it on re-login; only the
    // avatar (which the user doesn't control) is refreshed from the profile.
    const nextUsername = existing.custom_username ? existing.username : username;
    db.prepare('UPDATE users SET username = ?, avatar_url = ? WHERE id = ?').run(nextUsername, avatarUrl, id);
    return { ...existing, username: nextUsername, avatar_url: avatarUrl };
  }

  const user = {
    id, provider, provider_id: providerId, username, avatar_url: avatarUrl, created_at: Date.now(),
  };
  try {
    insertUserStmt.run(user);
  } catch (e) {
    // Two different brand-new OAuth accounts can independently supply the
    // same (or case-variant) username - the COLLATE NOCASE unique index
    // rejects the second insert with SQLITE_CONSTRAINT_UNIQUE. Without this
    // catch, that error would propagate to a 500 and - since upsertUser
    // runs on every login, not just the first - permanently block that
    // account from ever logging in. Pick a free variant using the same
    // suffixing convention as dedupeUsernames and retry once.
    if (e.code !== 'SQLITE_CONSTRAINT_UNIQUE' && e.code !== 'SQLITE_CONSTRAINT') throw e;
    user.username = findAvailableUsername(username, isUsernameTakenInDb);
    insertUserStmt.run(user);
  }
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

/**
 * Roles are stored as a JSON array string in users.roles (default '[]').
 * Membership in the array is the only thing that matters - ordering and
 * duplicates are not deduped here; callers (server/auth.js, Task 8) treat
 * this as a plain set.
 */
export function getRoles(userId) {
  const row = db.prepare('SELECT roles FROM users WHERE id = ?').get(userId);
  if (!row || !row.roles) return [];
  try {
    return JSON.parse(row.roles);
  } catch (e) {
    return [];
  }
}

export function setRoles(userId, roles) {
  db.prepare('UPDATE users SET roles = ? WHERE id = ?').run(JSON.stringify(roles), userId);
}

/**
 * Sets a user's username, format-agnostic (the route layer owns the regex).
 * Performs its own case-insensitive availability check excluding the user
 * themself, and marks the username as user-chosen so upsertUser stops
 * overwriting it from the OAuth profile on future logins.
 */
export function setUsername(userId, name) {
  const collision = db.prepare(
    'SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?',
  ).get(name, userId);
  if (collision) return { ok: false, error: 'taken' };
  db.prepare('UPDATE users SET username = ?, custom_username = 1 WHERE id = ?').run(name, userId);
  return { ok: true };
}

export function createMinigameSession(userId, game) {
  const session = {
    id: randomUUID(),
    user_id: userId,
    game,
    started_at: Date.now(),
    finished_at: null,
    score: null,
  };
  db.prepare(`
    INSERT INTO minigame_sessions (id, user_id, game, started_at, finished_at, score)
    VALUES (@id, @user_id, @game, @started_at, @finished_at, @score)
  `).run(session);
  return session;
}

export function getMinigameSession(id) {
  return db.prepare('SELECT * FROM minigame_sessions WHERE id = ?').get(id);
}

/**
 * Finds the most recent still-open (unfinished, not yet expired) session
 * for `userId`+`game`, if any. "Not yet expired" is caller-supplied as
 * `minStartedAt` (a session's `started_at` must be >= this to count) since
 * the expiry window depends on `config.minigames[game].durationSec`, which
 * this module doesn't have access to - the route layer computes it.
 * Used to block a burst of concurrently-open sessions for the same game
 * (each of which would otherwise dodge the win cooldown independently).
 */
export function getOpenMinigameSession(userId, game, minStartedAt) {
  return db.prepare(`
    SELECT * FROM minigame_sessions
    WHERE user_id = ? AND game = ? AND finished_at IS NULL AND started_at >= ?
    ORDER BY started_at DESC LIMIT 1
  `).get(userId, game, minStartedAt);
}

export function finishMinigameSession(id, score) {
  db.prepare('UPDATE minigame_sessions SET finished_at = ?, score = ? WHERE id = ?').run(Date.now(), score, id);
}

/**
 * Returns the singleton config row (id=1): { id, version, data, updated_at,
 * updated_by }, or undefined if no config has been seeded yet. `data` is
 * returned as the raw JSON text exactly as stored - mirroring getSave's
 * convention, callers JSON.parse it themselves.
 */
export function getConfigRow() {
  return db.prepare('SELECT * FROM config WHERE id = 1').get();
}

/**
 * Upserts the singleton config row (id=1) to `{ version, data, userId }`
 * and appends a matching row to config_history for audit/rollback. `data`
 * is a plain JS object; it is JSON.stringify'd here (the same convention
 * putSave uses) - callers never pass pre-stringified JSON.
 */
export function putConfigRow(version, data, userId) {
  const text = JSON.stringify(data);
  const now = Date.now();
  db.prepare(`
    INSERT INTO config (id, version, data, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version, data = excluded.data,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(version, text, now, userId);
  db.prepare(`
    INSERT INTO config_history (version, data, updated_at, updated_by) VALUES (?, ?, ?, ?)
  `).run(version, text, now, userId);
}

export function getConfigHistory() {
  return db.prepare('SELECT * FROM config_history ORDER BY rowid DESC').all();
}
