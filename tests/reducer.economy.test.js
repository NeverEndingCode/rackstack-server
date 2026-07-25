import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS } from '../shared/gameData.js';
import { costForN, maxAffordable } from '../shared/gameRules.js';
import { initialState } from '../shared/state.js';
import { applyAction } from '../shared/reducer.js';

const NOW = 1_000_000;

describe('reducer: unknown action', () => {
  it('returns unknown_action for an unrecognized type', () => {
    const s = initialState();
    const { state, result } = applyAction(s, { type: 'nonsense' }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'unknown_action' });
    expect(state).toEqual(s);
    expect(s.run.credits).toBe(10);
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
});
