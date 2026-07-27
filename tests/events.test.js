import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import {
  EVENT_METRIC_IDS, eventMetricValue, mergeEventModifiers,
  validateModifiers, validateLadder, rungProgress,
} from '../shared/events.js';

const meta = {
  stats: {
    lifetimeFlopsAllTime: 1000, minigamesWon: 5, blocksClaimedLifetime: 7,
    tapesEarnedLifetime: 42, totalWafersEarned: 90,
  },
};

describe('event metrics', () => {
  it('exposes exactly the five spec metrics', () => {
    expect(EVENT_METRIC_IDS.sort()).toEqual(
      ['blocksClaimed', 'flopsEarned', 'minigamesWon', 'tapesEarned', 'wafersEarned'],
    );
  });
  it('reads each metric off meta.stats', () => {
    expect(eventMetricValue('flopsEarned', meta)).toBe(1000);
    expect(eventMetricValue('tapesEarned', meta)).toBe(42);
  });
  it('returns null for unknown/prototype-key metrics instead of throwing', () => {
    for (const bad of ['nope', '__proto__', 'toString', 'constructor', '', null, 42]) {
      expect(eventMetricValue(bad, meta)).toBeNull();
    }
  });
});

describe('mergeEventModifiers', () => {
  it('applies modifiers without mutating the base', () => {
    const base = structuredClone(DEFAULT_CONFIG);
    const merged = mergeEventModifiers(base, [{ path: 'production.gridMult', value: 2 }]);
    expect(merged.production.gridMult).toBe(2);
    expect(base.production.gridMult).toBe(1); // base untouched
  });
  it('applies multiple modifiers', () => {
    const merged = mergeEventModifiers(DEFAULT_CONFIG, [
      { path: 'production.globalMult', value: 3 },
      { path: 'heat.capacity', value: 5000 },
    ]);
    expect(merged.production.globalMult).toBe(3);
    expect(merged.heat.capacity).toBe(5000);
  });

  // Regression: mergeEventModifiers must be safe on unvalidated input, not
  // just on input that has already passed validateModifiers. setAtPath
  // walks path.split('.') with plain `cur[k]` assignment and no own-key
  // guard, so a path like '__proto__.polluted' reaches Object.prototype and
  // corrupts it process-wide. If the TUNABLE_PATHS guard in
  // mergeEventModifiers were removed, `({}).polluted` below would read back
  // 'PWNED' instead of undefined — these assertions fail loudly in that case.
  it('does not pollute Object.prototype via __proto__.<key> paths', () => {
    mergeEventModifiers(DEFAULT_CONFIG, [{ path: '__proto__.polluted', value: 'PWNED' }]);
    expect(({}).polluted).toBeUndefined();
  });
  it('does not pollute Object.prototype via constructor.prototype.<key> paths', () => {
    mergeEventModifiers(DEFAULT_CONFIG, [{ path: 'constructor.prototype.polluted', value: 'PWNED' }]);
    expect(({}).polluted).toBeUndefined();
  });
  it('does not pollute Object.prototype via a bare __proto__ path', () => {
    mergeEventModifiers(DEFAULT_CONFIG, [{ path: '__proto__', value: { polluted: 'PWNED' } }]);
    expect(({}).polluted).toBeUndefined();
  });
  it('skips a hostile modifier but still applies a valid one in the same array', () => {
    const merged = mergeEventModifiers(DEFAULT_CONFIG, [
      { path: '__proto__.polluted', value: 'PWNED' },
      { path: 'production.gridMult', value: 2 },
    ]);
    expect(merged.production.gridMult).toBe(2);
    expect(({}).polluted).toBeUndefined();
  });
});

describe('validateModifiers', () => {
  it('accepts valid in-range modifiers', () => {
    expect(validateModifiers([{ path: 'production.gridMult', value: 2 }]).ok).toBe(true);
    expect(validateModifiers([]).ok).toBe(true);
  });
  it('rejects unknown paths, prototype keys, non-numeric and out-of-range values', () => {
    expect(validateModifiers([{ path: 'nope.nope', value: 1 }]).ok).toBe(false);
    expect(validateModifiers([{ path: '__proto__', value: 1 }]).ok).toBe(false);
    expect(validateModifiers([{ path: 'production.gridMult', value: 'x' }]).ok).toBe(false);
    expect(validateModifiers([{ path: 'production.gridMult', value: 9999 }]).ok).toBe(false); // max 100
    expect(validateModifiers('not-an-array').ok).toBe(false);
  });
});

describe('validateLadder', () => {
  const good = [
    { metric: 'flopsEarned', target: 100, reward: { wafers: 5 } },
    { metric: 'flopsEarned', target: 500, reward: { wafers: 10, tapes: 2 } },
  ];
  it('accepts a well-formed ladder', () => {
    expect(validateLadder(good).ok).toBe(true);
  });
  it('rejects empty, oversized, bad-metric, non-increasing, and rewardless ladders', () => {
    expect(validateLadder([]).ok).toBe(false);
    expect(validateLadder(new Array(21).fill(good[0])).ok).toBe(false);
    expect(validateLadder([{ metric: 'bogus', target: 1, reward: { wafers: 1 } }]).ok).toBe(false);
    expect(validateLadder([{ metric: 'flopsEarned', target: 500, reward: { wafers: 1 } },
                           { metric: 'flopsEarned', target: 100, reward: { wafers: 1 } }]).ok).toBe(false);
    expect(validateLadder([{ metric: 'flopsEarned', target: 1, reward: {} }]).ok).toBe(false);
    expect(validateLadder([{ metric: 'flopsEarned', target: -1, reward: { wafers: 1 } }]).ok).toBe(false);
  });
  it('allows independent progressions per metric', () => {
    expect(validateLadder([
      { metric: 'flopsEarned', target: 100, reward: { wafers: 1 } },
      { metric: 'minigamesWon', target: 2, reward: { wafers: 1 } },
      { metric: 'flopsEarned', target: 200, reward: { wafers: 1 } },
    ]).ok).toBe(true);
  });
});

describe('rungProgress', () => {
  it('measures the delta since baseline, floored at 0', () => {
    const rung = { metric: 'flopsEarned', target: 500, reward: { wafers: 1 } };
    expect(rungProgress(rung, meta, { flopsEarned: 400 })).toEqual({ current: 600, target: 500, met: true });
    expect(rungProgress(rung, meta, { flopsEarned: 900 })).toEqual({ current: 100, target: 500, met: false });
    expect(rungProgress(rung, meta, {})).toEqual({ current: 1000, target: 500, met: true });
  });
});
