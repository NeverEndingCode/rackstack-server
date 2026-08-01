import { findAvailableUsername } from './shared.js';

/**
 * Duplicate usernames (case-insensitively) can exist from before the unique
 * index below was introduced. Must run before the CREATE UNIQUE INDEX or
 * that statement would fail on any pre-existing collision. No-op when there
 * are no duplicates, so it's cheap to run unconditionally on every boot.
 *
 * findAvailableUsername is async (its Postgres counterpart needs an async
 * predicate), so this function is too - awaited by applySchema before it
 * creates the unique index. The isTaken predicate here is itself sync (an
 * in-memory Set check); awaiting a non-promise value is harmless.
 */
export async function dedupeUsernamesSync(db) {
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
    const candidate = await findAvailableUsername(row.username, (name) => taken.has(name.toLowerCase()));
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(candidate, row.id);
    taken.add(candidate.toLowerCase());
  }
}

// Guarded ALTERs: SQLite has no "ADD COLUMN IF NOT EXISTS", so on every boot
// we attempt the ALTER and swallow only the "duplicate column name" error
// (the column already exists from a prior boot) - anything else rethrows.
function guardedAddColumn(db, sql) {
  try {
    db.exec(sql);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}

export async function applySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

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

  guardedAddColumn(db, "ALTER TABLE users ADD COLUMN roles TEXT DEFAULT '[]'");
  guardedAddColumn(db, 'ALTER TABLE users ADD COLUMN custom_username INTEGER DEFAULT 0');
  // v1.4 Live Events: the opt-out ships here (spec §5.2) and is reused by
  // v1.5's global leaderboards - it's a per-user preference, not event-scoped.
  guardedAddColumn(db, 'ALTER TABLE users ADD COLUMN leaderboard_opt_out INTEGER DEFAULT 0');
  // v1.6 tours: a JSON array of completed tour ids (shared/tours.js owns the id
  // list). Existing players default to '[]' - an empty completed-set is exactly
  // what makes the onboarding tour fire once for them.
  guardedAddColumn(db, "ALTER TABLE users ADD COLUMN tours_completed TEXT DEFAULT '[]'");

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

  // v1.4 Live Events schema (additive). live_events holds both admin-authored
  // and seeded (server/data/seasonalEvents.js) events; event_participation
  // tracks each user's progress through one event's ladder while it's live.
  db.exec(`
    CREATE TABLE IF NOT EXISTS live_events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      theme TEXT,
      modifiers TEXT NOT NULL,
      ladder TEXT NOT NULL,
      status TEXT NOT NULL,
      starts_at INTEGER,
      ends_at INTEGER,
      recurrence TEXT,
      created_at INTEGER NOT NULL,
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS event_participation (
      user_id TEXT NOT NULL REFERENCES users(id),
      event_id TEXT NOT NULL REFERENCES live_events(id),
      started_at INTEGER NOT NULL,
      ends_at INTEGER NOT NULL,
      rungs_claimed INTEGER NOT NULL DEFAULT 0,
      last_progress_at INTEGER,
      opted_out INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, event_id)
    );
  `);

  await dedupeUsernamesSync(db);

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE)');
}

export function appliedVersions(db) {
  return new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
}

export function markApplied(db, version) {
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    .run(version, Date.now());
}
