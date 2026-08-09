import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS } from '../shared/gameData.js';
import { costForN, maxAffordable, milestoneThresholds, milestoneMult } from '../shared/gameRules.js';
import { initialState } from '../shared/state.js';
import { applyAction } from '../shared/reducer.js';
import { computeColdStorageEffects } from '../shared/coldStorage.js';

const NOW = 1_000_000;

describe('reducer: unknown action', () => {
  it('returns unknown_action for an unrecognized type', () => {
    const s = initialState();
    const { state, result } = applyAction(s, { type: 'nonsense' }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'unknown_action' });
    expect(state).toEqual(s);
    expect(s.run.credits).toBe(10);
  });

  describe('prototype-key action.type (prototype-pollution-via-lookup regression)', () => {
    // {type: '__proto__'} used to resolve HANDLERS['__proto__'] to
    // Object.prototype's own accessor rather than undefined (since HANDLERS
    // was a plain object literal, inheriting from Object.prototype) -
    // applyAction called that as a function without checking it was actually
    // one of the registered handlers, throwing "handler is not a function".
    // {type: 'toString'} / {type: 'constructor'} / {type: 'hasOwnProperty'}
    // similarly resolved to real inherited functions/objects instead of
    // failing the lookup. All of these must return unknown_action, never
    // throw, and never mutate state.
    const badTypes = ['__proto__', 'toString', 'constructor', 'hasOwnProperty'];
    for (const type of badTypes) {
      it(`type: ${JSON.stringify(type)} -> unknown_action, state unchanged, no throw`, () => {
        const s = initialState();
        let out;
        expect(() => {
          out = applyAction(s, { type }, DEFAULT_CONFIG, NOW);
        }).not.toThrow();
        expect(out.result).toEqual({ ok: false, error: 'unknown_action' });
        expect(out.state).toEqual(s);
        expect(s.run.credits).toBe(10);
      });
    }
  });
});

