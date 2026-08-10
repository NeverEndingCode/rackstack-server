import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { initialState, evaluate, recordLegacyCorePeak } from '../shared/state.js';
import { applyAction, scheduleAnomaly } from '../shared/reducer.js';

const NOW = 1_000_000;

describe('reducer: migrate', () => {
  it('rejects with invalid_target when lifetimeRun yields 0 gain', () => {
    const s = initialState();
    const { result } = applyAction(s, { type: 'migrate' }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });

  it('happy path: fresh run with deepcache/bootstrap start credits, +gain+echo cores, stats.migrates+1', () => {
    const s = initialState();
    s.run.lifetimeRun = 4e12; // v1.12: gain = floor((4e12 / 2e12) ** 1.0) = 2
    s.run.tiers[0].owned = 5;
    s.run.credits = 999;
    const { state: s2, result } = applyAction(s, { type: 'migrate' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(s2.run.credits).toBe(10); // no deepcache/bootstrap upgrades yet
    expect(s2.run.lifetimeRun).toBe(0);
    expect(s2.run.tiers[0].owned).toBe(0);
    expect(s2.meta.legacyCores).toBe(2);
    expect(s2.meta.stats.migrates).toBe(1);
    expect(s.run.credits).toBe(999); // input not mutated
  });

  it('lifetimeFlopsAllTime is not reset by migrate', () => {
    const s = initialState();
    s.run.lifetimeRun = 4e6;
    s.meta.stats.lifetimeFlopsAllTime = 12345;
    const { state: s2 } = applyAction(s, { type: 'migrate' }, DEFAULT_CONFIG, NOW);
    expect(s2.meta.stats.lifetimeFlopsAllTime).toBe(12345);
  });

  it('applies deepCacheBonus and bootstrapMult to start credits, and echoCores as a share of gain', () => {
    const s = initialState();
    s.run.lifetimeRun = 4e13;                 // migrateGain = floor((4e13/2e12)^1) = 20
    s.meta.upgrades.deepcache = 2;            // +10 each => +20
    s.meta.shardUpgrades.bootstrap = 1;       // v1.12: x3, not x10
    s.meta.shardUpgrades.echocores = 3;       // v1.12: +5% of gain per level => +15% of 20 = 3
    const { state: s2 } = applyAction(s, { type: 'migrate' }, DEFAULT_CONFIG, NOW);
    expect(s2.run.credits).toBe((10 + 20) * 3);
    expect(s2.meta.legacyCores).toBe(20 + 3);
  });

  it('echoCores cannot be farmed by cheap repeat Migrates', () => {
    const s = initialState();
    s.run.lifetimeRun = 2e12;                 // gain = 1
    s.meta.shardUpgrades.echocores = 10;      // 10 levels => +50% of gain => floor(0.5) = 0
    const { state: s2 } = applyAction(s, { type: 'migrate' }, DEFAULT_CONFIG, NOW);
    expect(s2.meta.legacyCores).toBe(1);
  });
});

describe('reducer: singularity', () => {
  it('rejects with invalid_target when legacyCores yields 0 shards', () => {
    const s = initialState();
    s.meta.legacyCores = 0;
    const { result } = applyAction(s, { type: 'singularity' }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });

  it('happy path: resets run + legacyCores, grants shards, bumps stats.singularities', () => {
    const s = initialState();
    s.meta.legacyCores = 400;        // v1.12: floor(400 * 0.4) = 160
    s.run.tiers[0].owned = 3;
    s.meta.wafers = 42; // untouched
    const { state: s2, result } = applyAction(s, { type: 'singularity' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(s2.meta.legacyCores).toBe(0);
    expect(s2.meta.singularityShards).toBe(160);
    expect(s2.meta.stats.singularities).toBe(1);
    expect(s2.run.tiers[0].owned).toBe(0);
    expect(s2.meta.wafers).toBe(42);
  });

  it('yield is linear in cores, so a capped core pool still funds the tree', () => {
    const s = initialState();
    s.meta.legacyCores = 800;
    const { state: s2 } = applyAction(s, { type: 'singularity' }, DEFAULT_CONFIG, NOW);
    expect(s2.meta.singularityShards).toBe(320);   // 2x the cores => 2x the shards
  });
});

describe('reducer: buyUpgrade', () => {
  it('deducts wafer cost and increments level', () => {
    const s = initialState();
    s.meta.wafers = 100;
    const { state: s2, result } = applyAction(s, { type: 'buyUpgrade', id: 'firmware' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(s2.meta.upgrades.firmware).toBe(1);
    expect(s2.meta.wafers).toBe(100 - 5); // baseCost 5, level 0
  });

  it('rejects insufficient_credits when wafers too low', () => {
    const s = initialState();
    s.meta.wafers = 1;
    const { result } = applyAction(s, { type: 'buyUpgrade', id: 'firmware' }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'insufficient_credits' });
  });

  it('rejects invalid_target for an unknown upgrade id', () => {
    const s = initialState();
    const { result } = applyAction(s, { type: 'buyUpgrade', id: 'nope' }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });

  it('caps at config.upgrades.maxLevels[id], not the def maxLevel', () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.upgrades.maxLevels.firmware = 2;
    let s = initialState();
    s.meta.wafers = 1e6;

    let r = applyAction(s, { type: 'buyUpgrade', id: 'firmware' }, cfg, NOW);
    expect(r.result.ok).toBe(true);
    s = r.state;

    r = applyAction(s, { type: 'buyUpgrade', id: 'firmware' }, cfg, NOW);
    expect(r.result.ok).toBe(true);
    s = r.state;
    expect(s.meta.upgrades.firmware).toBe(2);

    r = applyAction(s, { type: 'buyUpgrade', id: 'firmware' }, cfg, NOW);
    expect(r.result).toEqual({ ok: false, error: 'max_level' });
  });
});

describe('reducer: buyShardUpgrade', () => {
  it('deducts singularity shards and increments level', () => {
    const s = initialState();
    s.meta.singularityShards = 100;
    const { state: s2, result } = applyAction(s, { type: 'buyShardUpgrade', id: 'engine' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(s2.meta.shardUpgrades.engine).toBe(1);
    expect(s2.meta.singularityShards).toBe(100 - 6); // baseCost 6, level 0
  });

  it('rejects insufficient_credits when shards too low', () => {
    const s = initialState();
    const { result } = applyAction(s, { type: 'buyShardUpgrade', id: 'engine' }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'insufficient_credits' });
  });

  it('caps at config.upgrades.maxLevels[id]', () => {
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.upgrades.maxLevels.engine = 1;
    const s = initialState();
    s.meta.singularityShards = 1e6;
    const r1 = applyAction(s, { type: 'buyShardUpgrade', id: 'engine' }, cfg, NOW);
    expect(r1.result.ok).toBe(true);
    const r2 = applyAction(r1.state, { type: 'buyShardUpgrade', id: 'engine' }, cfg, NOW);
    expect(r2.result).toEqual({ ok: false, error: 'max_level' });
  });
});

describe('reducer: claimGoal', () => {
  it('succeeds exactly once for g1 once its progress condition is met', () => {
    const s = initialState();
    s.run.tiers[0].owned = 5;
    const { state: s2, result } = applyAction(s, { type: 'claimGoal', id: 'g1' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(s2.meta.goalsCompleted.g1).toBe(true);
    expect(s2.meta.wafers).toBe(2);
    expect(s2.meta.xp).toBe(10);
    expect(s2.meta.stats.totalWafersEarned).toBe(2);

    const { result: result2 } = applyAction(s2, { type: 'claimGoal', id: 'g1' }, DEFAULT_CONFIG, NOW);
    expect(result2).toEqual({ ok: false, error: 'invalid_target' });
  });

  it('rejects not_met when progress condition is unmet', () => {
    const s = initialState();
    const { result } = applyAction(s, { type: 'claimGoal', id: 'g1' }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'not_met' });
  });

  it('rejects invalid_target for unknown goal id', () => {
    const s = initialState();
    const { result } = applyAction(s, { type: 'claimGoal', id: 'bogus' }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });

  it('rolls level-ups via the xpForLevel while-loop', () => {
    const s = initialState();
    s.run.tiers[0].owned = 5;
    s.meta.xp = 45; // xpForLevel(0) = floor(50*1^1.6) = 50; +10 from g1 = 55 -> levels once, remainder 5
    const { state: s2 } = applyAction(s, { type: 'claimGoal', id: 'g1' }, DEFAULT_CONFIG, NOW);
    expect(s2.meta.level).toBe(1);
    expect(s2.meta.xp).toBe(5);
  });
});

describe('reducer: claimRepeatable', () => {
  it('claims and bumps the repeatable level, repeatable across multiple claims', () => {
    const s = initialState();
    s.run.tiers[0].owned = 20; // r_racks target(0) = round(10*1.8^0) = 10
    const r1 = applyAction(s, { type: 'claimRepeatable', id: 'r_racks' }, DEFAULT_CONFIG, NOW);
    expect(r1.result.ok).toBe(true);
    expect(r1.state.meta.repeatable.r_racks).toBe(1);
    expect(r1.state.meta.stats.totalWafersEarned).toBeGreaterThan(0);

    // target(1) = round(10*1.8^1) = 18, still satisfied by owned=20
    const r2 = applyAction(r1.state, { type: 'claimRepeatable', id: 'r_racks' }, DEFAULT_CONFIG, NOW);
    expect(r2.result.ok).toBe(true);
    expect(r2.state.meta.repeatable.r_racks).toBe(2);
  });

  it('rejects not_met when metric is below target', () => {
    const s = initialState();
    const { result } = applyAction(s, { type: 'claimRepeatable', id: 'r_racks' }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'not_met' });
  });

  it('rejects invalid_target for unknown repeatable id', () => {
    const s = initialState();
    const { result } = applyAction(s, { type: 'claimRepeatable', id: 'bogus' }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });
});

describe('reducer: claimAnomaly', () => {
  function openState() {
    const s = initialState();
    s.server.nextAnomalyAt = NOW - 100;
    s.server.anomalyExpiresAt = NOW + 5000;
    return s;
  }

  it('rejects cooldown_active when outside the claim window', () => {
    const s = initialState(); // nextAnomalyAt=0, anomalyExpiresAt=0
    const { result } = applyAction(s, { type: 'claimAnomaly' }, DEFAULT_CONFIG, NOW, () => 0.1);
    expect(result).toEqual({ ok: false, error: 'cooldown_active' });
  });

  it('deterministic credits branch (rng=0.1), grants credits, reschedules, then re-claim is cooldown_active', () => {
    const s = openState();
    const { state: s2, result } = applyAction(s, { type: 'claimAnomaly' }, DEFAULT_CONFIG, NOW, () => 0.1);
    expect(result.ok).toBe(true);
    expect(result.reward.kind).toBe('credits');
    // totalOutputPerSec is 0 (no lanes owned) -> amount = max(0, 20) * eventRewardMult(1) = 20
    expect(result.reward.amount).toBeCloseTo(20);
    expect(s2.run.credits).toBeCloseTo(10 + 20);

    // v1.12: next = now + 420000 + 0.1*(900000-420000) = now + 468000
    expect(s2.server.nextAnomalyAt).toBeCloseTo(NOW + 468000);
    expect(s2.server.anomalyExpiresAt).toBeCloseTo(NOW + 468000 + 30000);

    const { result: result2 } = applyAction(s2, { type: 'claimAnomaly' }, DEFAULT_CONFIG, NOW, () => 0.1);
    expect(result2).toEqual({ ok: false, error: 'cooldown_active' });
  });

  it('boost branch (rng=0.9) stores a mult/until boost on server', () => {
    const s = openState();
    const { state: s2, result } = applyAction(s, { type: 'claimAnomaly' }, DEFAULT_CONFIG, NOW, () => 0.9);
    expect(result.ok).toBe(true);
    expect(result.reward.kind).toBe('boost');
    // mult = [2,3,4][floor(0.9*3)] = [2,3,4][2] = 4
    expect(result.reward.mult).toBe(4);
    expect(s2.server.boost).toEqual({ mult: 4, until: result.reward.until });
    // duration = (45 + 0.9*30) * eventRewardMult(1) = 72s
    expect(s2.server.boost.until).toBeCloseTo(NOW + 72 * 1000);
  });
});

describe('reducer: hardReset', () => {
  it('returns initialState() with a freshly scheduled anomaly window', () => {
    const s = initialState();
    s.run.credits = 99999;
    s.meta.legacyCores = 50;
    s.meta.wafers = 10;
    const { state: s2, result } = applyAction(s, { type: 'hardReset' }, DEFAULT_CONFIG, NOW, () => 0.5);
    expect(result.ok).toBe(true);
    expect(s2.run.credits).toBe(10);
    expect(s2.meta.legacyCores).toBe(0);
    expect(s2.meta.wafers).toBe(0);
    expect(s2.server.nextAnomalyAt).toBeGreaterThan(NOW);
    expect(s2.server.anomalyExpiresAt).toBeGreaterThan(s2.server.nextAnomalyAt);
  });
});

describe('bestLegacyCores', () => {
  it('rises with legacyCores and never falls', () => {
    const s = initialState();
    s.meta.legacyCores = 40;
    recordLegacyCorePeak(s.meta);
    expect(s.meta.stats.bestLegacyCores).toBe(40);

    s.meta.legacyCores = 10;
    recordLegacyCorePeak(s.meta);
    expect(s.meta.stats.bestLegacyCores).toBe(40);
  });

  it('backfills a pre-v1.10 save that has no bestLegacyCores', () => {
    const s = initialState();
    delete s.meta.stats.bestLegacyCores;
    s.meta.legacyCores = 77;
    recordLegacyCorePeak(s.meta);
    expect(s.meta.stats.bestLegacyCores).toBe(77);
  });

  it('is updated by evaluate(), including on a save that never had the stat', () => {
    const s = initialState();
    delete s.meta.stats.bestLegacyCores;
    s.meta.legacyCores = 55;
    const out = evaluate(s, DEFAULT_CONFIG, Date.now() - 5000, Date.now());
    expect(out.state.meta.stats.bestLegacyCores).toBe(55);
  });

  it('survives a Singularity that zeroes legacyCores', () => {
    const s = initialState();
    s.meta.legacyCores = 100;
    const out = applyAction(s, { type: 'singularity' }, DEFAULT_CONFIG, NOW);
    expect(out.state.meta.legacyCores).toBe(0);
    expect(out.state.meta.stats.bestLegacyCores).toBe(100);
  });

  it('survives Migrate then Singularity applied in ONE batch, with no evaluate between', () => {
    // The test that fails if the singularity() call site is ever removed as
    // "redundant with evaluate()". /api/actions applies batches.
    //
    // v1.12: migrateGain = floor((lifetimeRun / 2e12) ** 1.0 * legacyGainMult),
    // so 2e13 grants 10 cores at the default multiplier - comfortably above the
    // `shardsGained > 0` floor singularity() requires (10 * 0.4 = 4 shards).
    let s = initialState();
    s.run.lifetimeRun = 2e13;
    s = applyAction(s, { type: 'migrate' }, DEFAULT_CONFIG, NOW).state;
    const granted = s.meta.legacyCores;
    expect(granted).toBe(10);

    s = applyAction(s, { type: 'singularity' }, DEFAULT_CONFIG, NOW).state;
    expect(s.meta.legacyCores).toBe(0);
    expect(s.meta.stats.bestLegacyCores).toBe(10);
  });
});

describe('scheduleAnomaly', () => {
  it('mutates the passed server object with next/expires derived from config + rng', () => {
    const server = { nextAnomalyAt: 0, anomalyExpiresAt: 0, boost: null, lastVentAt: 0, gameCooldowns: {} };
    scheduleAnomaly(server, DEFAULT_CONFIG, NOW, () => 0.5);
    // v1.12 cadence: 420000-900000ms, 30s catch window
    expect(server.nextAnomalyAt).toBe(NOW + 420000 + 0.5 * (900000 - 420000));
    expect(server.anomalyExpiresAt).toBe(server.nextAnomalyAt + 30000);
  });
});
