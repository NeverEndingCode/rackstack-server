import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { initialState } from '../shared/state.js';
import {
  CONTRACT_DEFS, contractDef, dailyContractTypes,
  contractProgress, rolloverContracts, contractsForState,
} from '../shared/contracts.js';

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0); // 2026-07-31

describe('CONTRACT_DEFS', () => {
  it('has six defs with unique ids and a valid lane', () => {
    expect(CONTRACT_DEFS).toHaveLength(6);
    const ids = CONTRACT_DEFS.map((d) => d.id);
    expect(new Set(ids).size).toBe(6);
    for (const d of CONTRACT_DEFS) {
      expect(['base', 'cold']).toContain(d.lane);
      expect(typeof d.metric).toBe('string');
      expect(typeof d.desc).toBe('function');
      expect(typeof d.target).toBe('function');
    }
  });
  it('has exactly three base-lane defs, so substitution always has enough to draw from', () => {
    expect(CONTRACT_DEFS.filter((d) => d.lane === 'base')).toHaveLength(3);
  });
  it('contractDef resolves by id and fails closed on prototype keys', () => {
    expect(contractDef('c_flops').id).toBe('c_flops');
    for (const bad of ['nope', '__proto__', 'toString', 'constructor', '', null, 42]) {
      expect(contractDef(bad)).toBeNull();
    }
  });
});

describe('dailyContractTypes', () => {
  it('is deterministic: the same date gives the same three types every call', () => {
    const a = dailyContractTypes('2026-07-31', true);
    for (let i = 0; i < 20; i++) expect(dailyContractTypes('2026-07-31', true)).toEqual(a);
  });
  it('returns three distinct known ids', () => {
    for (const key of ['2026-01-01', '2026-07-31', '2026-12-25', '2027-03-14']) {
      const picked = dailyContractTypes(key, true);
      expect(picked).toHaveLength(3);
      expect(new Set(picked).size).toBe(3);
      for (const id of picked) expect(contractDef(id)).not.toBeNull();
    }
  });
  it('varies across dates', () => {
    const seen = new Set();
    for (let d = 1; d <= 28; d++) {
      seen.add(dailyContractTypes(`2026-02-${String(d).padStart(2, '0')}`, true).join(','));
    }
    expect(seen.size).toBeGreaterThan(3);
  });
  it('substitutes base-lane defs for locked cold-lane picks, deterministically', () => {
    for (const key of ['2026-01-01', '2026-07-31', '2026-12-25']) {
      const locked = dailyContractTypes(key, false);
      expect(locked).toHaveLength(3);
      expect(new Set(locked).size).toBe(3);
      for (const id of locked) expect(contractDef(id).lane).toBe('base');
      expect(dailyContractTypes(key, false)).toEqual(locked); // stable
    }
  });
  it('returns [] for a malformed date key rather than throwing', () => {
    for (const bad of ['', 'nope', null, undefined, 42, '__proto__']) {
      expect(dailyContractTypes(bad, true)).toEqual([]);
    }
  });
});

describe('contractProgress', () => {
  const def = contractDef('c_minigames');
  const meta = { stats: { minigamesWon: 9 } };
  it('measures the delta since baseline, floored at zero', () => {
    expect(contractProgress(def, meta, 4, 3)).toEqual({ current: 5, target: 3, met: true });
    expect(contractProgress(def, meta, 8, 3)).toEqual({ current: 1, target: 3, met: false });
    expect(contractProgress(def, meta, 20, 3)).toEqual({ current: 0, target: 3, met: false });
  });
  it('treats a missing baseline as zero', () => {
    expect(contractProgress(def, meta, undefined, 3).current).toBe(9);
  });
});

