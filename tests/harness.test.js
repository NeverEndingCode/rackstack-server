import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { provisionDatabase } from './helpers/backend.js';

const provisioned = await provisionDatabase();
afterAll(() => provisioned.cleanup());

describe('test harness', () => {
  it('provisions an isolated database for the configured backend', async () => {
    if (provisioned.backend === 'sqlite') {
      expect(provisioned.path).toBe(':memory:');
      return;
    }
    const client = new pg.Client({ connectionString: provisioned.url });
    await client.connect();
    const { rows } = await client.query('SELECT 1 AS ok');
    expect(rows[0].ok).toBe(1);
    await client.end();
  });

  // Regression test for a Critical Task 4 review finding: an ambient
  // DATABASE_URL (the most likely env var to be exported while working on
  // this migration, and the one Task 8 documents setting for production)
  // must not silently redirect a "sqlite" test run at a real database.
  // Before this fix, provisionDatabase()'s sqlite branch never touched
  // DATABASE_URL, and server/db/index.js checks DATABASE_URL *before*
  // DB_PATH - so a stray value here would have routed every db-touching
  // suite at whatever DATABASE_URL pointed to, writing real rows and
  // reporting green while never exercising SQLite at all.
  it.runIf(provisioned.backend === 'sqlite')(
    'clears an ambient DATABASE_URL, so the facade resolves to sqlite rather than attempting a Postgres connection',
    async () => {
      // db.invalid is a reserved TLD (RFC 2606) guaranteed to fail DNS
      // resolution immediately - if this regresses, the test fails fast
      // with a connection error instead of hanging for the suite timeout.
      process.env.DATABASE_URL = 'postgresql://bogus@db.invalid:5432/nope';

      const second = await provisionDatabase();
      expect(second.backend).toBe('sqlite');
      expect(process.env.DATABASE_URL).toBeUndefined();

      // End-to-end: the facade itself must resolve to the sqlite driver,
      // not hang or throw trying to reach db.invalid. This is the first
      // import of the facade in this file, so it's a genuine fresh
      // module-evaluation, not a cached result from an earlier import.
      const dbMod = await import('../server/db/index.js');
      expect(dbMod.driver.__backend).toBe('sqlite');
    },
  );
});
