import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { nextStreakCount, streakReward, canClaimStreak } from '../shared/streak.js';

const cfg = DEFAULT_CONFIG;

describe('nextStreakCount', () => {
  it('starts at day 1 when there is no prior claim', () => {
    expect(nextStreakCount({ count: 0, lastClaimDate: null }, '2026-07-31', cfg)).toBe(1);
  });
  it('advances by one on a consecutive day', () => {
    expect(nextStreakCount({ count: 3, lastClaimDate: '2026-07-30' }, '2026-07-31', cfg)).toBe(4);
  });
  it('caps at streakMaxDay and stays there while unbroken', () => {
    expect(nextStreakCount({ count: 7, lastClaimDate: '2026-07-30' }, '2026-07-31', cfg)).toBe(7);
  });
  it('resets to 1 after a fully missed day', () => {
    expect(nextStreakCount({ count: 6, lastClaimDate: '2026-07-29' }, '2026-07-31', cfg)).toBe(1);
    expect(nextStreakCount({ count: 6, lastClaimDate: '2026-07-01' }, '2026-07-31', cfg)).toBe(1);
  });
  it('resets to 1 on a malformed or future lastClaimDate', () => {
    expect(nextStreakCount({ count: 5, lastClaimDate: 'nope' }, '2026-07-31', cfg)).toBe(1);
    expect(nextStreakCount({ count: 5, lastClaimDate: '2026-08-05' }, '2026-07-31', cfg)).toBe(1);
  });
});

describe('canClaimStreak', () => {
  it('is false only when already claimed today', () => {
    expect(canClaimStreak({ lastClaimDate: '2026-07-31' }, '2026-07-31')).toBe(false);
    expect(canClaimStreak({ lastClaimDate: '2026-07-30' }, '2026-07-31')).toBe(true);
    expect(canClaimStreak({ lastClaimDate: null }, '2026-07-31')).toBe(true);
  });
});

describe('streakReward', () => {
  const ctx = { totalOutputPerSec: 100, meta: { level: 0 } };
  it('pays FLOPS on days 1-3', () => {
    for (const day of [1, 2, 3]) {
      const r = streakReward(day, cfg, ctx);
      expect(r.flops).toBeGreaterThan(0);
      expect(r.wafers).toBe(0);
      expect(r.tapes).toBe(0);
    }
  });
  it('escalates the FLOPS payout across days 1-3', () => {
    expect(streakReward(2, cfg, ctx).flops).toBeGreaterThan(streakReward(1, cfg, ctx).flops);
    expect(streakReward(3, cfg, ctx).flops).toBeGreaterThan(streakReward(2, cfg, ctx).flops);
  });
  it('pays escalating wafers on days 4-6', () => {
    for (const day of [4, 5, 6]) {
      const r = streakReward(day, cfg, ctx);
      expect(r.wafers).toBeGreaterThan(0);
      expect(r.tapes).toBe(0);
    }
    expect(streakReward(6, cfg, ctx).wafers).toBeGreaterThan(streakReward(4, cfg, ctx).wafers);
  });
  it('pays tapes plus wafers on the final day', () => {
    const r = streakReward(7, cfg, ctx);
    expect(r.tapes).toBe(cfg.social.streakDay7Tapes);
    expect(r.wafers).toBeGreaterThan(0);
  });
  it('never pays a negative or non-finite amount', () => {
    for (let day = 1; day <= cfg.social.streakMaxDay; day++) {
      const r = streakReward(day, cfg, { totalOutputPerSec: 0, meta: { level: 0 } });
      for (const v of Object.values(r)) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
