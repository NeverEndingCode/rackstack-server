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
// Unlike schema.sqlite.js, there's no guarded ALTER history to replay here -
// this is a fresh schema, so every column ships in its CREATE TABLE from the
// start (roles, custom_username, leaderboard_opt_out, tours_completed all
// arrived as guarded ALTERs on the SQLite side across v1.2-v1.6; here they're
// just columns).
export async function applySchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      username TEXT,
      avatar_url TEXT,
      created_at BIGINT NOT NULL,
      roles TEXT DEFAULT '[]',
      custom_username SMALLINT DEFAULT 0,
      leaderboard_opt_out SMALLINT DEFAULT 0,
      tours_completed TEXT DEFAULT '[]',
      UNIQUE (provider, provider_id)
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