describe('rolloverContracts', () => {
  it('populates dateKey, targets, baselines and clears claimed on a fresh state', () => {
    const s = initialState();
    s.meta.stats.minigamesWon = 11;
    expect(rolloverContracts(s, DEFAULT_CONFIG, NOW)).toBe(true);
    expect(s.meta.contracts.dateKey).toBe('2026-07-31');
    expect(s.meta.contracts.targets).toHaveLength(3);
    expect(s.meta.contracts.claimed).toEqual([false, false, false]);
    // Baselines snapshot the CURRENT counters, so pre-existing progress never
    // counts toward today's contracts.
    const types = dailyContractTypes('2026-07-31', false);
    for (const id of types) {
      const def = contractDef(id);
      expect(s.meta.contracts.baseline[def.metric]).toBe(s.meta.stats[def.metric] ?? 0);
    }
  });

  it('is a no-op within the same UTC day, preserving snapshotted targets and claims', () => {
    const s = initialState();
    rolloverContracts(s, DEFAULT_CONFIG, NOW);
    s.meta.contracts.claimed = [true, false, false];
    const before = structuredClone(s.meta.contracts);
    expect(rolloverContracts(s, DEFAULT_CONFIG, NOW + 3600 * 1000)).toBe(false);
    expect(s.meta.contracts).toEqual(before);
  });

  it('rolls over on the next UTC day and resets claims', () => {
    const s = initialState();
    rolloverContracts(s, DEFAULT_CONFIG, NOW);
    s.meta.contracts.claimed = [true, true, true];
    expect(rolloverContracts(s, DEFAULT_CONFIG, NOW + 24 * 3600 * 1000)).toBe(true);
    expect(s.meta.contracts.dateKey).toBe('2026-08-01');
    expect(s.meta.contracts.claimed).toEqual([false, false, false]);
  });

  it('snapshots the FLOPS target so buying racks mid-day cannot move it', () => {
    const s = initialState();
    s.run.tiers[0].owned = 10;
    rolloverContracts(s, DEFAULT_CONFIG, NOW);
    const snapshot = [...s.meta.contracts.targets];
    s.run.tiers[0].owned = 10000; // output explodes
    rolloverContracts(s, DEFAULT_CONFIG, NOW + 3600 * 1000);
    expect(s.meta.contracts.targets).toEqual(snapshot);
  });

  it('never produces a zero FLOPS target for a zero-output player', () => {
    const s = initialState(); // no racks owned -> totalOutputPerSec === 0
    rolloverContracts(s, DEFAULT_CONFIG, NOW);
    for (const c of contractsForState(s.meta)) {
      expect(c.target).toBeGreaterThan(0);
    }
  });
});

describe('contractsForState', () => {
  it('returns [] before the first rollover', () => {
    expect(contractsForState(initialState().meta)).toEqual([]);
  });
  it('resolves three defs with their snapshotted targets and claim flags', () => {
    const s = initialState();
    rolloverContracts(s, DEFAULT_CONFIG, NOW);
    s.meta.contracts.claimed = [false, true, false];
    const resolved = contractsForState(s.meta);
    expect(resolved).toHaveLength(3);
    expect(resolved.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(resolved.map((c) => c.claimed)).toEqual([false, true, false]);
    expect(resolved.map((c) => c.target)).toEqual(s.meta.contracts.targets);
  });
  it('resolves the same three defs a Cold-Storage-unlocked player was given', () => {
    const s = initialState();
    s.run.tiers[4].owned = 1; // Server Room -> Cold Storage unlocked
    rolloverContracts(s, DEFAULT_CONFIG, NOW);
    expect(contractsForState(s.meta).map((c) => c.def.id))
      .toEqual(dailyContractTypes('2026-07-31', true));
  });
  it('keeps the locked-player board stable even after Cold Storage unlocks mid-day', () => {
    const s = initialState();
    rolloverContracts(s, DEFAULT_CONFIG, NOW);
    const before = contractsForState(s.meta).map((c) => c.def.id);
    s.run.tiers[4].owned = 1; // unlocks, but today's snapshot must not shift
    expect(contractsForState(s.meta).map((c) => c.def.id)).toEqual(before);
  });
});
