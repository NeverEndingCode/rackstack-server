import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { TIER_DEFS, OVERCLOCK_DEFS } from '../shared/gameData.js';
import { costAt, costForN, maxAffordable, milestoneMult, tierRate, xpForLevel, computeEffects, computeMults, migrateGain, minigameWafers, overclockBoost } from '../shared/gameRules.js';
import { initialState } from '../shared/state.js';

const meta0 = { legacyCores: 0, level: 0, upgrades: {}, shardUpgrades: {} };

describe('gameRules', () => {
  // The FORMULAS are unchanged; only tier 0's baseCost moved 4 -> 5 in v1.12.
  it('cost math matches v1.1 formulas', () => {
    expect(costAt(TIER_DEFS[0], 0)).toBe(5);
    expect(costAt(TIER_DEFS[0], 1)).toBeCloseTo(5 * 1.14);
    expect(costForN(TIER_DEFS[0], 0, 2)).toBeCloseTo(5 + 5 * 1.14);
    expect(maxAffordable(TIER_DEFS[0], 0, 100)).toBeGreaterThan(0);
    expect(maxAffordable(TIER_DEFS[0], 0, 3)).toBe(0);
  });
  it('milestones double output', () => {
    const thresholds = [25, 50, 100, 200, 500, 1000];
    expect(milestoneMult(24, thresholds)).toBe(1);
    expect(milestoneMult(25, thresholds)).toBe(2);
    expect(tierRate(25, 0.5, 1, thresholds)).toBe(25 * 0.5 * 2);
  });
  it('computeEffects couples offline cap to config', () => {
    const eff = computeEffects({ ...meta0, upgrades: { uptime: 3 } }, DEFAULT_CONFIG);
    expect(eff.offlineCapHours).toBe(4 + 3);
    expect(computeEffects(meta0, DEFAULT_CONFIG).firmwareMult).toBe(1);
  });
  it('computeMults applies config production levers', () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.production.gridMult = 2;
    const m = computeMults(meta0, cfg, 1);
    expect(m.gridMult).toBeCloseTo(m.racksMult * 2);
  });
  it('computeMults folds in coldFusionMult from coldStorage upgrades (regression: was only applied in evaluate(), understating every displayed rate)', () => {
    const baseline = computeMults(meta0, DEFAULT_CONFIG, 1);
    const withColdFusion = computeMults(
      { ...meta0, coldStorage: { upgrades: { coldfusion: 15 } } }, // +2%/level * 15 = +30%
      DEFAULT_CONFIG,
      1,
    );
    expect(withColdFusion.racksMult).toBeCloseTo(baseline.racksMult * 1.3);
    expect(withColdFusion.gridMult).toBeCloseTo(baseline.gridMult * 1.3);
    expect(withColdFusion.overclockMult).toBeCloseTo(baseline.overclockMult * 1.3);
  });
  it('xp and migrate math', () => {
    expect(xpForLevel(0)).toBe(50);
    expect(migrateGain(1e6, 1)).toBe(1);
    expect(migrateGain(4e6, 1)).toBe(2);
  });
  it('minigame payouts', () => {
    // v1.12 divisors: rush 6 (was 4), debug 3 (was 2)
    expect(minigameWafers('rush', 40, meta0, DEFAULT_CONFIG)).toBe(6);
    expect(minigameWafers('match', 10, meta0, DEFAULT_CONFIG)).toBe(20);
    expect(minigameWafers('balance', 6, meta0, DEFAULT_CONFIG)).toBe(9);
  });
});

