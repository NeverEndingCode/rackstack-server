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
    raw.close();

    // Never modified beyond the checkpoint, never deleted - the operator's
    // rollback artifact must still be exactly where it was.
    expect(fs.existsSync(tmp)).toBe(true);
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
