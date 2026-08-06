// Shadow mode is the gate that clears the cutover, so the two things it must
// never do are: report PASS when it should not, and write anything.
//
// The no-write property gets a snapshot of the entire identities table taken
// around a run and compared byte-for-byte, rather than a check that the one
// row under test is unchanged. The point of shadow mode is that it can be run
// against a live production database while people are playing, and "the row I
// looked at is fine" is not that guarantee.

import { describe, it, expect, afterAll } from 'vitest';
import { provisionDatabase } from './helpers/backend.js';

const provisioned = await provisionDatabase();

const dbMod = await import('../server/db.js');
const { driver, upsertUser } = dbMod;

const {
  compareIdentity, summarise, formatSummary, formatResult, createShadowRun,
  auditStoredIdentities,
  SHADOW_MATCH, SHADOW_MISMATCH, SHADOW_NO_IDENTITY,
} = await import('../server/supertokens/shadow.js');

afterAll(async () => {
  if (driver.__backend === 'pg') await driver.__raw.end();
  await provisioned.cleanup();
});

async function snapshotIdentities() {
  const sql = 'SELECT provider, provider_id, user_id, supertokens_user_id, created_at, last_login_at '
    + 'FROM identities ORDER BY provider, provider_id';
  const rows = driver.__backend === 'sqlite'
    ? driver.__raw.prepare(sql).all()
    : (await driver.__raw.query(sql)).rows;
  return JSON.stringify(rows);
}

describe('shadow-mode comparison', () => {
  it('reports a match when the stored identity is what SuperTokens implies', async () => {
    await upsertUser({
      provider: 'github', providerId: '37058311', username: 'nec', avatarUrl: null,
    });

    const result = await compareIdentity({ thirdPartyId: 'github', thirdPartyUserId: '37058311' });
    expect(result.outcome).toBe(SHADOW_MATCH);
    expect(result.expectedUserId).toBe('github:37058311');
    expect(result.actualUserId).toBe('github:37058311');
  });

  it('reports a mismatch when identities points at a different user', async () => {
    // The shape that would actually bite: an identity row whose user_id is not
    // `provider:provider_id`. Written directly, because upsertUser cannot
    // produce it - which is the point, since the rows this gate examines were
    // written by older code, not by today's.
    const now = Date.now();
    await upsertUser({
      provider: 'discord', providerId: 'legacy-owner', username: 'legacy', avatarUrl: null,
    });
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

    const result = await compareIdentity({ thirdPartyId: 'discord', thirdPartyUserId: 'odd-shape' });
    expect(result.outcome).toBe(SHADOW_MISMATCH);
    expect(result.expectedUserId).toBe('discord:odd-shape');
    expect(result.actualUserId).toBe('discord:legacy-owner');
  });

  it('reports no-identity for a player who has never logged in, and does not call it a mismatch', async () => {
    const result = await compareIdentity({ thirdPartyId: 'github', thirdPartyUserId: 'never-seen' });
    expect(result.outcome).toBe(SHADOW_NO_IDENTITY);
    expect(result.actualUserId).toBeNull();
    // Conflating this with a mismatch would make the gate unreadable on any
    // server that has ever had a new signup.
    expect(result.outcome).not.toBe(SHADOW_MISMATCH);
  });

  it('writes absolutely nothing - the whole identities table is unchanged', async () => {
    // Table-wide, not row-wide. Shadow mode's entire value is that it is safe
    // to point at production while people are playing.
    const before = await snapshotIdentities();

    const run = createShadowRun({ log: () => {} });
    await run.record({ thirdPartyId: 'github', thirdPartyUserId: '37058311' });
    await run.record({ thirdPartyId: 'discord', thirdPartyUserId: 'odd-shape' });
    await run.record({ thirdPartyId: 'github', thirdPartyUserId: 'never-seen' });

    expect(await snapshotIdentities()).toBe(before);
  });
});

