// Daily streak (v1.5, spec §6.4 + design §4.3).
//
// A 7-day escalating claim that stays at the day-7 reward while unbroken. A
// fully missed UTC calendar day resets to day 1 - the same day boundary the
// contracts board uses (shared/daily.js), deliberately, so a player who shows
// up once a day satisfies both at once. Rewards are a bonus, never a content
// gate.

import { daysBetweenDateKeys } from './daily.js';

export function canClaimStreak(streak, today) {
  return !streak || streak.lastClaimDate !== today;
}

export function nextStreakCount(streak, today, config) {
  const max = config.social.streakMaxDay;
  const last = streak && streak.lastClaimDate;
  const gap = daysBetweenDateKeys(last, today);
  // gap === null covers "never claimed" and a malformed stored key; any gap
  // other than exactly 1 covers both a missed day and a stored date at or
  // after today (clock skew / hand-edited save).
  if (gap === null || gap !== 1) return 1;
  const count = typeof streak.count === 'number' && Number.isFinite(streak.count) ? streak.count : 0;
  return Math.min(count + 1, max);
}

/**
 * Reward for reaching `day`. Days 1..3 pay FLOPS scaled to the player's own
 * output (so it stays meaningful across the whole progression curve), days
 * 4..(max-1) pay wafers, and the final day pays tapes on top of the wafer
 * amount. Every branch returns all three keys so callers never have to test
 * for absence.
 */
export function streakReward(day, config, ctx) {
  const s = config.social;
  const out = { flops: 0, wafers: 0, tapes: 0 };
  const clamped = Math.max(1, Math.min(day, s.streakMaxDay));
  const waferAmount = s.streakWaferBase + s.streakWaferPerDay * clamped;

  if (clamped >= s.streakMaxDay) {
    out.tapes = s.streakDay7Tapes;
    out.wafers = waferAmount;
  } else if (clamped > 3) {
    out.wafers = waferAmount;
  } else {
    out.flops = Math.max(0, ctx.totalOutputPerSec * s.streakFlopsSeconds * clamped);
  }
  return out;
}
