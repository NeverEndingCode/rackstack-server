import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { initialState, evaluate } from '../shared/state.js';
import { goalCtx, GOAL_DEFS, REPEATABLE_DEFS } from '../shared/goals.js';
import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS } from '../shared/gameData.js';
import { computeMults, tierRate } from '../shared/gameRules.js';

const NOW = 1_000_000;

function buildState() {
  const s = initialState();
  s.run.tiers[0].owned = 5;
  s.run.tiers[1].manager = true;
  s.run.tiers[2].owned = 1;
  s.run.tiers[3].owned = 1;
  s.run.grid[0].owned = 3;
  s.run.grid[1].owned = 2;
  s.run.overclock[0].owned = 1;
  s.meta.legacyCores = 3;
  s.meta.stats.migrates = 1;
  s.meta.stats.minigamesWon = 1;
  s.meta.stats.singularities = 1;
  s.meta.upgrades.firmware = 1;
  return s;
}

describe('goalCtx', () => {
  it('computes totalOutputPerSec matching the v1.1 client formula (computeMults + tierRate per lane)', () => {
    const s = buildState();
    const { racksMult, gridMult, overclockMult, thresholds } = computeMults(s.meta, DEFAULT_CONFIG, 1);
    const racksOutput = s.run.tiers.reduce((sum, ts, i) => sum + tierRate(ts.owned, TIER_DEFS[i].baseProd, racksMult, thresholds), 0);
    const gridOutput = s.run.grid.reduce((sum, g, i) => sum + tierRate(g.owned, GRID_DEFS[i].baseProd, gridMult, thresholds), 0);
    const overclockOutput = s.run.overclock.reduce((sum, o, i) => sum + tierRate(o.owned, OVERCLOCK_DEFS[i].baseProd, overclockMult, thresholds), 0);
    const expected = racksOutput + gridOutput + overclockOutput;

    const ctx = goalCtx(s, DEFAULT_CONFIG, NOW);
    expect(ctx.totalOutputPerSec).toBeCloseTo(expected);
  });

  // v1.11: the Overclock lane no longer produces on its own - it multiplies
  // Racks. So a save with overclock nodes and NO racks now has nothing to
  // amplify and contributes nothing, which is why this test needs racks to
  // say anything at all. A live heat cooldown still zeroes the lane's
  // contribution, exactly as it zeroed its output before.
  it('overclock lane contributes 0 while a heat cooldown is active, and lifts Racks once cleared', () => {
    const s = initialState();
    s.run.tiers[0] = { id: 0, owned: 20, manager: true, ready: 0 };
    s.run.overclock[0].owned = 100;
    s.run.heatCooldownUntil = NOW + 5000;
    const onCooldown = goalCtx(s, DEFAULT_CONFIG, NOW);

    const s2 = structuredClone(s);
    s2.run.heatCooldownUntil = null;
    const normal = goalCtx(s2, DEFAULT_CONFIG, NOW);

    // Frozen: the racks lane alone. Cleared: strictly more than that.
    expect(onCooldown.totalOutputPerSec).toBeGreaterThan(0);
    expect(normal.totalOutputPerSec).toBeGreaterThan(onCooldown.totalOutputPerSec);
  });

  it('a lane with nothing to amplify contributes nothing (v1.11)', () => {
    const s = initialState();
    s.run.overclock[0].owned = 100;   // no racks owned
    expect(goalCtx(s, DEFAULT_CONFIG, NOW).totalOutputPerSec).toBe(0);
  });

  it('includes the active boost multiplier in totalOutputPerSec, and excludes it once expired', () => {
    const s = initialState();
    s.run.tiers[0].owned = 10;
    const unboosted = goalCtx(s, DEFAULT_CONFIG, NOW).totalOutputPerSec;

    s.server.boost = { mult: 3, until: NOW + 10000 };
    const boosted = goalCtx(s, DEFAULT_CONFIG, NOW).totalOutputPerSec;
    expect(boosted).toBeCloseTo(unboosted * 3);

    const afterExpiry = goalCtx(s, DEFAULT_CONFIG, NOW + 20000).totalOutputPerSec;
    expect(afterExpiry).toBeCloseTo(unboosted);
  });

  it('unlockedUpTo tracks contiguous owned tiers from index 0, matching the v1.1 client loop', () => {
    const s = initialState();
    s.run.tiers[0].owned = 1;
    s.run.tiers[1].owned = 1;
    s.run.tiers[2].owned = 0; // gap stops the scan
    s.run.tiers[3].owned = 1;
    const ctx = goalCtx(s, DEFAULT_CONFIG, NOW);
    expect(ctx.unlockedUpTo).toBe(2);
  });

  it('produces the same [cur, target] pair per goal def as the v1.1 client', () => {
    const s = buildState();
    const ctx = goalCtx(s, DEFAULT_CONFIG, NOW);
    const byId = Object.fromEntries(GOAL_DEFS.map((g) => [g.id, g.progress(ctx)]));

    expect(byId.g1).toEqual([5, 5]); // own 5 Spare Raspberry Pis
    expect(byId.g3).toEqual([1, 1]); // tier1 has a manager
    expect(byId.g4).toEqual([1, 1]); // Home NAS Tower (tier2) owned >= 1
    expect(byId.g5).toEqual([5, 5]); // grid sum 3 + 2
    expect(byId.g7).toEqual([0, 1]); // no tier owns >= 25 yet
    expect(byId.g8).toEqual([1, 1]); // migrates stat
    expect(byId.g9).toEqual([1, 1]); // minigamesWon stat
    expect(byId.g12).toEqual([3, 3]); // legacyCores
    expect(byId.g13).toEqual([1, 1]); // an upgrade has level > 0
    expect(byId.g15).toEqual([1, 1]); // overclock lane owned >= 1
    expect(byId.g16).toEqual([1, 1]); // singularities stat
  });

  it('produces matching metrics for repeatable defs', () => {
    const s = buildState();
    const ctx = goalCtx(s, DEFAULT_CONFIG, NOW);
    expect(REPEATABLE_DEFS.find((r) => r.id === 'r_racks').metric(ctx)).toBe(5);
    expect(REPEATABLE_DEFS.find((r) => r.id === 'r_grid').metric(ctx)).toBe(5);
    expect(REPEATABLE_DEFS.find((r) => r.id === 'r_overclock').metric(ctx)).toBe(1);
    expect(REPEATABLE_DEFS.find((r) => r.id === 'r_migrate').metric(ctx)).toBe(1);
  });

  it('totalOutputPerSec matches evaluate()\'s real production with Cold Fusion purchased (regression: goalCtx used to understate by up to 30% because coldFusionMult was only applied inside evaluate(), never in computeMults())', () => {
    const s = initialState();
    s.run.tiers[0] = { id: 0, owned: 100, manager: true, ready: 0 }; // 100 owned -> milestoneMult x8
    s.meta.coldStorage.upgrades.coldfusion = 15; // +30%

    const ctx = goalCtx(s, DEFAULT_CONFIG, NOW);
    const { state: s2 } = evaluate(s, DEFAULT_CONFIG, NOW, NOW + 1000); // 1s online gap
    const actualPerSec = s2.run.credits - s.run.credits;

    // Reviewer's verified repro: actual production 520.000 credits/sec vs
    // goalCtx reporting 400.000 before this fix.
    expect(ctx.totalOutputPerSec).toBeCloseTo(520, 6);
    expect(ctx.totalOutputPerSec).toBeCloseTo(actualPerSec, 6);
  });
  it('g17 tracks the block-16 jackpot', () => {
    const g17 = GOAL_DEFS.find((g) => g.id === 'g17');
    const ctx = { meta: { coldStorage: { blocksClaimed: Array(16).fill(false) } } };
    expect(g17.progress(ctx)).toEqual([0, 1]);
    ctx.meta.coldStorage.blocksClaimed[15] = true;
    expect(g17.progress(ctx)).toEqual([1, 1]);
  });
  it('g18 tracks completing a Deep Archive Scrub', () => {
    const g18 = GOAL_DEFS.find((g) => g.id === 'g18');
    expect(g18.progress({ meta: { stats: { deepJobsCompletedLifetime: 0 } } })).toEqual([0, 1]);
    expect(g18.progress({ meta: { stats: { deepJobsCompletedLifetime: 2 } } })).toEqual([1, 1]);
  });
  it('g19 tracks reaching tape-tree level 3 in any upgrade', () => {
    const g19 = GOAL_DEFS.find((g) => g.id === 'g19');
    expect(g19.progress({ meta: { coldStorage: { upgrades: { compression: 1, robotarm: 2 } } } })).toEqual([2, 3]);
    expect(g19.progress({ meta: { coldStorage: { upgrades: { compression: 3 } } } })).toEqual([3, 3]);
  });
  it('r_blocks and r_jobs repeatables scale off lifetime counters', () => {
    const r_blocks = REPEATABLE_DEFS.find((r) => r.id === 'r_blocks');
    const r_jobs = REPEATABLE_DEFS.find((r) => r.id === 'r_jobs');
    expect(r_blocks.metric({ meta: { stats: { blocksClaimedLifetime: 7 } } })).toBe(7);
    expect(r_jobs.metric({ meta: { stats: { jobsCompletedLifetime: 2 } } })).toBe(2);
    expect(r_blocks.target(0)).toBeGreaterThan(0);
    expect(r_jobs.target(0)).toBeGreaterThan(0);
  });
});
