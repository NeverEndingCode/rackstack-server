process.env.DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret-social-state';

import { describe, it, expect } from 'vitest';

const { upsertUser, putSave, getSave } = await import('../server/db.js');
const { ensureConfig } = await import('../server/configService.js');
const { loadAndEvaluate } = await import('../server/stateService.js');
const { initialState } = await import('../shared/state.js');
const { utcDateKey } = await import('../shared/daily.js');

ensureConfig();

let seq = 0;
function makeUser() {
  seq += 1;
  return upsertUser({
    provider: 'discord', providerId: `soc${seq}`, username: `socuser${seq}`, avatarUrl: null,
  });
}

describe('contracts roll over on the load path', () => {
  it("populates today's board for a user who has never had one", () => {
    const u = makeUser();
    const now = Date.now();
    const { state } = loadAndEvaluate(u.id, now);
    expect(state.meta.contracts.dateKey).toBe(utcDateKey(now));
    expect(state.meta.contracts.targets).toHaveLength(3);
  });

  it('persists the rolled-over board, so a reload sees the same targets', () => {
    const u = makeUser();
    const now = Date.now();
    const first = loadAndEvaluate(u.id, now).state;
    const second = loadAndEvaluate(u.id, now + 60_000).state;
    expect(second.meta.contracts.dateKey).toBe(first.meta.contracts.dateKey);
    expect(second.meta.contracts.targets).toEqual(first.meta.contracts.targets);
    expect(JSON.parse(getSave(u.id).data).meta.contracts.dateKey).toBe(first.meta.contracts.dateKey);
  });

  it('rolls over and clears claims when the UTC day advances', () => {
    const u = makeUser();
    const now = Date.now();
    const first = loadAndEvaluate(u.id, now).state;
    first.meta.contracts.claimed = [true, true, true];
    putSave(u.id, first, now);
    const next = loadAndEvaluate(u.id, now + 24 * 3600 * 1000).state;
    expect(next.meta.contracts.dateKey).not.toBe(first.meta.contracts.dateKey);
    expect(next.meta.contracts.claimed).toEqual([false, false, false]);
  });
});

describe('achievements unlock from offline accrual', () => {
  it('sweeps after evaluate, so a threshold crossed while away unlocks on next load', () => {
    const u = makeUser();
    const now = Date.now();
    const s = initialState();
    s.meta.stats.lifetimeFlopsAllTime = 1e9; // 'flops_g' condition met
    putSave(u.id, s, now);
    const { state, unlockedAchievements } = loadAndEvaluate(u.id, now + 1000);
    expect(state.meta.achievements.flops_g).toBeDefined();
    expect(unlockedAchievements).toContain('flops_g');
  });

  it('reports nothing on a subsequent load once already held', () => {
    const u = makeUser();
    const now = Date.now();
    const s = initialState();
    s.meta.stats.singularities = 1;
    putSave(u.id, s, now);
    loadAndEvaluate(u.id, now + 1000);
    const { unlockedAchievements } = loadAndEvaluate(u.id, now + 2000);
    expect(unlockedAchievements).toEqual([]);
  });
});
