// Postgres DDL. Dialect notes vs. schema.sqlite.js:
//
// - BIGINT (never INTEGER) for every epoch-ms timestamp column - int4
//   overflows in 2038, and these are all far below 2^53 so no precision is
//   lost once driver.pg.js's int8 type parser (registered at module load)
//   converts them back to JS numbers on read.
// - SMALLINT 0/1 for boolean-ish flags (custom_username, leaderboard_opt_out,
//   opted_out), not BOOLEAN - the codebase writes `? 1 : 0` and reads
//   truthiness on both backends, so the column type must match.
// - JSON columns stay TEXT, never jsonb - jsonb reorders keys, strips
//   whitespace, and rejects some escapes, so saves would not round-trip
//   byte-for-byte (see tests/db.parity.test.js's byte-for-byte save test).
// - config_history gains a real primary key (BIGSERIAL): SQLite ordered
//   history by rowid, which Postgres has no equivalent of, and the admin
//   rollback UI depends on newest-first order.
// - COLLATE NOCASE has no Postgres equivalent; a unique functional index on
//   lower(username) gives the same case-insensitive uniqueness guarantee.
//   Every username lookup in driver.pg.js uses lower() to match.
//
// Unlike schema.sqlite.js's guarded ALTER history (roles, custom_username,
// leaderboard_opt_out, tours_completed all arrived that way across
// v1.2-v1.6), every column below ships in its CREATE TABLE from the start -
// this schema didn't exist before those columns did. `users` ships in its
// final, post-v1.7 shape too: `provider`/`provider_id` are NOT declared
// here. Only a database that predates the identities split (see
// migrateIdentities, below) still has them - this CREATE TABLE is only ever
// a no-op (IF NOT EXISTS) against such a database, never the statement that
// creates its shape.
export async function applySchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT,
      avatar_url TEXT,
      created_at BIGINT NOT NULL,
      roles TEXT DEFAULT '[]',
      custom_username SMALLINT DEFAULT 0,
      leaderboard_opt_out SMALLINT DEFAULT 0,
      tours_completed TEXT DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS saves (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      data TEXT NOT NULL,
      last_save BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      data TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      updated_by TEXT
    );

    -- SQLite ordered this by rowid. Postgres has no rowid, so history order
    -- - which the admin rollback UI depends on - needs a real key.
    CREATE TABLE IF NOT EXISTS config_history (
      id BIGSERIAL PRIMARY KEY,
      version INTEGER NOT NULL,
      data TEXT NOT NULL,
      updated_at BIGINT NOT NULL,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS minigame_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      game TEXT NOT NULL,
      started_at BIGINT NOT NULL,
      finished_at BIGINT,
      score INTEGER
    );

    CREATE TABLE IF NOT EXISTS live_events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      theme TEXT,
      modifiers TEXT NOT NULL,
      ladder TEXT NOT NULL,
      status TEXT NOT NULL,
      starts_at BIGINT,
      ends_at BIGINT,
      recurrence TEXT,
      created_at BIGINT NOT NULL,
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS event_participation (
      user_id TEXT NOT NULL REFERENCES users(id),
      event_id TEXT NOT NULL REFERENCES live_events(id),
      started_at BIGINT NOT NULL,
      ends_at BIGINT NOT NULL,
      rungs_claimed INTEGER NOT NULL DEFAULT 0,
      last_progress_at BIGINT,
      opted_out SMALLINT NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, event_id)
    );
  `);

  // COLLATE NOCASE has no Postgres equivalent; a functional index on lower()
  // gives the same guarantee. Every username lookup must use lower() to match.
  await pool.query(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (lower(username))',
  );

  await migrateIdentities(pool);
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
 * below - never only as a side effect of the backfill-and-drop. The base
 * `CREATE TABLE users` above ships in its final, post-split shape (no
 * `provider`/`provider_id`), so the guard below only ever fires for a
 * database that predates this migration - a genuinely fresh install never
 * has those columns to find. Guarded on information_schema so it's a no-op
 * on every boot after the one that actually performs it.
 */
async function migrateIdentities(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS identities (
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      supertokens_user_id TEXT UNIQUE,
      created_at BIGINT NOT NULL,
      last_login_at BIGINT,
      PRIMARY KEY (provider, provider_id)
    );
    CREATE INDEX IF NOT EXISTS idx_identities_user ON identities (user_id);
  `);

  // Backfill from users, then drop the migrated columns. Guarded so it is a
  // no-op on a database that has already been through this - DROP COLUMN
  // also silently drops the UNIQUE(provider, provider_id) constraint that
  // depended on them, Postgres handles that automatically (no CASCADE
  // needed for a plain table constraint like this one). table_schema is
  // pinned to current_schema() so this can't match a same-named `users`
  // table sitting in a different schema on the same search_path.
  const hasProvider = await pool.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'provider'
      AND table_schema = current_schema()
  `);
  if (hasProvider.rowCount > 0) {
    await pool.query(`
      INSERT INTO identities (provider, provider_id, user_id, created_at)
      SELECT provider, provider_id, id, created_at FROM users
      ON CONFLICT (provider, provider_id) DO NOTHING
    `);
    await pool.query('ALTER TABLE users DROP COLUMN provider, DROP COLUMN provider_id');
  }
}

export async function appliedVersions(pool) {
  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

export async function markApplied(pool, version) {
  await pool.query(
    'INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [version, Date.now()],
  );
}