describe('v1.12 heat curve is config-driven', () => {
  const meta = (upgrades = {}, shardUpgrades = {}) => ({
    upgrades, shardUpgrades, level: 0, legacyCores: 0,
    coldStorage: { upgrades: {} },
  });

  it('reads per-level rates and the floor from config', () => {
    const eff = computeEffects(meta({ thermal: 8, autovent: 8 }, { heatsink: 4 }), DEFAULT_CONFIG);
    // 1 - 0.05*8 - 0.15*4 = 0, clamped to the 0.40 floor
    expect(eff.heatDiscount).toBeCloseTo(0.40);
    expect(eff.autoVentPerSec).toBeCloseTo(32);
  });

  it('an un-upgraded save generates full heat and vents nothing passively', () => {
    const eff = computeEffects(meta(), DEFAULT_CONFIG);
    expect(eff.heatDiscount).toBeCloseTo(1);
    expect(eff.autoVentPerSec).toBe(0);
  });
});

describe('v1.12 level bonus is capped', () => {
  const meta = (level) => ({
    upgrades: {}, shardUpgrades: {}, level, legacyCores: 0,
    coldStorage: { upgrades: {} },
  });

  it('scales below the cap', () => {
    expect(computeEffects(meta(50), DEFAULT_CONFIG).levelBonusMult).toBeCloseTo(1 + 0.02 * 50);
  });

  it('stops scaling at the cap', () => {
    const atCap = computeEffects(meta(200), DEFAULT_CONFIG).levelBonusMult;
    const wayPast = computeEffects(meta(5000), DEFAULT_CONFIG).levelBonusMult;
    expect(atCap).toBeCloseTo(1 + 0.02 * 200);
    expect(wayPast).toBeCloseTo(atCap);
  });
});

describe('overclockBoost (v1.11)', () => {
  it('is exactly 1 with an empty overclock lane', () => {
    const s = initialState();
    s.run.tiers[0] = { id: 0, owned: 10, manager: true, ready: 0 };
    const { thresholds, racksMult, overclockMult } = computeMults(s.meta, DEFAULT_CONFIG, 1);
    const racksOutput = tierRate(10, TIER_DEFS[0].baseProd, racksMult, thresholds);
    expect(overclockBoost(s.run, DEFAULT_CONFIG, overclockMult, thresholds, racksOutput)).toBe(1);
  });

  it('is 1 when there is nothing to amplify', () => {
    const s = initialState();
    s.run.overclock[0] = { id: 0, owned: 5 };
    const { thresholds, overclockMult } = computeMults(s.meta, DEFAULT_CONFIG, 1);
    expect(overclockBoost(s.run, DEFAULT_CONFIG, overclockMult, thresholds, 0)).toBe(1);
  });

  it('at gain 1 it exactly preserves the pre-v1.11 total', () => {
    const s = initialState();
    s.run.tiers[0] = { id: 0, owned: 40, manager: true, ready: 0 };
    s.run.overclock[0] = { id: 0, owned: 3 };
    const { thresholds, racksMult, overclockMult } = computeMults(s.meta, DEFAULT_CONFIG, 1);
    const racksOutput = tierRate(40, TIER_DEFS[0].baseProd, racksMult, thresholds);
    const ocOutput = tierRate(3, OVERCLOCK_DEFS[0].baseProd, overclockMult, thresholds);
    const boost = overclockBoost(s.run, DEFAULT_CONFIG, overclockMult, thresholds, racksOutput);
    expect(racksOutput * boost).toBeCloseTo(racksOutput + ocOutput, 6);
  });

  it('scales with the gain tunable', () => {
    const s = initialState();
    s.run.tiers[0] = { id: 0, owned: 40, manager: true, ready: 0 };
    s.run.overclock[0] = { id: 0, owned: 3 };
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.risk.overclockBoostGain = 2;
    const { thresholds, racksMult, overclockMult } = computeMults(s.meta, cfg, 1);
    const racksOutput = tierRate(40, TIER_DEFS[0].baseProd, racksMult, thresholds);
    const b1 = overclockBoost(s.run, DEFAULT_CONFIG, overclockMult, thresholds, racksOutput);
    const b2 = overclockBoost(s.run, cfg, overclockMult, thresholds, racksOutput);
    expect(b2 - 1).toBeCloseTo(2 * (b1 - 1), 9);
  });
});
