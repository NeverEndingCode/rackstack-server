import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import pg from 'pg';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { provisionDatabase } from './helpers/backend.js';
import { migrateSqliteToPostgres, verifyMigration, TABLES } from '../server/db/migrate.js';

// This suite is Postgres-only by nature - it tests moving data INTO Postgres.
// Determined without holding onto a provisioned database: each `it()` below
// carves out its own via beforeEach, since the migrator's core behavior
// (refuses on a non-empty target, is idempotent) can only be tested
// meaningfully against a target whose emptiness this test controls - a
// single database shared across the whole file would have every test after
// the first see "not empty" regardless of what it's actually trying to check.
const skip = process.env.TEST_BACKEND === 'sqlite';

const FIXTURE = path.resolve('tests/fixtures/v11-sqlite.db');

// Tracks scratch files created by individual tests (temp copies of the
// fixture, WAL-mode databases, etc.) so they can be cleaned up afterward
// without leaking them into the repo or across test runs.
const scratchFiles = [];
function scratchCopy(suffix = '') {
  const p = path.join(os.tmpdir(), `migrate-test-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}.db`);
  fs.copyFileSync(FIXTURE, p);
  scratchFiles.push(p);
  return p;
}

describe.skipIf(skip)('sqlite -> postgres migration', () => {
  let db;
  beforeEach(async () => {
    db = await provisionDatabase();
  });
  afterEach(async () => {
    await db.cleanup();
    while (scratchFiles.length) {
      const p = scratchFiles.pop();
      for (const ext of ['', '-wal', '-shm', '-journal']) {
        try { fs.unlinkSync(p + ext); } catch { /* not present */ }
      }
    }
  });

  it('migrates a v1.1-era two-table database', async () => {
    const result = await migrateSqliteToPostgres({
      sqlitePath: FIXTURE,
      databaseUrl: db.url,
    });
    expect(result.migrated).toBe(true);
    expect(result.counts.users).toBe(2);
    expect(result.counts.saves).toBe(2);

    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    const { rows } = await client.query('SELECT data, last_save FROM saves WHERE user_id = $1',
      ['github:37058311']);
    // Byte-exact, not deep-equal: the point is that the JSON text is untouched.
    expect(rows[0].data).toBe('{"wafers":1439,"racks":[1,2,3]}');
    expect(rows[0].last_save).toBe(1784859999000);

    const ids = await client.query('SELECT * FROM identities ORDER BY provider');
    expect(ids.rows).toHaveLength(2);
    expect(ids.rows[0]).toMatchObject({ provider: 'discord', user_id: 'discord:536626725380161537' });
    expect(ids.rows[0].last_login_at).toBeNull();

    // The v1.1 fixture's users rows must not have gained provider/provider_id
    // columns that don't exist in the post-split schema.
    const users = await client.query('SELECT * FROM users ORDER BY id');
    expect(users.rows[0]).not.toHaveProperty('provider');
    expect(users.rows[0]).not.toHaveProperty('provider_id');
    await client.end();
  });

  it('declines when the target already has data', async () => {
    await migrateSqliteToPostgres({ sqlitePath: FIXTURE, databaseUrl: db.url });
    const second = await migrateSqliteToPostgres({ sqlitePath: FIXTURE, databaseUrl: db.url });
    expect(second.migrated).toBe(false);
    expect(second.reason).toMatch(/not empty/i);
  });

  it('declines on a target with an empty `users` but a populated other table, and names that table', async () => {
    // server/index.js calls seedSeasonalEvents() on every boot, which
    // inserts fixed-id rows into live_events - so a target the app has
    // booted against even once (a plausible cutover sequence) has an empty
    // `users` but a non-empty `live_events`. Checking only `users` would
    // sail straight through this and either collide (SQLSTATE 23505, for a
    // modern source with its own live_events rows) or, worse, COMMIT
    // successfully while leaving these pre-existing rows completely
    // unaccounted for (for a v1.1 source with no live_events table at all,
    // which the insert loop and verification both simply skip).
    const { applySchema } = await import('../server/db/schema.pg.js');
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      await applySchema(client);
      await client.query(`
        INSERT INTO live_events (id, name, modifiers, ladder, status, created_at)
        VALUES ('summer-surge', 'Summer Surge', '[]', '[]', 'draft', $1)
      `, [Date.now()]);
    } finally {
      await client.end();
    }

    const result = await migrateSqliteToPostgres({ sqlitePath: FIXTURE, databaseUrl: db.url });
    expect(result.migrated).toBe(false);
    expect(result.reason).toMatch(/not empty/i);
    expect(result.reason).toMatch(/live_events/);
  });

  it('declines when there is no sqlite file', async () => {
    const result = await migrateSqliteToPostgres({
      sqlitePath: '/nonexistent/rackstack.db', databaseUrl: db.url,
    });
    expect(result.migrated).toBe(false);
    expect(result.reason).toMatch(/no sqlite/i);
  });

  it('is idempotent: a second run against an already-migrated target is a clean no-op', async () => {
    const first = await migrateSqliteToPostgres({ sqlitePath: FIXTURE, databaseUrl: db.url });
    expect(first.migrated).toBe(true);

    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    const before = await client.query('SELECT count(*)::int AS n FROM saves');

    const second = await migrateSqliteToPostgres({ sqlitePath: FIXTURE, databaseUrl: db.url });
    expect(second.migrated).toBe(false);

    const after = await client.query('SELECT count(*)::int AS n FROM saves');
    expect(after.rows[0].n).toBe(before.rows[0].n); // no partial re-import
    await client.end();
  });

  it('renames the later of two case-variant duplicate usernames with a -2 suffix, without touching non-colliding ones', async () => {
    const tmp = scratchCopy();
    const raw = new Database(tmp);
    raw.exec("UPDATE users SET username = 'Neo' WHERE id = 'github:37058311'");
    raw.prepare(`
      INSERT INTO users (id, provider, provider_id, username, avatar_url, created_at)
      VALUES ('github:dup2', 'github', 'dup2', 'neo', NULL, 1784859388999)
    `).run();
    raw.close();

    const result = await migrateSqliteToPostgres({ sqlitePath: tmp, databaseUrl: db.url });
    expect(result.migrated).toBe(true);

    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    const earlier = await client.query('SELECT username FROM users WHERE id = $1', ['github:37058311']);
    const later = await client.query('SELECT username FROM users WHERE id = $1', ['github:dup2']);
    // Earlier-created row (by created_at) keeps its name; the later duplicate
    // gets the -2 suffix - same convention as dedupeUsernameRows/shared.js.
    expect(earlier.rows[0].username).toBe('Neo');
    expect(later.rows[0].username).toBe('neo-2');

    // The other fixture user, with no collision at all, must be untouched.
    const untouched = await client.query('SELECT username FROM users WHERE id = $1', ['discord:536626725380161537']);
    expect(untouched.rows[0].username).toBe('short_techy97');
    await client.end();
  });

  it('checkpoints the WAL before reading, so recent commits sitting only in -wal are not lost', async () => {
    const tmp = path.join(os.tmpdir(), `migrate-wal-${Date.now()}.db`);
    scratchFiles.push(tmp);
    const raw = new Database(tmp);
    raw.pragma('journal_mode = WAL');
    raw.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_id TEXT NOT NULL,
        username TEXT, avatar_url TEXT, created_at INTEGER NOT NULL,
        UNIQUE(provider, provider_id)
      );
      CREATE TABLE saves (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        data TEXT NOT NULL, last_save INTEGER NOT NULL
      );
    `);
    // This INSERT lands in the -wal file, not the main .db file, and is
    // never checkpointed by this test - only migrateSqliteToPostgres's own
    // checkpoint should be able to see it. Deliberately NOT closed before
    // the migrator runs: closing the last connection to a WAL-mode SQLite
    // database triggers SQLite's own automatic checkpoint-on-close, which
    // would fold the WAL in (and delete the -wal file) before the migrator
    // ever gets a chance to - defeating the point of this test. A second,
    // independent better-sqlite3 handle to the same file (opened inside
    // migrateSqliteToPostgres) is exactly what a real deployment does too:
    // the operator's own process was still holding the file open until they
    // stopped it, not the migrator.
    raw.prepare(`
      INSERT INTO users (id, provider, provider_id, username, avatar_url, created_at)
      VALUES ('github:wal1', 'github', 'wal1', 'walwriter', NULL, 1784859388645)
    `).run();
    expect(fs.existsSync(`${tmp}-wal`)).toBe(true);

    const result = await migrateSqliteToPostgres({ sqlitePath: tmp, databaseUrl: db.url });
    expect(result.migrated).toBe(true);
    expect(result.counts.users).toBe(1);

    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    const row = await client.query('SELECT * FROM users WHERE id = $1', ['github:wal1']);
    expect(row.rows).toHaveLength(1);
    await client.end();

    // Never modified beyond the checkpoint, never deleted - the operator's
    // rollback artifact must still be exactly where it was.
    expect(fs.existsSync(tmp)).toBe(true);

    // Discriminating assertion: a SQLite reader merges committed WAL frames
    // regardless of whether anyone ever checkpoints (that's what let the row
    // above be read correctly either way) - so this test would pass
    // identically with the checkpoint call deleted entirely unless it
    // specifically checks that a checkpoint actually ran. TRUNCATE mode
    // truncates -wal to zero bytes rather than deleting it, so a leftover
    // non-zero -wal is the tell that migrateSqliteToPostgres's own
    // checkpoint never fired. Checked BEFORE closing `raw`: closing the
    // last connection to a WAL-mode database does its own
    // checkpoint-and-delete of `-wal`/`-shm`, which would make this
    // assertion vacuously true (or throw ENOENT) for a completely unrelated
    // reason.
    expect(fs.statSync(`${tmp}-wal`).size).toBe(0);
    raw.close();
  });

  it('refuses when the WAL checkpoint is blocked by another connection, rather than proceeding silently', async () => {
    // wal_checkpoint(TRUNCATE) reports a blocked checkpoint as a *returned
    // row* (`{ busy: 1, ... }`), not a thrown exception - so this has to be
    // simulated by actually blocking one, not just asserted from reading the
    // implementation. A second connection holding an open read transaction
    // (BEGIN + a SELECT, never committed until after the assertion) is
    // exactly what "another process holds the file" looks like in practice.
    const tmp = scratchCopy();
    const blocker = new Database(tmp);
    blocker.pragma('journal_mode = WAL');
    // A TRUNCATE checkpoint is only blocked by a reader whose pinned
    // snapshot actually includes WAL content the checkpoint would need to
    // discard - an empty WAL has nothing for a reader to be blocking. This
    // write (auto-committed, before the explicit BEGIN below) puts a real
    // frame in the WAL for the read transaction to pin to.
    blocker.exec("UPDATE users SET username = 'still-here' WHERE id = 'github:37058311'");
    blocker.exec('BEGIN');
    blocker.prepare('SELECT * FROM users').all();

    try {
      await expect(migrateSqliteToPostgres({ sqlitePath: tmp, databaseUrl: db.url }))
        .rejects.toThrow(/could not checkpoint the sqlite wal/i);
    } finally {
      blocker.exec('COMMIT');
      blocker.close();
    }

    // The refusal must not have left the target half-populated or the pg
    // pool leaked - a normal run right after must still succeed cleanly.
    // Deliberately a *fresh* scratch copy rather than reusing `tmp`:
    // reopening the exact same file immediately after `blocker.close()`
    // raced SQLite's own lock-release timing in practice (multi-second
    // delays came from that, not from anything migrateSqliteToPostgres
    // does), which is a file-handle-reuse artifact of this test, not
    // something worth asserting on.
    const result = await migrateSqliteToPostgres({ sqlitePath: scratchCopy(), databaseUrl: db.url });
    expect(result.migrated).toBe(true);
  });

  it('wraps a failure opening the source file in the operator-facing checkpoint message, not a raw SqliteError', async () => {
    // Specifically targets `new Database(sqlitePath)` throwing, as opposed
    // to the checkpoint pragma call throwing - those are two different
    // lines and, before this fix, only the second was inside the try. A
    // garbage-bytes file doesn't distinguish them: better-sqlite3 opens the
    // file handle lazily and only reads (and rejects) the header on the
    // first real pragma/query, so even the un-fixed code happened to catch
    // that case via the pragma call already being inside its try. A
    // directory is different: better-sqlite3 rejects it immediately at
    // `new Database()`, before any pragma ever runs - the genuine
    // regression case for "open() itself throws".
    const tmp = path.join(os.tmpdir(), `migrate-corrupt-dir-${Date.now()}.db`);
    fs.mkdirSync(tmp);
    try {
      await expect(migrateSqliteToPostgres({ sqlitePath: tmp, databaseUrl: db.url }))
        .rejects.toThrow(/could not checkpoint the sqlite wal/i);
    } finally {
      fs.rmdirSync(tmp);
    }

    // Same pool-leak concern as the blocked-checkpoint case: a subsequent,
    // legitimate call against the same target must still work.
    const result = await migrateSqliteToPostgres({ sqlitePath: FIXTURE, databaseUrl: db.url });
    expect(result.migrated).toBe(true);
  });

  it('ends the pg pool after an early failure connecting to the target, so a later call is unaffected', async () => {
    // Covers the applyPgSchema/emptiness-check try/catch specifically (as
    // opposed to the sqlite-side failures above): a nonexistent target
    // database fails on the pool's very first query. A leaked pool here
    // wouldn't necessarily throw its own error in this test, but it would
    // eventually starve later connections - proven the same way as the
    // sqlite-side cases, by a legitimate call succeeding promptly right
    // after.
    const badUrl = new URL(db.url);
    badUrl.pathname = '/rackstack_test_migrate_leak_probe_does_not_exist';
    await expect(migrateSqliteToPostgres({ sqlitePath: FIXTURE, databaseUrl: badUrl.toString() }))
      .rejects.toThrow();

    const result = await migrateSqliteToPostgres({ sqlitePath: FIXTURE, databaseUrl: db.url });
    expect(result.migrated).toBe(true);
  });

  // Correction 1 (owner-mandated): no test-only __corruptForTest hook in
  // production code. verifyMigration is exported as its own function
  // instead, so it can be exercised directly against a deliberately
  // corrupted target - this is a genuine unit test of the verifier, not an
  // injection through a production-only backdoor.
  describe('verifyMigration', () => {
    it('passes for a clean migration', async () => {
      await migrateSqliteToPostgres({ sqlitePath: FIXTURE, databaseUrl: db.url });
      const client = new pg.Client({ connectionString: db.url });
      await client.connect();
      const sqlite = new Database(FIXTURE, { readonly: true });
      try {
        await expect(verifyMigration({ client, sqlite, tables: TABLES })).resolves.not.toThrow();
      } finally {
        sqlite.close();
        await client.end();
      }
    });

    it('rejects a target whose row content has been tampered with post-migration', async () => {
      await migrateSqliteToPostgres({ sqlitePath: FIXTURE, databaseUrl: db.url });
      const client = new pg.Client({ connectionString: db.url });
      await client.connect();
      try {
        // Deliberately corrupt the target directly - the whole point of this
        // test is proving the verifier can actually fail, not merely that
        // clean data passes it.
        await client.query("UPDATE saves SET data = '{\"wafers\":0}' WHERE user_id = 'github:37058311'");

        const sqlite = new Database(FIXTURE, { readonly: true });
        try {
          await expect(verifyMigration({ client, sqlite, tables: TABLES }))
            .rejects.toThrow(/verification failed/i);
        } finally {
          sqlite.close();
        }
      } finally {
        await client.end();
      }
    });

    it('rejects a target with a missing row (count mismatch)', async () => {
      await migrateSqliteToPostgres({ sqlitePath: FIXTURE, databaseUrl: db.url });
      const client = new pg.Client({ connectionString: db.url });
      await client.connect();
      try {
        await client.query("DELETE FROM saves WHERE user_id = 'github:37058311'");

        const sqlite = new Database(FIXTURE, { readonly: true });
        try {
          await expect(verifyMigration({ client, sqlite, tables: TABLES }))
            .rejects.toThrow(/verification failed/i);
        } finally {
          sqlite.close();
        }
      } finally {
        await client.end();
      }
    });
  });

  it('rolls back and throws when verification fails mid-migration', async () => {
    // No test-only hook exists to inject corruption mid-transaction (see
    // correction 1). Instead, a BEFORE INSERT trigger on the freshly
    // provisioned target corrupts rows as the migrator's own INSERTs land -
    // a real mechanism the verifier has to catch, exercised through the
    // actual end-to-end migrateSqliteToPostgres path rather than a unit
    // call to verifyMigration alone.
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    // The trigger targets `saves`, which doesn't exist yet on a freshly
    // provisioned database - migrateSqliteToPostgres normally creates it via
    // applyPgSchema as its own first step, but the trigger has to be in
    // place before that call runs. Apply the schema here first; the
    // migrator's own (idempotent, CREATE TABLE IF NOT EXISTS) call to
    // applySchema is a no-op on top of it.
    const { applySchema } = await import('../server/db/schema.pg.js');
    await applySchema(client);
    await client.query(`
      CREATE OR REPLACE FUNCTION migrate_test_corrupt_saves() RETURNS trigger AS $$
      BEGIN
        NEW.data := '{"wafers":0}';
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER migrate_test_corrupt_saves_trigger BEFORE INSERT ON saves
      FOR EACH ROW EXECUTE FUNCTION migrate_test_corrupt_saves();
    `);

    try {
      await expect(migrateSqliteToPostgres({
        sqlitePath: FIXTURE,
        databaseUrl: db.url,
      })).rejects.toThrow(/verification failed/i);

      const { rows } = await client.query('SELECT count(*)::int AS n FROM saves');
      expect(rows[0].n).toBe(0); // rolled back - nothing committed

      const users = await client.query('SELECT count(*)::int AS n FROM users');
      expect(users.rows[0].n).toBe(0); // whole transaction rolled back, not just saves
    } finally {
      await client.query(`
        DROP TRIGGER IF EXISTS migrate_test_corrupt_saves_trigger ON saves;
        DROP FUNCTION IF EXISTS migrate_test_corrupt_saves();
      `);
      await client.end();
    }
  });

  it('migrates a fully modern source: identities already split, plus config/config_history/minigame_sessions/live_events/event_participation', async () => {
    // The v1.1 fixture only exercises the legacy two-table path (users +
    // saves, provider/provider_id on users, identities synthesized). A real
    // production database that has already booted the current app has been
    // through schema.sqlite.js's own migrateIdentities, so `identities` is
    // already a real table, `users` already lacks provider/provider_id, and
    // every other table this migrator knows about is populated too. This
    // proves the generic per-table insert/verify path - not just the
    // special-cased legacy branch - for the full TABLES list.
    const { applySchema } = await import('../server/db/schema.sqlite.js');
    const raw = new Database(':memory:');
    await applySchema(raw);

    raw.prepare('INSERT INTO users (id, username, avatar_url, created_at, roles) VALUES (?,?,?,?,?)')
      .run('github:modern1', 'modernuser', null, 1_700_000_000_000, '["admin"]');
    raw.prepare(`
      INSERT INTO identities (provider, provider_id, user_id, supertokens_user_id, created_at, last_login_at)
      VALUES (?,?,?,?,?,?)
    `).run('github', 'modern1', 'github:modern1', 'st-abc', 1_700_000_000_000, 1_700_000_001_000);
    raw.prepare('INSERT INTO saves (user_id, data, last_save) VALUES (?,?,?)')
      .run('github:modern1', '{"wafers":7}', 1_700_000_002_000);
    raw.prepare('INSERT INTO config (id, version, data, updated_at, updated_by) VALUES (1,?,?,?,?)')
      .run(3, '{"tick":1}', 1_700_000_003_000, 'github:modern1');
    raw.prepare('INSERT INTO config_history (version, data, updated_at, updated_by) VALUES (?,?,?,?)')
      .run(1, '{"tick":0}', 1_700_000_000_500, null);
    raw.prepare('INSERT INTO config_history (version, data, updated_at, updated_by) VALUES (?,?,?,?)')
      .run(3, '{"tick":1}', 1_700_000_003_000, 'github:modern1');
    raw.prepare(`
      INSERT INTO minigame_sessions (id, user_id, game, started_at, finished_at, score)
      VALUES (?,?,?,?,?,?)
    `).run('sess-1', 'github:modern1', 'wafer-drop', 1_700_000_004_000, 1_700_000_005_000, 42);
    raw.prepare(`
      INSERT INTO live_events (id, name, description, theme, modifiers, ladder, status,
                                starts_at, ends_at, recurrence, created_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run('evt-1', 'Summer Surge', null, 'null', '[]', '[]', 'ended',
      1_700_000_000_000, 1_700_000_100_000, 'null', 1_699_999_999_000, 'github:modern1');
    raw.prepare(`
      INSERT INTO event_participation (user_id, event_id, started_at, ends_at,
                                        rungs_claimed, last_progress_at, opted_out)
      VALUES (?,?,?,?,?,?,?)
    `).run('github:modern1', 'evt-1', 1_700_000_000_500, 1_700_000_100_000, 5, 1_700_000_050_000, 0);

    const tmp = path.join(os.tmpdir(), `migrate-modern-${Date.now()}.db`);
    scratchFiles.push(tmp);
    await raw.backup(tmp);
    raw.close();

    const result = await migrateSqliteToPostgres({ sqlitePath: tmp, databaseUrl: db.url });
    expect(result.migrated).toBe(true);
    expect(result.counts).toMatchObject({
      users: 1, identities: 1, saves: 1, config: 1, config_history: 2,
      minigame_sessions: 1, live_events: 1, event_participation: 1,
    });

    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      const identity = (await client.query('SELECT * FROM identities WHERE user_id = $1', ['github:modern1'])).rows[0];
      // A real (not synthesized) identity row must round-trip its
      // supertokens_user_id and last_login_at, unlike the legacy path where
      // both are always null.
      expect(identity.supertokens_user_id).toBe('st-abc');
      expect(identity.last_login_at).toBe(1_700_000_001_000);

      const history = (await client.query('SELECT version, data, updated_at, updated_by FROM config_history ORDER BY version')).rows;
      expect(history).toHaveLength(2);
      expect(history[0].data).toBe('{"tick":0}'); // byte-exact JSON text
      expect(history[1].updated_by).toBe('github:modern1');

      const event = (await client.query('SELECT * FROM live_events WHERE id = $1', ['evt-1'])).rows[0];
      expect(event.modifiers).toBe('[]');
      expect(event.starts_at).toBe(1_700_000_000_000);

      const participation = (await client.query('SELECT * FROM event_participation WHERE event_id = $1', ['evt-1'])).rows[0];
      expect(participation.rungs_claimed).toBe(5);

      const session = (await client.query('SELECT * FROM minigame_sessions WHERE id = $1', ['sess-1'])).rows[0];
      expect(session.score).toBe(42);
    } finally {
      await client.end();
    }
  });

  it('preserves config_history insertion order through the target BIGSERIAL id, not sorted by version', async () => {
    // Postgres's config_history.id is a BIGSERIAL assigned in insertion
    // order; the admin rollback UI reads history back `ORDER BY id DESC`.
    // `id` itself is excluded from verifyMigration's fingerprint on both
    // sides (SQLite's config_history has no id column at all), so a
    // reordering bug here would be silently unverifiable - this has to be
    // checked directly. Inserted deliberately out of version order (5, 1,
    // 3) so "happens to match a sort" can't be mistaken for "order
    // survived".
    const { applySchema } = await import('../server/db/schema.sqlite.js');
    const raw = new Database(':memory:');
    await applySchema(raw);
    raw.prepare('INSERT INTO users (id, username, avatar_url, created_at) VALUES (?,?,?,?)')
      .run('github:order1', 'orderuser', null, 1_700_000_000_000);
    raw.prepare('INSERT INTO config_history (version, data, updated_at, updated_by) VALUES (?,?,?,?)')
      .run(5, '{"n":"fifth"}', 1_700_000_000_100, null);
    raw.prepare('INSERT INTO config_history (version, data, updated_at, updated_by) VALUES (?,?,?,?)')
      .run(1, '{"n":"first"}', 1_700_000_000_200, null);
    raw.prepare('INSERT INTO config_history (version, data, updated_at, updated_by) VALUES (?,?,?,?)')
      .run(3, '{"n":"third"}', 1_700_000_000_300, null);

    const tmp = path.join(os.tmpdir(), `migrate-history-order-${Date.now()}.db`);
    scratchFiles.push(tmp);
    await raw.backup(tmp);
    raw.close();

    const result = await migrateSqliteToPostgres({ sqlitePath: tmp, databaseUrl: db.url });
    expect(result.migrated).toBe(true);

    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      const rows = (await client.query('SELECT version, data FROM config_history ORDER BY id ASC')).rows;
      expect(rows.map((r) => r.version)).toEqual([5, 1, 3]);
      expect(rows.map((r) => r.data)).toEqual(['{"n":"fifth"}', '{"n":"first"}', '{"n":"third"}']);
    } finally {
      await client.end();
    }
  });

  describe('refuses rather than silently dropping unaccounted-for data', () => {
    it('refuses when a source column has no home in the target schema and is not on the allowed-drop list', async () => {
      // provider/provider_id on users are the one intentional, allow-listed
      // drop (see ALLOWED_DROPPED_COLUMNS). Anything else the target schema
      // doesn't recognize would otherwise be dropped with only a log line -
      // and, worse, excluded from verifyMigration's fingerprint too (it only
      // compares columns both sides share), making the loss unverifiable.
      // For a one-shot run against irreplaceable data, refuse-and-explain is
      // the only acceptable default.
      const tmp = scratchCopy();
      const raw = new Database(tmp);
      raw.exec('ALTER TABLE users ADD COLUMN favorite_color TEXT');
      raw.exec("UPDATE users SET favorite_color = 'teal' WHERE id = 'github:37058311'");
      raw.close();

      await expect(migrateSqliteToPostgres({ sqlitePath: tmp, databaseUrl: db.url }))
        .rejects.toThrow(/favorite_color/);

      // Refused before COMMIT (users is the first table in TABLES, so this
      // throws before any row - for any table - is ever inserted): nothing
      // landed at all, not a partial import of the other, unaffected tables.
      const client = new pg.Client({ connectionString: db.url });
      await client.connect();
      try {
        const { rows } = await client.query('SELECT count(*)::int AS n FROM users');
        expect(rows[0].n).toBe(0);
      } finally {
        await client.end();
      }
    });

    it('refuses when the source has a table this migrator does not know about, before ever opening a transaction', async () => {
      // A table added to the app's schema in a future release and never
      // added to TABLES would otherwise be invisible to this migrator -
      // never read, never inserted, never verified - while the migration
      // still COMMITs and reports success. Checked via sqlite_master, so it
      // catches a table this migrator has simply never heard of, not just a
      // column mismatch on a table it does know about.
      const tmp = scratchCopy();
      const raw = new Database(tmp);
      raw.exec('CREATE TABLE achievements_unlocked (user_id TEXT, achievement_id TEXT)');
      raw.close();

      await expect(migrateSqliteToPostgres({ sqlitePath: tmp, databaseUrl: db.url }))
        .rejects.toThrow(/achievements_unlocked/);

      // This check runs before BEGIN - confirm no transaction was ever
      // opened by checking the target is still completely untouched, and
      // that a normal run against the (unmodified) fixture right after
      // still succeeds - proving neither the sqlite handle nor the pg pool
      // was left in a bad state by the refusal.
      const client = new pg.Client({ connectionString: db.url });
      await client.connect();
      try {
        const { rows } = await client.query('SELECT count(*)::int AS n FROM users');
        expect(rows[0].n).toBe(0);
      } finally {
        await client.end();
      }

      const result = await migrateSqliteToPostgres({ sqlitePath: FIXTURE, databaseUrl: db.url });
      expect(result.migrated).toBe(true);
    });
  });

  it('logs every username rename at [migrate] level, not just applies it silently', async () => {
    const tmp = scratchCopy();
    const raw = new Database(tmp);
    raw.exec("UPDATE users SET username = 'Neo' WHERE id = 'github:37058311'");
    raw.prepare(`
      INSERT INTO users (id, provider, provider_id, username, avatar_url, created_at)
      VALUES ('github:dup3', 'github', 'dup3', 'neo', NULL, 1784859388999)
    `).run();
    raw.close();

    const lines = [];
    const logger = { log: (...args) => lines.push(args.join(' ')), error: (...args) => lines.push(args.join(' ')) };

    const result = await migrateSqliteToPostgres({ sqlitePath: tmp, databaseUrl: db.url, logger });
    expect(result.migrated).toBe(true);
    expect(lines.some((l) => /renamed duplicate username for github:dup3 -> 'neo-2'/.test(l))).toBe(true);
  });

  it('falls back to logger.log when a caller-supplied logger has no .error, instead of masking the real failure with a TypeError', async () => {
    // Task 7 is expected to pass a boot-time logger in-process rather than
    // run this as a CLI - a minimal { log } logger with no .error is
    // plausible there. Without the fallback, the ROLLBACK catch block's own
    // `logger.error(...)` call would throw a TypeError that replaces the
    // real verification failure as the rejection the caller sees.
    const lines = [];
    const logger = { log: (...args) => lines.push(args.join(' ')) }; // no .error

    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    const { applySchema } = await import('../server/db/schema.pg.js');
    await applySchema(client);
    await client.query(`
      CREATE OR REPLACE FUNCTION migrate_test_corrupt_saves_2() RETURNS trigger AS $$
      BEGIN
        NEW.data := '{"wafers":0}';
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER migrate_test_corrupt_saves_2_trigger BEFORE INSERT ON saves
      FOR EACH ROW EXECUTE FUNCTION migrate_test_corrupt_saves_2();
    `);

    try {
      await expect(migrateSqliteToPostgres({ sqlitePath: FIXTURE, databaseUrl: db.url, logger }))
        .rejects.toThrow(/verification failed/i); // not a TypeError about .error
      expect(lines.some((l) => /ROLLED BACK/.test(l))).toBe(true);
    } finally {
      await client.query(`
        DROP TRIGGER IF EXISTS migrate_test_corrupt_saves_2_trigger ON saves;
        DROP FUNCTION IF EXISTS migrate_test_corrupt_saves_2();
      `);
      await client.end();
    }
  });

  it('never modifies or deletes the source SQLite file beyond the WAL checkpoint', async () => {
    const tmp = scratchCopy();
    const statBefore = fs.statSync(tmp);
    const contentBefore = fs.readFileSync(tmp);

    await migrateSqliteToPostgres({ sqlitePath: tmp, databaseUrl: db.url });

    expect(fs.existsSync(tmp)).toBe(true);
    const contentAfter = fs.readFileSync(tmp);
    expect(contentAfter.equals(contentBefore)).toBe(true);
    expect(fs.statSync(tmp).size).toBe(statBefore.size);
  });
});
