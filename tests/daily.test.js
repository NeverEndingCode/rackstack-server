import { describe, it, expect } from 'vitest';
import { utcDateKey, daysBetweenDateKeys } from '../shared/daily.js';

describe('utcDateKey', () => {
  it('formats the UTC calendar day', () => {
    expect(utcDateKey(Date.UTC(2026, 6, 31, 12, 0, 0))).toBe('2026-07-31');
    expect(utcDateKey(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe('2026-01-01');
  });
  it('zero-pads month and day', () => {
    expect(utcDateKey(Date.UTC(2026, 8, 5, 23, 59, 59))).toBe('2026-09-05');
  });
  it('uses UTC, not local time, at both edges of the day', () => {
    expect(utcDateKey(Date.UTC(2026, 6, 31, 0, 0, 0))).toBe('2026-07-31');
    expect(utcDateKey(Date.UTC(2026, 6, 31, 23, 59, 59, 999))).toBe('2026-07-31');
    expect(utcDateKey(Date.UTC(2026, 7, 1, 0, 0, 0))).toBe('2026-08-01');
  });
  it('returns null for non-finite input', () => {
    for (const bad of [NaN, Infinity, null, undefined, 'x']) {
      expect(utcDateKey(bad)).toBeNull();
    }
  });
});

describe('daysBetweenDateKeys', () => {
  it('counts whole days forward', () => {
    expect(daysBetweenDateKeys('2026-07-30', '2026-07-31')).toBe(1);
    expect(daysBetweenDateKeys('2026-07-31', '2026-07-31')).toBe(0);
    expect(daysBetweenDateKeys('2026-07-25', '2026-07-31')).toBe(6);
  });
  it('counts backwards as negative', () => {
    expect(daysBetweenDateKeys('2026-07-31', '2026-07-30')).toBe(-1);
  });
  it('crosses month and year boundaries', () => {
    expect(daysBetweenDateKeys('2026-07-31', '2026-08-01')).toBe(1);
    expect(daysBetweenDateKeys('2026-12-31', '2027-01-01')).toBe(1);
    expect(daysBetweenDateKeys('2028-02-28', '2028-03-01')).toBe(2); // leap year
  });
  it('returns null for malformed keys instead of NaN', () => {
    for (const bad of ['', 'nope', '2026-13-01', '2026-7-1', null, undefined, 42, '__proto__']) {
      expect(daysBetweenDateKeys(bad, '2026-07-31')).toBeNull();
      expect(daysBetweenDateKeys('2026-07-31', bad)).toBeNull();
    }
  });
});
