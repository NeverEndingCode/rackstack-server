// maybeAutoMigrate is the boot-time guard server/index.js awaits before
// buildApp(): migrate only when DATABASE_URL is set, a SQLite file exists,
// and the target Postgres database is still empty. Its actual migration
// work is delegated to migrateSqliteToPostgres (fully covered by
// migrate.test.js) - this suite is only about the guard matrix itself: does
// it correctly decide *whether* to call that function, using a caller-
// supplied `env` rather than the real process.env so the "unset" and
// "absent file" branches can be exercised without touching real state.
//
// Postgres-only by nature, same as migrate.test.js: the "migrates" case
// needs a real empty target to migrate into, and skipping the whole file
// under TEST_BACKEND=sqlite (rather than skipping just that one test) keeps
// this suite's shape identical to migrate.test.js's.
import {
  describe, it, expect, beforeEach, afterEach,
} from 'vitest';
import path from 'path';
import { provisionDatabase } from './helpers/backend.js';
import { maybeAutoMigrate, describeFatalMigrationError } from '../server/db/migrate.js';

const skip = process.env.TEST_BACKEND === 'sqlite';

const FIXTURE = path.resolve('tests/fixtures/v11-sqlite.db');

const silent = { log: () => {}, error: () => {} };

describe.skipIf(skip)('auto-migration guards', () => {
  let provisioned;
  beforeEach(async () => {
    provisioned = await provisionDatabase();
  });
  afterEach(async () => {
    await provisioned.cleanup();
  });

  it('does nothing when DATABASE_URL is unset', async () => {
    // env: {} - not process.env - is the point: provisionDatabase() just set
    // process.env.DATABASE_URL as a side effect, so this only proves the
    // guard reads the caller-supplied env if it also proves the result
    // doesn't fall through to that ambient value.
    const result = await maybeAutoMigrate({ env: {}, logger: silent });
    expect(result.migrated).toBe(false);
    expect(result.reason).toMatch(/DATABASE_URL/);
  });

  it('does nothing when the sqlite file is absent', async () => {
    const result = await maybeAutoMigrate({
      env: { DATABASE_URL: provisioned.url, DB_PATH: '/nonexistent/x.db' }, logger: silent,
    });
    expect(result.migrated).toBe(false);
    expect(result.reason).toMatch(/no sqlite/i);
  });

  it('migrates when postgres is empty and a sqlite file exists', async () => {
    const result = await maybeAutoMigrate({
      env: { DATABASE_URL: provisioned.url, DB_PATH: FIXTURE }, logger: silent,
    });
    expect(result.migrated).toBe(true);
    expect(result.counts.users).toBe(2);
  });

  it('does nothing when postgres already has data, even though DATABASE_URL is set and the sqlite file exists', async () => {
    // Distinguishes "migrates whenever the first two guards pass" from the
    // full guard matrix promised by the brief (DATABASE_URL set AND sqlite
    // file exists AND postgres empty) - a naive implementation that skips
    // the emptiness check (it's delegated to migrateSqliteToPostgres, but a
    // bug could bypass that call entirely) would wrongly re-migrate here.
    const first = await maybeAutoMigrate({
      env: { DATABASE_URL: provisioned.url, DB_PATH: FIXTURE }, logger: silent,
    });
    expect(first.migrated).toBe(true);

    const second = await maybeAutoMigrate({
      env: { DATABASE_URL: provisioned.url, DB_PATH: FIXTURE }, logger: silent,
    });
    expect(second.migrated).toBe(false);
    expect(second.reason).toMatch(/not empty/i);
  });
});

// server/index.js's fatal-boot catch block logs this string as the *only*
// signal an operator gets when the server refuses to start over live save
// data - so it must never come out blank. A pure function, not gated by
// TEST_BACKEND: it touches neither SQLite nor Postgres, and the bug it
// guards against (a real Postgres connection-refused surfacing as Node's
// own AggregateError, whose .message is always '' - the detail lives on
// .errors instead) has nothing backend-specific about it.
describe('describeFatalMigrationError', () => {
  it('returns e.message for an ordinary Error', () => {
    expect(describeFatalMigrationError(new Error('checkpoint was blocked'))).toBe('checkpoint was blocked');
  });

  it('falls back to the joined .errors messages for an AggregateError, whose own .message is blank', () => {
    // This is the exact shape a connection-refused Postgres produces
    // through `pg`/Node's networking stack - confirmed by hand against a
    // real ECONNREFUSED in server/index.js's manual smoke test, not
    // guessed. `new AggregateError([...]).message` is '' unless a second
    // constructor argument is passed, which nothing in the `pg` codepath
    // does.
    const inner = new Error('connect ECONNREFUSED 127.0.0.1:1');
    const agg = new AggregateError([inner], '');
    expect(agg.message).toBe(''); // the premise this test depends on
    const described = describeFatalMigrationError(agg);
    expect(described).not.toBe('');
    expect(described).toMatch(/ECONNREFUSED/);
  });

  it('falls back to String(e) rather than an empty string when neither .message nor .errors has anything usable', () => {
    const weird = new AggregateError([], '');
    const described = describeFatalMigrationError(weird);
    expect(described).not.toBe('');
  });
});
