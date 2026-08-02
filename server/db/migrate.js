// One-shot SQLite -> Postgres data migrator. Run by hand (`npm run
// migrate:pg`) against a stopped-or-quiescent instance's database file; see
// docs/backup-cutover-rollback.md for the runbook this backs.
//
// Contract:
// - Refuses (returns { migrated: false, reason }) rather than acting when
//   there's nothing to do or acting would be unsafe: no source file, or a
//   target that already has data. Never partially imports.
// - Everything else happens inside ONE Postgres transaction, verified before
//   COMMIT. Any mismatch rolls the whole thing back and rejects - nothing is
//   ever left half-migrated.
// - The SQLite file is never modified beyond the WAL checkpoint (the one
//   write this module makes, needed so recent commits sitting only in
//   rackstack.db-wal aren't silently skipped) and never deleted. It is the
//   operator's rollback artifact.
// - Idempotent: re-running against an already-migrated (non-empty) target is
//   a clean no-op, not a partial re-import.
import pg from 'pg';
import Database from 'better-sqlite3';
import fs from 'fs';
import crypto from 'node:crypto';
import './pgTypes.js'; // side effect: registers the BIGINT->Number type parser
import { applySchema as applyPgSchema } from './schema.pg.js';
import { dedupeUsernameRows } from './shared.js';

// Every table the migrator knows how to move, in an order that respects the
// foreign keys declared in schema.pg.js (users/identities before saves and
// the rest, live_events before event_participation). `key` is the column
// list verification sorts by, so both sides compare in the same row order
// regardless of either database's natural storage order.
export const TABLES = [
  { name: 'users', key: ['id'] },
  { name: 'identities', key: ['provider', 'provider_id'] },
  { name: 'saves', key: ['user_id'] },
  { name: 'config', key: ['id'] },
  { name: 'config_history', key: ['version', 'updated_at'] },
  { name: 'minigame_sessions', key: ['id'] },
  { name: 'live_events', key: ['id'] },
  { name: 'event_participation', key: ['user_id', 'event_id'] },
];

