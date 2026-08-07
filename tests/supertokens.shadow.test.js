// Shadow mode is the gate that clears the cutover, so the things it must never
// do are: report PASS when it should not, miss a corruption it claims to cover,
// and write anything.
//
// The v1.8 final review found it doing all three. The tests below are written
// against those specific failures rather than around them:
//
//   - The no-write property is now asserted against the OPERATOR ENTRY POINT in
//     a fresh process, on a pre-v1.7 database. The old test snapshotted the
//     table from inside a process whose db facade had *already* migrated it, so
//     the very writes it existed to catch had happened before it looked.
//   - Orphaned identity rows (user_id pointing at no user) get an explicit
//     outcome, because the old enumeration walked users -> identities and
//     could not see them at all.
//   - A run of nothing but new players must not pass.

import { describe, it, expect, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { provisionDatabase } from './helpers/backend.js';

const execFileAsync = promisify(execFile);
const provisioned = await provisionDatabase();

const dbMod = await import('../server/db.js');
const { driver, upsertUser } = dbMod;

const {
  compareIdentity, summarise, formatSummary, formatResult, createShadowRun,
  auditStoredIdentities, classifyIdentityRow,
  SHADOW_MATCH, SHADOW_MISMATCH, SHADOW_NO_IDENTITY, SHADOW_ORPHAN,
} = await import('../server/supertokens/shadow.js');

const scratchDirs = [];

afterAll(async () => {
  if (driver.__backend === 'pg') await driver.__raw.end();
  await provisioned.cleanup();
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------- live check

describe('the live per-login comparison (runbook C4)', () => {
  it('reports a match when the stored identity is what SuperTokens implies', async () => {
    await upsertUser({
      provider: 'github', providerId: '37058311', username: 'nec', avatarUrl: null,
    });
    const result = await compareIdentity(
      { thirdPartyId: 'github', thirdPartyUserId: '37058311' }, dbMod,
    );
    expect(result.outcome).toBe(SHADOW_MATCH);
    expect(result.actualUserId).toBe('github:37058311');
  });

  it('reports a mismatch when identities points at a different user', async () => {
    const now = Date.now();
    await upsertUser({
      provider: 'discord', providerId: 'legacy-owner', username: 'legacy', avatarUrl: null,
    });
    // Written directly, because upsertUser cannot produce this shape - which is
    // the point: the rows this gate examines were written by older code.
    if (driver.__backend === 'sqlite') {
      driver.__raw.prepare(
        'INSERT INTO identities (provider, provider_id, user_id, created_at) VALUES (?, ?, ?, ?)',
      ).run('discord', 'odd-shape', 'discord:legacy-owner', now);
    } else {
      await driver.__raw.query(
        'INSERT INTO identities (provider, provider_id, user_id, created_at) VALUES ($1, $2, $3, $4)',
        ['discord', 'odd-shape', 'discord:legacy-owner', now],
      );
    }

    const result = await compareIdentity(
      { thirdPartyId: 'discord', thirdPartyUserId: 'odd-shape' }, dbMod,
    );
    expect(result.outcome).toBe(SHADOW_MISMATCH);
    expect(result.expectedUserId).toBe('discord:odd-shape');
    expect(result.actualUserId).toBe('discord:legacy-owner');
  });

  it('reports no-identity for a player who has never logged in, and does not call it a mismatch', async () => {
    const result = await compareIdentity(
      { thirdPartyId: 'github', thirdPartyUserId: 'never-seen' }, dbMod,
    );
    expect(result.outcome).toBe(SHADOW_NO_IDENTITY);
    expect(result.actualUserId).toBeNull();
    expect(result.outcome).not.toBe(SHADOW_MISMATCH);
  });

  it('collects a run end to end', async () => {
    const logged = [];
    const run = createShadowRun({ db: dbMod, log: (line) => logged.push(line) });
    await run.record({ thirdPartyId: 'github', thirdPartyUserId: '37058311' });
    await run.record({ thirdPartyId: 'discord', thirdPartyUserId: 'odd-shape' });

    expect(logged).toHaveLength(2);
    const summary = run.summary();
    expect(summary.matched).toBe(1);
    expect(summary.mismatched).toBe(1);
    expect(summary.passed).toBe(false);
    expect(run.report()).toContain('GATE: FAIL');
  });
});

// ------------------------------------------------------------- offline audit

describe('the offline audit (the gate itself)', () => {
  const rows = [
    { provider: 'github', provider_id: '1', user_id: 'github:1', user_exists: 1 },
    { provider: 'github', provider_id: '2', user_id: 'github:other', user_exists: 1 },
    { provider: 'discord', provider_id: '3', user_id: 'discord:3', user_exists: 0 },
  ];

  it('classifies match, mismatch and orphan from stored rows', async () => {
    const results = await auditStoredIdentities({
      readAllIdentities: async () => rows,
    });
    expect(results.map((r) => r.outcome)).toEqual([SHADOW_MATCH, SHADOW_MISMATCH, SHADOW_ORPHAN]);
  });

  it('SEES an identity row orphaned from users, and fails the gate on it', async () => {
    // The corruption the old enumeration could not reach. Such a player has a
    // login method but no account: resolveExternalUserId hands back a users.id
    // with no row, requireAuth refuses the session, and they can never log in.
    const orphanOnly = [{
      provider: 'github', provider_id: 'ghost', user_id: 'github:ghost', user_exists: 0,
    }];
    const summary = summarise(await auditStoredIdentities({
      readAllIdentities: async () => orphanOnly,
    }));

    expect(summary.orphaned).toBe(1);
    expect(summary.passed).toBe(false);
    const report = formatSummary(summary);
    expect(report).toContain('GATE: FAIL');
    expect(report).toContain('cannot log in');
    expect(report).toContain('github:ghost');
  });

  it('takes its rows from an injected reader, never from the db facade', async () => {
    // The structural half of the read-only guarantee: shadow.js has no import
    // that could reach a connection which runs applySchema. If this ever needs
    // a real driver to work, the safety property has been lost.
    let called = false;
    await auditStoredIdentities({
      readAllIdentities: async () => { called = true; return []; },
    });
    expect(called).toBe(true);
  });
});

describe('the gate arithmetic', () => {
  const match = { outcome: SHADOW_MATCH, thirdPartyId: 'github', thirdPartyUserId: '1', expectedUserId: 'github:1', actualUserId: 'github:1' };
  const mismatch = { outcome: SHADOW_MISMATCH, thirdPartyId: 'github', thirdPartyUserId: '2', expectedUserId: 'github:2', actualUserId: 'github:other' };
  const orphan = { outcome: SHADOW_ORPHAN, thirdPartyId: 'github', thirdPartyUserId: '4', expectedUserId: 'github:4', actualUserId: 'github:4' };
  const missing = { outcome: SHADOW_NO_IDENTITY, thirdPartyId: 'github', thirdPartyUserId: '3', expectedUserId: 'github:3', actualUserId: null };

  it('passes only on 100% of comparable identities', () => {
    expect(summarise([match, match]).passed).toBe(true);
    expect(summarise([match, mismatch]).passed).toBe(false);
    expect(summarise([match, match, match, match, mismatch]).passed).toBe(false);
    expect(summarise([match, orphan]).passed).toBe(false);
  });

  it('does NOT pass an empty run', () => {
    const summary = summarise([]);
    expect(summary.passed).toBe(false);
    expect(summary.matchRate).toBeNull();
    expect(formatSummary(summary)).toContain('NOT RUN');
  });

  it('does NOT pass a run of nothing but new players', () => {
    // The vacuous pass the v1.8 final review found: `passed` gated on the
    // TOTAL result count rather than the comparable one, so three no-identity
    // results printed "100% of comparable logins matched" having compared
    // none. Realistic, too - it is what an operator shadow-testing with a
    // fresh throwaway account produces.
    const summary = summarise([missing, missing, missing]);
    expect(summary.comparable).toBe(0);
    expect(summary.matchRate).toBeNull();
    expect(summary.passed).toBe(false);
    expect(formatSummary(summary)).toContain('NOT RUN');
    expect(formatSummary(summary)).not.toContain('GATE: PASS');
  });

  it('does not let new players drag the rate down or prop it up', () => {
    const summary = summarise([match, missing, missing]);
    expect(summary.matchRate).toBe(1);
    expect(summary.noIdentity).toBe(2);
    expect(summary.passed).toBe(true);

    const failing = summarise([match, mismatch, missing]);
    expect(failing.matchRate).toBe(0.5);
    expect(failing.passed).toBe(false);
  });

  it('names every offending pair rather than burying a percentage', () => {
    const report = formatSummary(summarise([match, mismatch, orphan]));
    expect(report).toContain('GATE: FAIL');
    expect(report).toContain('github:2');
    expect(report).toContain('github:other');
    expect(report).toContain('wrong save');
    expect(report).toContain('ORPHANS');
  });

  it('logs one legible line per outcome', () => {
    expect(formatResult(match)).toContain('MATCH');
    expect(formatResult(mismatch)).toContain('WRONG save');
    expect(formatResult(orphan)).toContain('cannot log in');
    expect(formatResult(missing)).toContain('not a failure');
  });

  it('classifyIdentityRow treats a missing user as orphan even when the id shape matches', () => {
    // Ordering inside the classifier matters: a row can be BOTH well-shaped and
    // orphaned, and the orphan is the more serious fact.
    expect(classifyIdentityRow({
      provider: 'github', provider_id: 'x', user_id: 'github:x', user_exists: 0,
    }).outcome).toBe(SHADOW_ORPHAN);
  });
});

// ------------------------------------------------- the no-write guarantee

describe('npm run shadow:check is genuinely read-only', () => {
  // Asserted against the OPERATOR ENTRY POINT, in a FRESH PROCESS, on a
  // PRE-v1.7 database - all three of which matter.
  //
  // The old test could not fail: it snapshotted the identities table from
  // inside a process whose db facade had already been imported, so applySchema
  // had already run and any damage predated the snapshot. And it ran against a
  // current-shape database, where applySchema mostly no-ops - while the
  // documented primary use is auditing a RESTORED PRE-v1.7 EXPORT, which is
  // exactly the case that triggers dedupeUsernames and the users rebuild.
  function makePreV17Database() {
    const dir = mkdtempSync(path.join(tmpdir(), 'rackstack-shadow-'));
    scratchDirs.push(dir);
    const file = path.join(dir, 'legacy.db');
    const raw = new Database(file);
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
      -- Case-variant usernames: legal before v1.7's unique index existed, and
      -- precisely what dedupeUsernames would rename.
      INSERT INTO users VALUES ('github:1','github','1','nec',NULL,1);
      INSERT INTO users VALUES ('discord:2','discord','2','NEC',NULL,2);
      INSERT INTO saves VALUES ('github:1','{"wafers":42}',1);
    `);
    raw.close();
    return { dir, file };
  }

  function snapshot(file) {
    const raw = new Database(file, { readonly: true });
    try {
      return JSON.stringify({
        users: raw.prepare('SELECT id, username FROM users ORDER BY id').all(),
        tables: raw.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        ).all().map((r) => r.name),
      });
    } finally {
      raw.close();
    }
  }

  it('does not rename users, create tables, or leave WAL sidecars behind', async () => {
    const { dir, file } = makePreV17Database();
    const before = snapshot(file);

    // A real subprocess: the writes happened at MODULE-EVALUATION time, so
    // nothing short of a separate process actually reproduces the bug.
    const result = await execFileAsync(
      process.execPath,
      [path.join(process.cwd(), 'server/supertokens/shadowCheck.js')],
      { env: { ...process.env, DB_PATH: file, DATABASE_URL: '' }, cwd: process.cwd() },
    ).catch((e) => e); // non-zero exit is expected - there are no identities

    const after = snapshot(file);
    expect(after, `shadow:check mutated the database.\n${result.stdout ?? ''}${result.stderr ?? ''}`)
      .toBe(before);

    // The pre-v1.7 shape must still be intact: no identities table conjured,
    // no users rebuild, and the colliding username untouched.
    const parsed = JSON.parse(after);
    expect(parsed.tables).toEqual(['saves', 'users']);
    expect(parsed.users.find((u) => u.id === 'discord:2').username).toBe('NEC');

    // journal_mode = WAL is itself a write to the file, and leaves sidecars.
    expect(existsSync(`${file}-wal`)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(['legacy.db']);
  });

  it('says so plainly when handed a pre-v1.7 export, rather than a raw SQL error', async () => {
    // Restoring the WRONG export is an easy mistake - the runbook just says
    // "a restored export" - and a pre-v1.7 one has no identities table at all.
    // The natural symptom would be "no such table: identities" from inside a
    // SELECT, which tells an operator nothing about what to do next.
    const { file } = makePreV17Database();
    const result = await execFileAsync(
      process.execPath,
      [path.join(process.cwd(), 'server/supertokens/shadowCheck.js')],
      { env: { ...process.env, DB_PATH: file, DATABASE_URL: '' }, cwd: process.cwd() },
    ).catch((e) => e);

    expect(result.code ?? 0).not.toBe(0);
    expect(`${result.stderr ?? ''}`).toContain('predates the v1.7 auth split');
  });

  it('reports NOT RUN, non-zero, on a v1.7-shaped database with no identity rows', async () => {
    // The empty-but-valid case: the gate must not read "clean" for a database
    // it compared nothing in. Distinct from the pre-v1.7 case above.
    const dir = mkdtempSync(path.join(tmpdir(), 'rackstack-shadow-'));
    scratchDirs.push(dir);
    const file = path.join(dir, 'empty.db');
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE identities (
        provider TEXT NOT NULL, provider_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id),
        supertokens_user_id TEXT UNIQUE, created_at INTEGER NOT NULL, last_login_at INTEGER,
        PRIMARY KEY (provider, provider_id)
      );
    `);
    raw.close();

    const result = await execFileAsync(
      process.execPath,
      [path.join(process.cwd(), 'server/supertokens/shadowCheck.js')],
      { env: { ...process.env, DB_PATH: file, DATABASE_URL: '' }, cwd: process.cwd() },
    ).catch((e) => e);

    expect(result.code ?? 0).not.toBe(0);
    expect(`${result.stdout ?? ''}`).toContain('NOT RUN');
    expect(`${result.stdout ?? ''}`).not.toContain('GATE: PASS');
  });

  it('refuses a database that does not exist instead of auditing an empty one it just created', async () => {
    // A typo'd DB_PATH used to create a fresh file, find nothing, and report -
    // which reads as "clean" to a tired operator. fileMustExist turns that into
    // an error.
    const dir = mkdtempSync(path.join(tmpdir(), 'rackstack-shadow-'));
    scratchDirs.push(dir);
    const missing = path.join(dir, 'nope.db');

    const result = await execFileAsync(
      process.execPath,
      [path.join(process.cwd(), 'server/supertokens/shadowCheck.js')],
      { env: { ...process.env, DB_PATH: missing, DATABASE_URL: '' }, cwd: process.cwd() },
    ).catch((e) => e);

    expect(result.code ?? 0).not.toBe(0);
    expect(existsSync(missing)).toBe(false);
  });
});
