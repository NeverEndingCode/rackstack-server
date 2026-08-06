process.env.JWT_SECRET = 'test-secret-concurrency';

import { describe, it, expect, afterAll } from 'vitest';
import { provisionDatabase } from './helpers/backend.js';

// Provision before importing the facade: DATABASE_URL/DB_PATH must be set
// before the dynamic import below, since the facade resolves its driver at
// module-evaluation time.
const provisioned = await provisionDatabase();

const { upsertUser, getSave, driver } = await import('../server/db.js');
const { ensureConfig } = await import('../server/configService.js');
const { loadAndEvaluate, applyActions } = await import('../server/stateService.js');

await ensureConfig();

afterAll(async () => {
  if (driver.__backend === 'pg') await driver.__raw.end();
  await provisioned.cleanup();
});

let seq = 0;
async function makeUser() {
  seq += 1;
  return await upsertUser({
    provider: 'discord', providerId: `conc${seq}`, username: `concuser${seq}`, avatarUrl: null,
  });
}

// Regression coverage for the lost-update window that v1.7's sync->async
// refactor opened. Before v1.7 every db call was a synchronous better-sqlite3
// call, so `getSave -> evaluate -> putSave` ran to completion inside one
// event-loop turn and nothing could interleave with it. Making the interface
// async (Postgres cannot be synchronous) removed that, and two concurrent
// requests for one user - two open tabs is the normal case for an idle game -
// would each load the same state and the later putSave would silently discard
// the earlier one's work.
//
// These fail without server/userLock.js: each asserts that BOTH concurrent
// mutations survive, which is impossible if both callers evaluate against the
// same pre-write snapshot regardless of which write lands last.
describe('concurrent requests for one user do not lose writes', () => {
  it('keeps both mutations when two applyActions calls race', async () => {
    const u = await makeUser();
    const now = Date.now();

    // Two independent, always-successful actions touching disjoint parts of
    // meta, so a lost update shows up as a *missing* change rather than as an
    // ordering difference.
    const [streakRes, optOutRes] = await Promise.all([
      applyActions(u.id, [{ type: 'claimStreak' }], now),
      applyActions(u.id, [{ type: 'setLeaderboardOptOut', optOut: true }], now),
    ]);

    expect(streakRes.results[0].ok).toBe(true);
    expect(optOutRes.results[0].ok).toBe(true);

    const persisted = JSON.parse((await getSave(u.id)).data);
    expect(persisted.meta.streak.count).toBe(1);
    expect(persisted.meta.leaderboardOptOut).toBe(true);
  });

  it('does not let a concurrent loadAndEvaluate overwrite an action it never saw', async () => {
    const u = await makeUser();
    const now = Date.now();

    // GET /api/state persists too (it writes back the evaluated state), so an
    // unlocked read racing an action is just as destructive as two actions.
    //
    // The action is issued first and outnumbered by loads on purpose. A
    // single load racing a single action is NOT a discriminating test: the
    // action path does strictly more awaits, so its putSave lands last by
    // luck and the assertion passes even with the lock removed. With three
    // loads behind it, an unlocked run has a load - one that never saw the
    // opt-out - writing last.
    const [actionRes] = await Promise.all([
      applyActions(u.id, [{ type: 'setLeaderboardOptOut', optOut: true }], now),
      loadAndEvaluate(u.id, now),
      loadAndEvaluate(u.id, now),
      loadAndEvaluate(u.id, now),
    ]);

    expect(actionRes.results[0].ok).toBe(true);
    const persisted = JSON.parse((await getSave(u.id)).data);
    expect(persisted.meta.leaderboardOptOut).toBe(true);
  });

  it('applies a burst of actions cumulatively rather than collapsing them', async () => {
    const u = await makeUser();
    const now = Date.now();
    await loadAndEvaluate(u.id, now);

    // Only the first claim of the day can succeed; the rest must be rejected
    // by the reducer's own guard. If the calls interleaved, several would
    // evaluate against the same unclaimed state and all report ok - the
    // double-spend shape of the same bug.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => applyActions(u.id, [{ type: 'claimStreak' }], now)),
    );

    const succeeded = results.filter((r) => r.results[0].ok);
    expect(succeeded).toHaveLength(1);

    const persisted = JSON.parse((await getSave(u.id)).data);
    expect(persisted.meta.streak.count).toBe(1);
  });
});