describe('reducer: buy (tiers)', () => {
  it('buy 1 tier deducts exact cost', () => {
    const s = initialState(); // credits: 10, tier0 costs 4
    const { state: s2, result } = applyAction(s, { type: 'buy', lane: 'tiers', index: 0, mode: 1 }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(s2.run.tiers[0].owned).toBe(1);
    expect(s2.run.credits).toBeCloseTo(6);
    expect(s.run.credits).toBe(10); // input not mutated
  });
  it('buy rejects when unaffordable', () => {
    const s = initialState();
    const { result } = applyAction(s, { type: 'buy', lane: 'tiers', index: 5, mode: 1 }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'insufficient_credits' });
  });
  it('buy mode "max" buys as many as affordable and matches costForN', () => {
    const s = initialState();
    s.run.credits = 1000;
    const def = TIER_DEFS[0];
    const expectedN = maxAffordable(def, 0, 1000);
    const expectedCost = costForN(def, 0, expectedN);
    const { state: s2, result } = applyAction(s, { type: 'buy', lane: 'tiers', index: 0, mode: 'max' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(s2.run.tiers[0].owned).toBe(expectedN);
    expect(s2.run.credits).toBeCloseTo(1000 - expectedCost);
  });
  it('buy rejects out-of-range index with invalid_target', () => {
    const s = initialState();
    const { result } = applyAction(s, { type: 'buy', lane: 'tiers', index: 999, mode: 1 }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });
  it('buy rejects unknown lane with invalid_target', () => {
    const s = initialState();
    const { result } = applyAction(s, { type: 'buy', lane: 'bogus', index: 0, mode: 1 }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });

  describe('malicious/non-numeric index (prototype-poisoning regression)', () => {
    // {index: 'push'} used to resolve run.tiers['push'] to
    // Array.prototype.push (an own-array-method lookup, since a plain
    // string is used as a property key rather than validated as a numeric
    // index) - a truthy "laneState", so the handler proceeded and corrupted
    // state instead of rejecting. {index: 'length'} threw outright, which
    // applyAction's contract documents as never happening. All of these
    // must return invalid_target, never throw, and never mutate state.
    const badIndexes = ['push', 'length', -1, 1.5, 999, '__proto__', 'toString', NaN, null, undefined, {}, []];
    for (const index of badIndexes) {
      it(`index: ${JSON.stringify(index)} -> invalid_target, state unchanged, no throw`, () => {
        const s = initialState();
        let out;
        expect(() => {
          out = applyAction(s, { type: 'buy', lane: 'tiers', index, mode: 1 }, DEFAULT_CONFIG, NOW);
        }).not.toThrow();
        expect(out.result).toEqual({ ok: false, error: 'invalid_target' });
        expect(out.state).toEqual(s); // structuredClone contract: no mutation leaked back
        expect(s.run.credits).toBe(10);
        expect(Number.isNaN(out.state.run.credits)).toBe(false);
      });
    }

    it('a malicious buy does not corrupt credits into NaN for a subsequent action in the same batch', () => {
      const s = initialState();
      const step1 = applyAction(s, { type: 'buy', lane: 'tiers', index: 'push', mode: 1 }, DEFAULT_CONFIG, NOW);
      expect(step1.result).toEqual({ ok: false, error: 'invalid_target' });
      expect(Number.isNaN(step1.state.run.credits)).toBe(false);
      // A follow-up buy the player couldn't otherwise afford must still be rejected.
      const step2 = applyAction(step1.state, { type: 'buy', lane: 'tiers', index: 5, mode: 1 }, DEFAULT_CONFIG, NOW);
      expect(step2.result).toEqual({ ok: false, error: 'insufficient_credits' });
    });
  });
});

describe('reducer: buy (grid)', () => {
  it('buy 1 grid node deducts exact cost', () => {
    const s = initialState();
    s.run.credits = 100;
    const { state: s2, result } = applyAction(s, { type: 'buy', lane: 'grid', index: 0, mode: 1 }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(s2.run.grid[0].owned).toBe(1);
    expect(s2.run.credits).toBeCloseTo(100 - GRID_DEFS[0].baseCost);
  });
  it('buy grid rejects when unaffordable', () => {
    const s = initialState(); // credits: 10, grid0 costs 50
    const { result } = applyAction(s, { type: 'buy', lane: 'grid', index: 0, mode: 1 }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'insufficient_credits' });
  });
});

describe('reducer: buy (overclock)', () => {
  it('buy 1 overclock bay deducts exact cost', () => {
    const s = initialState();
    s.run.credits = 1000;
    const { state: s2, result } = applyAction(s, { type: 'buy', lane: 'overclock', index: 0, mode: 1 }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(s2.run.overclock[0].owned).toBe(1);
    expect(s2.run.credits).toBeCloseTo(1000 - OVERCLOCK_DEFS[0].baseCost);
  });
  it('buy overclock rejects when unaffordable', () => {
    const s = initialState(); // credits: 10, overclock0 costs 300
    const { result } = applyAction(s, { type: 'buy', lane: 'overclock', index: 0, mode: 1 }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'insufficient_credits' });
  });
  it('overclock buys blocked during overheat lockout', () => {
    const s = initialState();
    s.run.credits = 1e9;
    s.run.heatCooldownUntil = NOW + 5000;
    const { result } = applyAction(s, { type: 'buy', lane: 'overclock', index: 0, mode: 1 }, DEFAULT_CONFIG, NOW);
    expect(result.error).toBe('cooldown_active');
  });
});

describe("buy mode 'milestone'", () => {
  it('buys exactly enough to reach the next threshold', () => {
    const s = initialState();
    s.run.tiers[0].owned = 18;
    s.run.credits = 1e12;
    const { state, result } = applyAction(s, { type: 'buy', lane: 'tiers', index: 0, mode: 'milestone' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(state.run.tiers[0].owned).toBe(25); // first MILESTONES entry
  });

  it('uses the DISCOUNTED thresholds when infiniteloop is owned', () => {
    // infiniteloop lowers milestone thresholds by 10% per level. A client
    // computing the target from stale config would overshoot; this test is
    // what fails if that calculation ever moves client-side.
    const s = initialState();
    s.meta.shardUpgrades = { ...(s.meta.shardUpgrades || {}), infiniteloop: 5 };
    s.run.tiers[0].owned = 0;
    s.run.credits = 1e12;
    const thresholds = milestoneThresholds(s.meta, DEFAULT_CONFIG);
    const { state } = applyAction(s, { type: 'buy', lane: 'tiers', index: 0, mode: 'milestone' }, DEFAULT_CONFIG, NOW);
    expect(state.run.tiers[0].owned).toBe(thresholds[0]);
    expect(thresholds[0]).toBeLessThan(25);
  });

  it('refuses when the full jump is unaffordable, changing nothing', () => {
    const s = initialState();
    s.run.tiers[0].owned = 18;
    s.run.credits = 1;
    const { state, result } = applyAction(s, { type: 'buy', lane: 'tiers', index: 0, mode: 'milestone' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('insufficient_credits');
    expect(state.run.tiers[0].owned).toBe(18);
  });

  it('reports no_milestone past the final threshold', () => {
    const s = initialState();
    s.run.tiers[0].owned = 1000; // the last MILESTONES entry
    s.run.credits = 1e12;
    const { result } = applyAction(s, { type: 'buy', lane: 'tiers', index: 0, mode: 'milestone' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('no_milestone');
  });

  it('doubles the lane multiplier once the milestone lands', () => {
    const s = initialState();
    s.run.tiers[0].owned = 24;
    s.run.credits = 1e12;
    const before = milestoneMult(24, milestoneThresholds(s.meta, DEFAULT_CONFIG));
    const { state } = applyAction(s, { type: 'buy', lane: 'tiers', index: 0, mode: 'milestone' }, DEFAULT_CONFIG, NOW);
    const after = milestoneMult(state.run.tiers[0].owned, milestoneThresholds(state.meta, DEFAULT_CONFIG));
    expect(after).toBe(before * 2);
  });

  it('targets the NEXT threshold when already exactly on one', () => {
    const s = initialState();
    s.run.tiers[0].owned = 25;
    s.run.credits = 1e12;
    const { state, result } = applyAction(s, { type: 'buy', lane: 'tiers', index: 0, mode: 'milestone' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(state.run.tiers[0].owned).toBe(50);
  });
});

describe('reducer: collect', () => {
  it('collects a ready tier into credits and zeroes ready', () => {
    const s = initialState();
    s.run.tiers[0].ready = 15;
    const { state: s2, result } = applyAction(s, { type: 'collect', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(s2.run.credits).toBeCloseTo(25);
    expect(s2.run.tiers[0].ready).toBe(0);
    expect(s.run.tiers[0].ready).toBe(15); // input not mutated
  });
  it('collect rejects a tier with nothing ready', () => {
    const s = initialState();
    const { result } = applyAction(s, { type: 'collect', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });
  it('collect rejects out-of-range index', () => {
    const s = initialState();
    const { result } = applyAction(s, { type: 'collect', index: 999 }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });
  it.each(['push', 'length', -1, 1.5])('collect rejects non-numeric/out-of-range index %j without throwing', (index) => {
    const s = initialState();
    let out;
    expect(() => { out = applyAction(s, { type: 'collect', index }, DEFAULT_CONFIG, NOW); }).not.toThrow();
    expect(out.result).toEqual({ ok: false, error: 'invalid_target' });
    expect(Number.isNaN(out.state.run.credits)).toBe(false);
  });
});

describe('reducer: collectAll', () => {
  it('collects every ready tier at once', () => {
    const s = initialState();
    s.run.tiers[0].ready = 10;
    s.run.tiers[1].ready = 5;
    const { state: s2, result } = applyAction(s, { type: 'collectAll' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(s2.run.credits).toBeCloseTo(25);
    expect(s2.run.tiers[0].ready).toBe(0);
    expect(s2.run.tiers[1].ready).toBe(0);
  });
  it('is a no-op success when nothing is ready', () => {
    const s = initialState();
    const { state: s2, result } = applyAction(s, { type: 'collectAll' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(s2.run.credits).toBe(10);
  });
});

describe('reducer: hireManager', () => {
  it('hires a manager, deducting cost and banking pending ready', () => {
    const s = initialState();
    s.run.credits = 1000;
    s.run.tiers[0].owned = 1;
    s.run.tiers[0].ready = 20;
    const { state: s2, result } = applyAction(s, { type: 'hireManager', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(s2.run.tiers[0].manager).toBe(true);
    expect(s2.run.tiers[0].ready).toBe(0);
    expect(s2.run.credits).toBeCloseTo(1000 - TIER_DEFS[0].managerCost + 20);
  });
  it('rejects an already-automated tier', () => {
    const s = initialState();
    s.run.credits = 1000;
    s.run.tiers[0].owned = 1;
    s.run.tiers[0].manager = true;
    const { result } = applyAction(s, { type: 'hireManager', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'already_automated' });
  });
  it('rejects when the tier is unowned', () => {
    const s = initialState();
    s.run.credits = 1e9;
    const { result } = applyAction(s, { type: 'hireManager', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'insufficient_credits' });
  });
  it('rejects when unaffordable', () => {
    const s = initialState();
    s.run.tiers[0].owned = 1; // credits stay at 10, managerCost is 500
    const { result } = applyAction(s, { type: 'hireManager', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'insufficient_credits' });
  });
  it('rejects out-of-range index', () => {
    const s = initialState();
    const { result } = applyAction(s, { type: 'hireManager', index: 999 }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });
  it.each(['push', 'length', -1, 1.5])('rejects non-numeric/out-of-range index %j without throwing', (index) => {
    const s = initialState();
    let out;
    expect(() => { out = applyAction(s, { type: 'hireManager', index }, DEFAULT_CONFIG, NOW); }).not.toThrow();
    expect(out.result).toEqual({ ok: false, error: 'invalid_target' });
    expect(Number.isNaN(out.state.run.credits)).toBe(false);
  });
});

describe('reducer: vent', () => {
  it('vents heat and starts the cooldown', () => {
    const s = initialState();
    s.run.heat = 900;
    const { state: s2, result } = applyAction(s, { type: 'vent' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(s2.run.heat).toBe(400);
    expect(s2.server.lastVentAt).toBe(NOW);
  });
  it('floors heat at 0', () => {
    const s = initialState();
    s.run.heat = 100;
    const { state: s2 } = applyAction(s, { type: 'vent' }, DEFAULT_CONFIG, NOW);
    expect(s2.run.heat).toBe(0);
  });
  it('respects cooldown and overheat lockout', () => {
    const s = initialState();
    s.run.heat = 900;
    const a = applyAction(s, { type: 'vent' }, DEFAULT_CONFIG, NOW);
    expect(a.state.run.heat).toBe(400);
    const b = applyAction(a.state, { type: 'vent' }, DEFAULT_CONFIG, NOW + 1000);
    expect(b.result.error).toBe('cooldown_active');
    s.run.heatCooldownUntil = NOW + 5000;
    expect(applyAction(s, { type: 'vent' }, DEFAULT_CONFIG, NOW).result.error).toBe('cooldown_active');
  });

  // v1.6: the two cases above are unchanged from v1.5 on purpose - 25% of the
  // default 2000 capacity is exactly the 500 flat amount it replaced, so the
  // unit change is balance-neutral at stock settings. What follows is what
  // actually changed.
  it('scales with a raised heat capacity', () => {
    const cfg = { ...DEFAULT_CONFIG, heat: { ...DEFAULT_CONFIG.heat, capacity: 4000 } };
    const s = initialState();
    s.run.heat = 3000;
    const { state: s2 } = applyAction(s, { type: 'vent' }, cfg, NOW);
    // 25% of 4000 = 1000, where the old flat 500 would have been diluted
    expect(s2.run.heat).toBe(2000);
  });

  it('includes the Cold Storage heatCapacityBonus in the capacity it vents against', () => {
    const s = initialState();
    s.meta.coldStorage.upgrades.heatsinktapes = 4;   // +100 capacity per level
    expect(computeColdStorageEffects(s.meta, DEFAULT_CONFIG).heatCapacityBonus).toBe(400);
    s.run.heat = 1000;
    const { state: s2 } = applyAction(s, { type: 'vent' }, DEFAULT_CONFIG, NOW);
    // 25% of (2000 + 400) = 600
    expect(s2.run.heat).toBe(400);
  });

  it('never goes negative even at a 100% vent', () => {
    const cfg = { ...DEFAULT_CONFIG, heat: { ...DEFAULT_CONFIG.heat, ventPercent: 100 } };
    const s = initialState();
    s.run.heat = 50;
    const { state: s2 } = applyAction(s, { type: 'vent' }, cfg, NOW);
    expect(s2.run.heat).toBe(0);
  });
});

describe('buySupply (v1.11)', () => {
  it('buys one, charges credits, and stacks', () => {
    const s = initialState();
    s.run.credits = 1e9;
    const { state: s1, result: r1 } = applyAction(s, { type: 'buySupply', id: 'antivirus' }, DEFAULT_CONFIG, 1000);
    expect(r1.ok).toBe(true);
    expect(s1.meta.supplies.antivirus).toBe(1);
    expect(s1.run.credits).toBeLessThan(1e9);

    const { state: s2 } = applyAction(s1, { type: 'buySupply', id: 'antivirus' }, DEFAULT_CONFIG, 1000);
    expect(s2.meta.supplies.antivirus).toBe(2);
  });

  it('rejects an unknown supply id without touching anything', () => {
    const s = initialState();
    s.run.credits = 1e9;
    const { state: s1, result } = applyAction(s, { type: 'buySupply', id: '__proto__' }, DEFAULT_CONFIG, 1000);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
    expect(s1.run.credits).toBe(1e9);
  });

  it('rejects when the player cannot afford it', () => {
    const s = initialState();
    s.run.credits = 0;
    const { result } = applyAction(s, { type: 'buySupply', id: 'backupIsp' }, DEFAULT_CONFIG, 1000);
    expect(result).toEqual({ ok: false, error: 'insufficient_credits' });
  });

  it('supplies survive a Migrate', () => {
    const s = initialState();
    s.meta.supplies.spareDrives = 3;
    s.run.lifetimeRun = 1e12;
    const { state: s1, result } = applyAction(s, { type: 'migrate' }, DEFAULT_CONFIG, 1000);
    expect(result.ok).toBe(true);
    expect(s1.meta.supplies.spareDrives).toBe(3);
  });
});
