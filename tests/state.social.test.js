import { describe, it, expect } from 'vitest';
import { initialState, migrateSave } from '../shared/state.js';

describe('v1.5 state additions', () => {
  it('initialState seeds contracts, achievements, streak and the new stats', () => {
    const s = initialState();
    expect(s.meta.contracts).toEqual({
      dateKey: null, targets: [0, 0, 0], baseline: {}, claimed: [false, false, false],
    });
    expect(s.meta.achievements).toEqual({});
    expect(s.meta.streak).toEqual({ count: 0, lastClaimDate: null });
    expect(s.meta.stats.contractsCompletedLifetime).toBe(0);
    expect(s.meta.stats.bestStreak).toBe(0);
    expect(s.meta.stats.eventTopRungs).toBe(0);
  });

  it('migrateSave defaults the v1.5 fields on a pre-v1.5 save without losing data', () => {
    const preV15 = {
      run: { credits: 5 },
      meta: { wafers: 3, level: 7, coldStorage: { tapes: 99 }, eventProgress: null },
    };
    const s = migrateSave(preV15);
    expect(s.meta.contracts.dateKey).toBeNull();
    expect(s.meta.contracts.claimed).toEqual([false, false, false]);
    expect(s.meta.achievements).toEqual({});
    expect(s.meta.streak).toEqual({ count: 0, lastClaimDate: null });
    expect(s.meta.stats.contractsCompletedLifetime).toBe(0);
    // existing data preserved
    expect(s.meta.wafers).toBe(3);
    expect(s.meta.level).toBe(7);
    expect(s.meta.coldStorage.tapes).toBe(99);
  });

  it('migrateSave preserves in-flight v1.5 progress', () => {
    const s = initialState();
    s.meta.contracts = {
      dateKey: '2026-07-31', targets: [100, 3, 4],
      baseline: { lifetimeFlopsAllTime: 50 }, claimed: [true, false, false],
    };
    s.meta.achievements = { first_migrate: 1234 };
    s.meta.streak = { count: 4, lastClaimDate: '2026-07-31' };
    const out = migrateSave(s);
    expect(out.meta.contracts).toEqual(s.meta.contracts);
    expect(out.meta.achievements).toEqual({ first_migrate: 1234 });
    expect(out.meta.streak).toEqual({ count: 4, lastClaimDate: '2026-07-31' });
  });

  it('migrateSave repairs corrupt/hand-edited shapes rather than passing them through', () => {
    const bad = migrateSave({
      meta: {
        contracts: { dateKey: 5, targets: 'nope', baseline: null, claimed: [true] },
        achievements: [1, 2, 3],
        streak: 'nope',
      },
    });
    expect(bad.meta.contracts.dateKey).toBeNull();          // non-string key discarded
    expect(bad.meta.contracts.targets).toEqual([0, 0, 0]);  // non-array replaced
    expect(bad.meta.contracts.baseline).toEqual({});        // null replaced
    expect(bad.meta.contracts.claimed).toEqual([true, false, false]); // padded to 3
    expect(bad.meta.achievements).toEqual({});              // array replaced
    expect(bad.meta.streak).toEqual({ count: 0, lastClaimDate: null });
  });

  it('is idempotent', () => {
    const once = migrateSave(initialState());
    expect(migrateSave(once)).toEqual(once);
  });
});
