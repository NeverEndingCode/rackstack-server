import { describe, it, expect } from 'vitest';
import {
  scopeCovers, activeAt, pruneExpired, effectiveFactor, laneOutageFor,
} from '../shared/outages.js';

const at = (startAt, endAt, factor, scope, extra = {}) => ({
  id: `o${startAt}-${endAt}`, kind: 'test', scope, factor, startAt, endAt,
  source: 'hazard', ...extra,
});

describe('scopeCovers', () => {
  it('a wildcard covers every lane and index', () => {
    expect(scopeCovers({ lane: '*' }, 'tiers', 3)).toBe(true);
    expect(scopeCovers({ lane: '*' }, 'grid', 0)).toBe(true);
  });
  it('a bare lane scope covers every index in that lane only', () => {
    expect(scopeCovers({ lane: 'grid' }, 'grid', 4)).toBe(true);
    expect(scopeCovers({ lane: 'grid' }, 'tiers', 4)).toBe(false);
  });
  it('an indexed scope covers exactly one index', () => {
    expect(scopeCovers({ lane: 'tiers', index: 2 }, 'tiers', 2)).toBe(true);
    expect(scopeCovers({ lane: 'tiers', index: 2 }, 'tiers', 3)).toBe(false);
  });
  it('never covers coldstorage, whatever the scope', () => {
    expect(scopeCovers({ lane: '*' }, 'coldstorage', 0)).toBe(false);
  });
});

describe('effectiveFactor', () => {
  it('is exactly 1 with no outages', () => {
    expect(effectiveFactor([], 'tiers', 0, 0, 1000)).toBe(1);
    expect(effectiveFactor(undefined, 'tiers', 0, 0, 1000)).toBe(1);
  });

  it('an outage entirely outside the window contributes nothing', () => {
    const o = [at(5000, 6000, 0, { lane: '*' })];
    expect(effectiveFactor(o, 'tiers', 0, 0, 1000)).toBe(1);
    expect(effectiveFactor(o, 'tiers', 0, 7000, 8000)).toBe(1);
  });

  it('an outage covering the whole window is its factor', () => {
    const o = [at(0, 1000, 0.5, { lane: '*' })];
    expect(effectiveFactor(o, 'tiers', 0, 0, 1000)).toBe(0.5);
  });

  it('one straddling an edge contributes exactly its overlap', () => {
    // 0-factor over [500,1500); window [0,1000) -> half the window dark.
    const o = [at(500, 1500, 0, { lane: '*' })];
    expect(effectiveFactor(o, 'tiers', 0, 0, 1000)).toBeCloseTo(0.5, 12);
    // and the leading edge, same shape
    const p = [at(-500, 500, 0, { lane: '*' })];
    expect(effectiveFactor(p, 'tiers', 0, 0, 1000)).toBeCloseTo(0.5, 12);
  });

  it('overlapping outages multiply inside the overlap', () => {
    // [0,1000) at 0.5 everywhere, plus [0,500) at 0.5 -> 0.25 then 0.5
    const o = [at(0, 1000, 0.5, { lane: '*' }), at(0, 500, 0.5, { lane: 'tiers' })];
    // (500*0.25 + 500*0.5) / 1000
    expect(effectiveFactor(o, 'tiers', 0, 0, 1000)).toBeCloseTo(0.375, 12);
  });

  it('ransomware during an ISP outage leaves Grid at 0 and racks at 0.5', () => {
    const o = [at(0, 1000, 0.5, { lane: '*' }), at(0, 1000, 0, { lane: 'grid' })];
    expect(effectiveFactor(o, 'grid', 0, 0, 1000)).toBe(0);
    expect(effectiveFactor(o, 'tiers', 0, 0, 1000)).toBe(0.5);
  });

  it('only the scoped index is affected', () => {
    const o = [at(0, 1000, 0, { lane: 'tiers', index: 2 })];
    expect(effectiveFactor(o, 'tiers', 2, 0, 1000)).toBe(0);
    expect(effectiveFactor(o, 'tiers', 1, 0, 1000)).toBe(1);
  });

  it('a zero-length or inverted window is 1, never NaN', () => {
    const o = [at(0, 1000, 0, { lane: '*' })];
    expect(effectiveFactor(o, 'tiers', 0, 500, 500)).toBe(1);
    expect(effectiveFactor(o, 'tiers', 0, 600, 500)).toBe(1);
  });

  // The closed form must be EXACT, not an approximation - this cross-checks a
  // messy overlapping case against brute-force numeric sampling.
  it('matches a brute-force integral on overlapping, partially-covering outages', () => {
    const messy = [
      at(120, 880, 0.5, { lane: '*' }),
      at(300, 600, 0.25, { lane: 'tiers' }),
      at(700, 1400, 0, { lane: 'tiers', index: 0 }),
    ];
    const N = 200000;
    let acc = 0;
    for (let i = 0; i < N; i++) {
      const t = 1000 * ((i + 0.5) / N);
      let f = 1;
      for (const o of messy) {
        if (scopeCovers(o.scope, 'tiers', 0) && o.startAt <= t && t < o.endAt) f *= o.factor;
      }
      acc += f;
    }
    expect(effectiveFactor(messy, 'tiers', 0, 0, 1000)).toBeCloseTo(acc / N, 4);
  });
});

describe('activeAt / pruneExpired / laneOutageFor', () => {
  it('activeAt is half-open [startAt, endAt)', () => {
    const o = [at(100, 200, 0, { lane: '*' })];
    expect(activeAt(o, 99)).toHaveLength(0);
    expect(activeAt(o, 100)).toHaveLength(1);
    expect(activeAt(o, 199)).toHaveLength(1);
    expect(activeAt(o, 200)).toHaveLength(0);
  });

  it('pruneExpired drops the finished and keeps the running, without mutating', () => {
    const o = [at(0, 100, 0, { lane: '*' }), at(0, 500, 0, { lane: '*' })];
    const kept = pruneExpired(o, 200);
    expect(kept).toHaveLength(1);
    expect(kept[0].endAt).toBe(500);
    expect(o).toHaveLength(2);
  });

  it('laneOutageFor returns the most severe cover, or null', () => {
    const o = [at(0, 500, 0.5, { lane: '*' }), at(0, 500, 0, { lane: 'grid' })];
    expect(laneOutageFor(o, 'grid', 0, 100).factor).toBe(0);
    expect(laneOutageFor(o, 'tiers', 0, 100).factor).toBe(0.5);
    expect(laneOutageFor(o, 'tiers', 0, 900)).toBeNull();
  });
});