function tableExists(sqlite, name) {
  return !!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

function sqliteUserHasProviderColumns(sqlite) {
  const cols = sqlite.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  return cols.includes('provider') && cols.includes('provider_id');
}

/**
 * A v1.1-era source (pre-identities-split) carries provider/provider_id on
 * `users` and has no `identities` table at all. This synthesises the same
 * rows applySchema's own migrateIdentities() would have written had the
 * source ever booted the app after the split: one identity per user,
 * `supertokens_user_id`/`last_login_at` left null since no login through
 * SuperTokens has ever happened against these rows.
 *
 * Shared between the insert step and verifyMigration so the two can't drift
 * on what "the source identities" means for an old-shape database.
 */
function synthesizedIdentityRows(sqlite) {
  return sqlite.prepare('SELECT id, provider, provider_id, created_at FROM users ORDER BY provider, provider_id')
    .all()
    .map((u) => ({
      provider: u.provider,
      provider_id: u.provider_id,
      user_id: u.id,
      supertokens_user_id: null,
      created_at: u.created_at,
      last_login_at: null,
    }));
}

/** True identities rows for tables that already have their own table. */
function sourceIdentityRows(sqlite) {
  if (tableExists(sqlite, 'identities')) {
    return sqlite.prepare('SELECT * FROM identities ORDER BY provider, provider_id').all();
  }
  return synthesizedIdentityRows(sqlite);
}

/**
 * The source `users` rows as they will actually be (or were) written to the
 * target: case-variant duplicate usernames resolved via the same -2/-3
 * suffixing convention as dedupeUsernames (see shared.js), computed in
 * memory since applySchema's unique index on lower(username) exists before
 * this migrator ever runs.
 *
 * Shared between the insert step and verifyMigration for the same reason
 * synthesizedIdentityRows is: verification must check what was actually
 * written, not a second, possibly-drifted derivation of "what should have
 * been written". Without this, verifyMigration would fingerprint the
 * *original* (pre-rename) usernames straight off disk and always disagree
 * with a target that a rename legitimately touched.
 *
 * Returns `{ rows, renames }` - `rows` is every users row (deduped rows
 * included, untouched rows passed through as-is), `renames` is just the
 * subset that changed, `[{ id, username }]`, for the insert step to log.
 */
async function dedupedUsers(sqlite) {
  if (!tableExists(sqlite, 'users')) return { rows: [], renames: [] };
  const rows = sqlite.prepare('SELECT * FROM users').all();
  if (rows.length === 0) return { rows, renames: [] };

  const named = rows.filter((r) => r.username != null)
    .slice()
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const renames = await dedupeUsernameRows(named);
  if (renames.length === 0) return { rows, renames };

  const byId = new Map(renames.map((r) => [r.id, r.username]));
  return { rows: rows.map((r) => (byId.has(r.id) ? { ...r, username: byId.get(r.id) } : r)), renames };
}

function sortByKey(rows, key) {
  return [...rows].sort((a, b) => {
    for (const k of key) {
      if (a[k] < b[k]) return -1;
      if (a[k] > b[k]) return 1;
    }
    return 0;
  });
}

async function targetColumns(client, table) {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = $1 AND table_schema = current_schema()`,
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

/**
 * A stable fingerprint of one table's contents, computed identically on both
 * sides. Rows are sorted by primary key and columns by name so neither
 * side's natural ordering can make identical data look different.
 */
function fingerprint(rows, columns) {
  const hash = crypto.createHash('sha256');
  for (const row of rows) {
    for (const col of columns) {
      const v = row[col];
      hash.update(col);
      hash.update('\x01');
      hash.update(v === null || v === undefined ? '\x00NULL' : String(v));
      hash.update('\x02');
    }
    hash.update('\x03');
  }
  return hash.digest('hex');
}

/**
 * Verifies that every table in `tables` landed in `client`'s database
 * exactly as `sqlite` has it: same row count, same content (a SHA-256
 * fingerprint over every column, sorted by primary key). Throws on the
 * first mismatch it finds; resolves silently when everything matches.
 *
 * Exported as its own function (rather than an inline step gated by a
 * test-only injection hook) specifically so it can be exercised directly
 * against a deliberately corrupted target - the only way to prove a
 * verifier actually rejects bad data, not merely that it agrees with
 * itself on good data.
 *
 * `identities` gets special handling: a source that predates the split has
 * no `identities` table to SELECT from, so its "source" rows are
 * synthesized from `users` (see synthesizedIdentityRows) - the exact same
 * synthesis the insert step used, so verification checks what was actually
 * written, not a second, possibly-drifted derivation of it. `users` is
 * similarly special-cased through dedupedUsers, for the same reason: a
 * rename the insert step made must be reflected in what verification
 * expects to find, not compared against the untouched on-disk username.
 */
export async function verifyMigration({ client, sqlite, tables = TABLES, logger = console }) {
  for (const { name, key } of tables) {
    const sourceHasTable = tableExists(sqlite, name);
    if (!sourceHasTable && name !== 'identities' && name !== 'users') continue;

    const order = key.map((k) => `"${k}"`).join(', ');
    // eslint-disable-next-line no-await-in-loop
    const pgRows = (await client.query(`SELECT * FROM ${name} ORDER BY ${order}`)).rows;

    let srcRows;
    if (name === 'identities') {
      srcRows = sourceIdentityRows(sqlite);
    } else if (name === 'users') {
      // eslint-disable-next-line no-await-in-loop
      srcRows = (await dedupedUsers(sqlite)).rows;
    } else {
      srcRows = sqlite.prepare(`SELECT * FROM ${name} ORDER BY ${key.map((k) => `"${k}"`).join(', ')}`).all();
    }
    srcRows = sortByKey(srcRows, key);

    if (srcRows.length !== pgRows.length) {
      throw new Error(
        `verification failed for ${name}: source has ${srcRows.length} rows, target has ${pgRows.length}`,
      );
    }
    if (srcRows.length === 0) continue;

    // Compare only the columns the source actually has (a legacy `users`
    // row's provider/provider_id were deliberately dropped on insert into a
    // target that has no such columns - fingerprinting them would compare
    // a column that was never supposed to survive the move).
    const columns = Object.keys(srcRows[0]).filter((c) => c in pgRows[0]).sort();
    const srcFp = fingerprint(srcRows, columns);
    const pgFp = fingerprint(pgRows, columns);
    if (srcFp !== pgFp) {
      throw new Error(`verification failed for ${name}: content fingerprint mismatch`);
    }
    logger.log(`[migrate] ${name}: verified ${srcRows.length} rows (${srcFp.slice(0, 12)})`);
  }
}

export async function migrateSqliteToPostgres({ sqlitePath, databaseUrl, logger = console }) {
  if (!fs.existsSync(sqlitePath)) {
    return { migrated: false, reason: `no sqlite database at ${sqlitePath}` };
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  // Same guard as driver.pg.js: pg's Pool emits 'error' for problems on idle
  // clients in the background (a network blip mid-migration, the target
  // being force-dropped out from under it). An unhandled 'error' event is
  // fatal to the whole Node process by default - there's nothing more to do
  // about it here than not crash; the in-flight query/transaction still
  // surfaces its own rejection through the normal catch/rollback path below.
  pool.on('error', (err) => {
    logger.error('[migrate] unexpected error on idle Postgres client', err);
  });
  await applyPgSchema(pool);

  const { rows: [{ n }] } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (n > 0) {
    await pool.end();
    return { migrated: false, reason: 'target database is not empty; refusing to migrate' };
  }

  // Recent commits live in the -wal file. Checkpointing folds them into the
  // main database so we cannot silently migrate stale data. This is the
  // only write the migrator ever makes to the SQLite side. If the -wal
  // exists but can't be folded in (permissions, another process holding a
  // lock, a corrupt WAL), refuse outright rather than proceeding on a main
  // file that might be missing the operator's most recent commits.
  const sqlite = new Database(sqlitePath);
  try {
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
  } catch (e) {
    sqlite.close();
    await pool.end();
    throw new Error(`could not checkpoint the SQLite WAL (${e.message}). Stop the container and retry.`);
  }

  const client = await pool.connect();
  const counts = {};
  try {
    await client.query('BEGIN');

    const legacyUsers = tableExists(sqlite, 'users') && sqliteUserHasProviderColumns(sqlite);
    let synthesizedIdentities = [];

    for (const { name } of TABLES) {
      if (name === 'identities' && !tableExists(sqlite, 'identities')) {
        // Handled after the loop, once `users` has been synthesized above -
        // an old-shape source has no identities table to read rows from.
        continue;
      }
      if (!tableExists(sqlite, name)) {
        logger.log(`[migrate] ${name}: absent in source, skipping`);
        counts[name] = 0;
        continue;
      }

      let rows = sqlite.prepare(`SELECT * FROM ${name}`).all();
      counts[name] = rows.length;
      if (rows.length === 0) { logger.log(`[migrate] ${name}: 0 rows`); continue; }

      if (name === 'users') {
        // Correction 2: applySchema creates the unique index on
        // lower(username) BEFORE this migrator runs, so a source containing
        // case-variant duplicates (legal pre-index) would otherwise fail at
        // INSERT with SQLSTATE 23505. Dedupe in memory first (dedupedUsers,
        // shared with verifyMigration so the two can't drift), using the
        // same -2/-3 suffixing convention as dedupeUsernames, and log every
        // rename so the operator can see which players were affected.
        // eslint-disable-next-line no-await-in-loop
        const deduped = await dedupedUsers(sqlite);
        rows = deduped.rows;
        for (const { id, username } of deduped.renames) {
          logger.log(`[migrate] users: renamed duplicate username for ${id} -> '${username}'`);
        }

        if (legacyUsers) {
          // Synthesise one identity per user BEFORE stripping the columns
          // below - this is the only place the provider/provider_id values
          // are still attached to their row.
          synthesizedIdentities = rows.map((r) => ({
            provider: r.provider,
            provider_id: r.provider_id,
            user_id: r.id,
            supertokens_user_id: null,
            created_at: r.created_at,
            last_login_at: null,
          }));
        }
      }

      // Only insert columns the target table actually has. A legacy `users`
      // row's provider/provider_id have no home in the post-split schema
      // (they became `identities` rows, handled separately) - inserting
      // them verbatim would fail with "column does not exist".
      // eslint-disable-next-line no-await-in-loop
      const targetCols = await targetColumns(client, name);
      const sourceCols = Object.keys(rows[0]);
      const columns = sourceCols.filter((c) => targetCols.has(c));
      const dropped = sourceCols.filter((c) => !targetCols.has(c));
      if (dropped.length > 0) {
        logger.log(`[migrate] ${name}: dropping column(s) not present in target schema: ${dropped.join(', ')}`);
      }

      const colList = columns.map((c) => `"${c}"`).join(', ');
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
      for (const row of rows) {
        const params = columns.map((c) => row[c]);
        // eslint-disable-next-line no-await-in-loop
        await client.query(`INSERT INTO ${name} (${colList}) VALUES (${placeholders})`, params);
      }
      logger.log(`[migrate] ${name}: ${rows.length} rows`);
    }

    if (!tableExists(sqlite, 'identities')) {
      for (const idRow of synthesizedIdentities) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO identities (provider, provider_id, user_id, supertokens_user_id, created_at, last_login_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            idRow.provider, idRow.provider_id, idRow.user_id,
            idRow.supertokens_user_id, idRow.created_at, idRow.last_login_at,
          ],
        );
      }
      counts.identities = synthesizedIdentities.length;
      logger.log(`[migrate] identities: ${synthesizedIdentities.length} rows synthesised from users`);
    }

    // Verify BEFORE committing. Anything that disagrees rolls the lot back.
    await verifyMigration({
      client, sqlite, tables: TABLES, logger,
    });

    await client.query('COMMIT');
    logger.log('[migrate] committed');
    return { migrated: true, counts };
  } catch (e) {
    await client.query('ROLLBACK');
    logger.error(`[migrate] ROLLED BACK: ${e.message}`);
    throw e;
  } finally {
    client.release();
    sqlite.close();
    await pool.end();
  }
}

// Runnable by hand: npm run migrate:pg
if (import.meta.url === `file://${process.argv[1]}`) {
  const sqlitePath = process.env.DB_PATH || '/app/data/rackstack.db';
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) { console.error('DATABASE_URL is required'); process.exit(1); }
  migrateSqliteToPostgres({ sqlitePath, databaseUrl })
    .then((r) => {
      console.log(r.migrated ? `[migrate] done: ${JSON.stringify(r.counts)}` : `[migrate] skipped: ${r.reason}`);
      process.exit(0);
    })
    .catch((e) => { console.error('[migrate] FAILED:', e.message); process.exit(1); });
}
