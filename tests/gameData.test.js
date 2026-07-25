import { describe, it, expect } from 'vitest';
import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS, UPGRADE_DEFS, SINGULARITY_DEFS, GROWTH, MILESTONES } from '../shared/gameData.js';

describe('gameData', () => {
  it('matches the v1.1 numeric content', () => {
    expect(GROWTH).toBe(1.14);
    expect(MILESTONES).toEqual([25, 50, 100, 200, 500, 1000]);
    expect(TIER_DEFS).toHaveLength(14);
    expect(TIER_DEFS[0]).toEqual({ id: 0, name: 'Spare Raspberry Pi', baseCost: 4, baseProd: 0.5, managerCost: 500 });
    expect(TIER_DEFS[13].baseCost).toBe(4600000000000000);
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
