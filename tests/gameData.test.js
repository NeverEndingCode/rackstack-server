import { describe, it, expect } from 'vitest';
import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS, UPGRADE_DEFS, SINGULARITY_DEFS, GROWTH, MILESTONES } from '../shared/gameData.js';

describe('gameData', () => {
  it('matches the v1.1 numeric content', () => {
    expect(GROWTH).toBe(1.14);
    expect(MILESTONES).toEqual([25, 50, 100, 200, 500, 1000]);
    expect(TIER_DEFS).toHaveLength(14);
    expect(TIER_DEFS[0]).toEqual({ id: 0, name: 'Spare Raspberry Pi', baseCost: 5, baseProd: 0.5, managerCost: 500 });
    expect(TIER_DEFS[13].baseCost).toBe(3e17);
    expect(GRID_DEFS).toHaveLength(5);
    expect(OVERCLOCK_DEFS[0]).toEqual({ id: 0, name: 'Air-Cooled Overclock Rig', baseCost: 300, baseProd: 40, heatPerSec: 0.15 });
    expect(UPGRADE_DEFS.map((u) => u.id)).toContain('firmware');
    expect(SINGULARITY_DEFS.map((u) => u.id)).toContain('engine');
  });
  it('has no Icon fields (server-safe)', () => {
    for (const def of [...TIER_DEFS, ...GRID_DEFS, ...OVERCLOCK_DEFS]) {
      expect(def.Icon).toBeUndefined();
    }
  });
});

describe('v1.12 tier cost curve', () => {
  it('cost:production ratio grows ~2.5x per tier', () => {
    const ratios = TIER_DEFS.map((d) => d.baseCost / d.baseProd);
    for (let i = 1; i < ratios.length; i++) {
      const step = ratios[i] / ratios[i - 1];
      expect(step, `tier ${i} step ${step}`).toBeGreaterThan(2.2);
      expect(step, `tier ${i} step ${step}`).toBeLessThan(2.8);
    }
  });

  it('keeps the opening cheap and makes the top tier the long goal', () => {
    expect(TIER_DEFS[0].baseCost).toBe(5);
    expect(TIER_DEFS[13].baseCost).toBe(3e17);
  });
});
