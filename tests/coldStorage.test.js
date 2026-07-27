import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { TOTAL_BLOCKS, TAPE_UPGRADE_DEFS, JOB_TYPES } from '../shared/coldStorageData.js';
import { computeColdStorageEffects, blockReward, jobDurationSec, jobReward } from '../shared/coldStorage.js';

const meta0 = { coldStorage: { upgrades: {} } };

describe('coldStorage', () => {
  it('effects default to neutral with no upgrades', () => {
    const eff = computeColdStorageEffects(meta0, DEFAULT_CONFIG);
    expect(eff.tapeRewardMult).toBe(1);
    expect(eff.blockDurationMs).toBe(DEFAULT_CONFIG.batchQueue.blockDurationMs);
    expect(eff.coldFusionMult).toBe(1);
    expect(eff.heatCapacityBonus).toBe(0);
  });
  it('robotarm reduces block duration with a 4h floor', () => {
    const eff20 = computeColdStorageEffects({ coldStorage: { upgrades: { robotarm: 20 } } }, DEFAULT_CONFIG);
    expect(eff20.blockDurationMs).toBe(4 * 3600000);
  });
  it('block 1 (index 0) pays base tapes, no flops', () => {
    const eff = computeColdStorageEffects(meta0, DEFAULT_CONFIG);
    const { tapes, flops } = blockReward(0, 0, DEFAULT_CONFIG, eff, 100);
    expect(tapes).toBe(5);
    expect(flops).toBe(0);
  });
  it('block 4 (index 3) grants a FLOPS bonus', () => {
    const eff = computeColdStorageEffects(meta0, DEFAULT_CONFIG);
    const { flops } = blockReward(3, 0, DEFAULT_CONFIG, eff, 100);
    expect(flops).toBe(100 * 120);
  });
  it('block 16 (index 15) applies the jackpot multiplier', () => {
    const eff = computeColdStorageEffects(meta0, DEFAULT_CONFIG);
    const { tapes } = blockReward(15, 0, DEFAULT_CONFIG, eff, 0);
    expect(tapes).toBe(Math.round(5 * 16 * 5));
  });
  it('trackCycle increases block rewards', () => {
    // NOTE: deviates from the task-1 brief's literal `blockReward(0, 1, ...)` comparison.
    // At index 0, blockBaseTapes=5, a single cycle's 5% bonus (5 * 1.05 = 5.25) rounds
    // back down to 5, tying with trackCycle=0 and making the brief's assertion false
    // regardless of implementation. Using trackCycle=3 (15% bonus, 5.75 -> 6) clears
    // the rounding threshold so the comparison actually exercises the intended effect.
    const eff = computeColdStorageEffects(meta0, DEFAULT_CONFIG);
    const { tapes: cycle0 } = blockReward(0, 0, DEFAULT_CONFIG, eff, 0);
    const { tapes: cycle3 } = blockReward(0, 3, DEFAULT_CONFIG, eff, 0);
    expect(cycle3).toBeGreaterThan(cycle0);
  });
  it('job durations and rewards scale as specified', () => {
    expect(jobDurationSec('defrag', DEFAULT_CONFIG)).toBe(3600);
    expect(jobDurationSec('deep', DEFAULT_CONFIG)).toBe(86400);
    expect(jobReward('defrag', DEFAULT_CONFIG)).toBe(20);
    expect(jobReward('index', DEFAULT_CONFIG)).toBe(200);
    expect(jobReward('deep', DEFAULT_CONFIG)).toBe(720);
  });
  it('TAPE_UPGRADE_DEFS has 7 entries matching config.upgrades.maxLevels', () => {
    expect(TAPE_UPGRADE_DEFS).toHaveLength(7);
    for (const u of TAPE_UPGRADE_DEFS) {
      expect(DEFAULT_CONFIG.upgrades.maxLevels[u.id]).toBe(u.maxLevel);
    }
  });
});
