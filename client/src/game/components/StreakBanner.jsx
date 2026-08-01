import { Flame } from 'lucide-react';
import { amber, textMain, textDim } from '../theme.js';
import { fmt } from '../helpers.js';
import { utcDateKey } from '@shared/daily.js';
import { canClaimStreak, nextStreakCount, streakReward } from '@shared/streak.js';

function rewardLabel(reward) {
  const parts = [];
  if (reward.flops > 0) parts.push(`${fmt(reward.flops)} FLOPS`);
  if (reward.wafers > 0) parts.push(`${fmt(reward.wafers)} wafers`);
  if (reward.tapes > 0) parts.push(`${fmt(reward.tapes)} tapes`);
  return parts.join(' + ');
}

// Sticky-header streak banner (v1.5) - same rounded-pill pattern as
// EventBanner/the surge banner in StatsRow.jsx.
//
// The day boundary comes from `serverTime`, never Date.now(): the server owns
// the UTC calendar day this claim is gated on, so a client with a skewed clock
// must not be shown a Claim button the server will reject with invalid_target
// (or, worse, be told it already claimed when it hasn't).
export default function StreakBanner({ streak, serverTime, config, ctx, onClaim }) {
  if (!config || !config.social || !streak) return null;

  const today = utcDateKey(serverTime);
  if (today === null) return null;

  const claimable = canClaimStreak(streak, today);
  const day = claimable ? nextStreakCount(streak, today, config) : streak.count;

  if (!claimable) {
    return (
      <div
        className="mt-2 w-full rounded-lg px-3 py-1.5 text-xs font-mono flex items-center justify-between"
        style={{ background: 'rgba(232,163,61,0.10)', border: `1px solid ${amber}`, color: amber }}
      >
        <span className="flex items-center gap-1.5">
          <Flame size={13} />
          <span style={{ color: textMain }}>Day {day}</span> streak
        </span>
        <span style={{ color: textDim }}>back tomorrow</span>
      </div>
    );
  }

  const reward = streakReward(day, config, ctx);
  return (
    <button
      onClick={onClaim}
      className="mt-2 w-full rounded-lg px-3 py-1.5 text-xs font-mono flex items-center justify-between"
      style={{ background: 'rgba(232,163,61,0.12)', border: `1px solid ${amber}`, color: amber }}
    >
      <span className="flex items-center gap-1.5">
        <Flame size={13} className="event-icon" />
        <span style={{ color: textMain }}>Day {day}</span>
        <span>&middot; {rewardLabel(reward)}</span>
      </span>
      <span className="font-semibold">Claim</span>
    </button>
  );
}
