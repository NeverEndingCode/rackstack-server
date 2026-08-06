import { dedupeUsernameRows } from './shared.js';

/**
 * Duplicate usernames (case-insensitively) can exist from before the unique
 * index below was introduced. Must run before the CREATE UNIQUE INDEX or
 * that statement would fail on any pre-existing collision. No-op when there
 * are no duplicates, so it's cheap to run unconditionally on every boot.
 *
 * The suffixing walk itself lives in shared.js's dedupeUsernameRows (async,
 * since its Postgres counterpart needs an async predicate) so the two
 * drivers can't drift on the -2/-3 convention - this function only owns the
 * SQLite-specific read and writes. Awaited by applySchema before it creates
 * the unique index, and by driver.sqlite.js's `dedupeUsernames` interface
 * method (a thin delegation to this).
 */
export async function dedupeUsernames(db) {
  const rows = db.prepare(
    'SELECT id, username, created_at FROM users WHERE username IS NOT NULL ORDER BY created_at ASC, id ASC',
  ).all();
  const renames = await dedupeUsernameRows(rows);
  const update = db.prepare('UPDATE users SET username = ? WHERE id = ?');
  for (const { id, username } of renames) {
    update.run(username, id);
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

/**
 * v1.7 identities split: login methods (provider/provider_id) move out of
 * `users` into their own `identities` table, keyed (provider, provider_id),
 * so a later release can attach more than one login method to the same
 * `users.id`. `users.id` itself (the literal string `provider:providerId`)
 * never changes here - it's the target of 3 foreign keys and the value
 * operators put in SUPER_ADMIN_IDS.
 *
 * `identities` is created unconditionally, every boot, *before* the guard
 * below - never only as a side effect of the rebuild. A database that
 * somehow reaches "users has no provider column" without `identities`
 * existing (a partial restore, a manual ALTER, a future base-DDL change)
 * must still end up with the table, or driver.sqlite.js's prepared INSERT
 * against it throws on first login.
 *
 * The base `CREATE TABLE users` (in applySchema, below) ships in its final,
 * post-split shape - it does NOT declare `provider`/`provider_id`. Only a
 * database that predates this migration has those columns, so the rebuild
 * below runs against real upgrade targets, never against a fresh install.
 * Guarded on PRAGMA table_info so it's a no-op on every boot after the one
 * that actually performs it.
 *
 * SQLite refuses DROP COLUMN while the column participates in a
 * table-level UNIQUE constraint (a pre-v1.7 `users` has UNIQUE(provider,
 * provider_id)), so the columns can't just be ALTERed away - the whole
 * table has to be rebuilt. `users_new` below hardcodes the post-split
 * column list; if a future guardedAddColumn call adds a new column to
 * `users`, `users_new` MUST be updated to carry it too, or a database still
 * on the pre-split shape when it upgrades through that release silently
 * loses that column's data in the rebuild's SELECT INTO.
 */
function migrateIdentities(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS identities (
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      supertokens_user_id TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER,
      PRIMARY KEY (provider, provider_id)
    );
    CREATE INDEX IF NOT EXISTS idx_identities_user ON identities (user_id);
  `);

  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!cols.includes('provider')) return; // already migrated (or never had it)

  db.pragma('foreign_keys = OFF');
  try {
    const tx = db.transaction(() => {
      db.exec(`
        INSERT OR IGNORE INTO identities (provider, provider_id, user_id, created_at)
          SELECT provider, provider_id, id, created_at FROM users;

        CREATE TABLE users_new (
          id TEXT PRIMARY KEY,
          username TEXT,
          avatar_url TEXT,
          created_at INTEGER NOT NULL,
          roles TEXT DEFAULT '[]',
          custom_username INTEGER DEFAULT 0,
          leaderboard_opt_out INTEGER DEFAULT 0,
          tours_completed TEXT DEFAULT '[]'
        );

        INSERT INTO users_new (id, username, avatar_url, created_at, roles,
                               custom_username, leaderboard_opt_out, tours_completed)
          SELECT id, username, avatar_url, created_at,
                 COALESCE(roles, '[]'), COALESCE(custom_username, 0),
                 COALESCE(leaderboard_opt_out, 0), COALESCE(tours_completed, '[]')
          FROM users;

        DROP TABLE users;
        ALTER TABLE users_new RENAME TO users;
      `);
      // The unique index lived on the dropped table - recreate it.
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE)');

      // saves/minigame_sessions/event_participation declare their foreign
      // keys against the *name* `users`, so the rename re-points them.
      // Verify rather than assume - a violation here means orphaned saves.
      // Checked and thrown INSIDE this transaction, before it returns, so a
      // violation aborts the rebuild (better-sqlite3 rolls back on a thrown
      // exception) instead of durably committing broken data and only
      // failing the boot afterward - which would self-heal into silence:
      // the next boot sees no `provider` column, skips the rebuild, and
      // never checks again.
      const violations = db.pragma('foreign_key_check');
      if (violations.length > 0) {
        throw new Error(`identities migration left ${violations.length} FK violations`);
      }
    });
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
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
      username TEXT,
      avatar_url TEXT,
      created_at INTEGER NOT NULL
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

  // Dedupe BEFORE the identities rebuild: migrateIdentities recreates
  // idx_users_username as part of the same transaction that builds the new
  // `users` table, so any leftover case-duplicate usernames on a database
  // upgrading straight from a very old pre-index version must be resolved
  // first, or that CREATE UNIQUE INDEX would fail.
  await dedupeUsernames(db);
  migrateIdentities(db);

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE)');
}

export function appliedVersions(db) {
  return new Set(db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
}

export function markApplied(db, version) {
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)')
    .run(version, Date.now());
}