describe('the offline audit (the form the gate actually runs before cutover)', () => {
  it('audits every stored identity without a single login happening', async () => {
    // This is what `npm run shadow:check` does against the owner's export. It
    // needs no SuperTokens core, no login, and no cutover - which is the point,
    // since a gate you can only open after walking through the door is not a
    // gate.
    const results = await auditStoredIdentities();
    expect(results.length).toBeGreaterThan(0);

    // The deliberately-odd row inserted above must be caught.
    const odd = results.find((r) => r.thirdPartyUserId === 'odd-shape');
    expect(odd).toBeDefined();
    expect(odd.outcome).toBe(SHADOW_MISMATCH);
    expect(odd.actualUserId).toBe('discord:legacy-owner');

    // ...and the normal rows must not be.
    const good = results.find((r) => r.thirdPartyUserId === '37058311');
    expect(good.outcome).toBe(SHADOW_MATCH);
  });

  it('writes nothing while auditing', async () => {
    const before = await snapshotIdentities();
    await auditStoredIdentities();
    expect(await snapshotIdentities()).toBe(before);
  });

  it('never reports no-identity - every row it reads exists by construction', async () => {
    // Distinguishes the audit from the per-login path. Reading rows out of the
    // table cannot produce a "this player does not exist" outcome, so a
    // no-identity here would mean the enumeration had gone wrong.
    const results = await auditStoredIdentities();
    expect(results.some((r) => r.outcome === SHADOW_NO_IDENTITY)).toBe(false);
  });

  it('fails the gate on a real database containing a bad row', async () => {
    // End to end: audit this database, summarise, and confirm the operator is
    // told not to cut over - and told which pair is the problem.
    const summary = summarise(await auditStoredIdentities());
    expect(summary.passed).toBe(false);
    const report = formatSummary(summary);
    expect(report).toContain('GATE: FAIL');
    expect(report).toContain('odd-shape');
  });
});

describe('the gate', () => {
  const match = { outcome: SHADOW_MATCH, thirdPartyId: 'github', thirdPartyUserId: '1', expectedUserId: 'github:1', actualUserId: 'github:1' };
  const mismatch = { outcome: SHADOW_MISMATCH, thirdPartyId: 'github', thirdPartyUserId: '2', expectedUserId: 'github:2', actualUserId: 'github:other' };
  const missing = { outcome: SHADOW_NO_IDENTITY, thirdPartyId: 'github', thirdPartyUserId: '3', expectedUserId: 'github:3', actualUserId: null };

  it('passes only on 100% of comparable logins', () => {
    expect(summarise([match, match]).passed).toBe(true);
    expect(summarise([match, mismatch]).passed).toBe(false);
    // A single mismatch among many matches is still a fail - 99% is a player.
    expect(summarise([match, match, match, match, mismatch]).passed).toBe(false);
  });

  it('does NOT pass an empty run', () => {
    // The vacuous-pass trap. An empty run has a 100% match rate by arithmetic,
    // and a gate that reports PASS because it compared nothing manufactures
    // exactly the false confidence it exists to prevent.
    const summary = summarise([]);
    expect(summary.passed).toBe(false);
    expect(summary.matchRate).toBeNull();
    expect(formatSummary(summary)).toContain('NOT RUN');
    expect(formatSummary(summary)).not.toContain('PASS -');
  });

  it('does not let new players drag the rate down or prop it up', () => {
    // no-identity rows are excluded from the rate entirely: they are neither
    // evidence for nor against the id-shape assumption.
    const summary = summarise([match, missing, missing]);
    expect(summary.matchRate).toBe(1);
    expect(summary.noIdentity).toBe(2);
    expect(summary.passed).toBe(true);

    const failing = summarise([match, mismatch, missing]);
    expect(failing.matchRate).toBe(0.5);
    expect(failing.passed).toBe(false);
  });

  it('names every mismatching pair in the report rather than burying a percentage', () => {
    const report = formatSummary(summarise([match, mismatch]));
    expect(report).toContain('GATE: FAIL');
    expect(report).toContain('github:2');
    expect(report).toContain('github:other');
    expect(report).toContain('wrong save');
  });

  it('says PASS in words, not just as a number', () => {
    const report = formatSummary(summarise([match, match]));
    expect(report).toContain('GATE: PASS');
    expect(report).toContain('100.00%');
  });

  it('logs one legible line per login', () => {
    expect(formatResult(match)).toContain('MATCH');
    expect(formatResult(mismatch)).toContain('MISMATCH');
    expect(formatResult(mismatch)).toContain('WRONG save');
    expect(formatResult(missing)).toContain('not a failure');
  });

  it('collects a run end to end', async () => {
    const logged = [];
    const run = createShadowRun({ log: (line) => logged.push(line) });
    await run.record({ thirdPartyId: 'github', thirdPartyUserId: '37058311' });
    await run.record({ thirdPartyId: 'discord', thirdPartyUserId: 'odd-shape' });

    expect(logged).toHaveLength(2);
    const summary = run.summary();
    expect(summary.total).toBe(2);
    expect(summary.matched).toBe(1);
    expect(summary.mismatched).toBe(1);
    expect(summary.passed).toBe(false);
    expect(run.report()).toContain('GATE: FAIL');
  });
});
