// Achievements & badges (v1.5, spec §6.3 + design §4.4).
//
// Distinct from goals: NO PAYOUT, pure prestige. Unlocked automatically
// whenever conditions are met - never claimed - so there is no reducer action
// here and no reward field on any def. Displayed as the badge case in the
// Social tab and as mini-icons on leaderboard rows.
//
// Conditions are written against the SAME ctx object the goal system uses
// (goalCtx from shared/goals.js), so an achievement condition and a goal
// condition are interchangeable in style and neither can drift from the
// other's view of the world.

import { goalCtx, GOAL_DEFS } from './goals.js';

const st = (ctx, key) => {
  const v = ctx.meta.stats[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
};

// `icon` is a lucide-react icon NAME, resolved to a component on the client
// (client/src/game/data/achievementIcons.js). shared/ must not import from
// client/, and must stay free of runtime dependencies.
//
// Every def carries EXACTLY ONE of two forms, never both and never neither
// (tests/achievements.test.js enforces this):
//
//   - SCALAR: `progress: (ctx) => number` plus `target: number`. The unlock is
//     derived from the progress (see isAchievementMet), so the bar the player
//     sees and the condition that fires can never disagree - there is one
//     threshold expressed once, not a bar and a condition kept in sync by hand.
//   - BOOLEAN: `condition: (ctx) => boolean`, for the two achievements that
//     are genuinely a yes/no with no meaningful "partway" to draw.
export const ACHIEVEMENT_DEFS = [
  { id: 'first_migrate', name: 'Fresh Rack', desc: 'Complete your first Migrate', icon: 'RefreshCw', tier: 'bronze', progress: (c) => st(c, 'migrates'), target: 1 },
  { id: 'ten_migrates', name: 'Serial Rebuilder', desc: 'Complete 10 Migrates', icon: 'RefreshCw', tier: 'silver', progress: (c) => st(c, 'migrates'), target: 10 },
  { id: 'first_singularity', name: 'Event Horizon', desc: 'Trigger your first Singularity', icon: 'Sparkles', tier: 'silver', progress: (c) => st(c, 'singularities'), target: 1 },
  { id: 'five_singularities', name: 'Heat Death', desc: 'Trigger 5 Singularities', icon: 'Sparkles', tier: 'gold', progress: (c) => st(c, 'singularities'), target: 5 },
  { id: 'jackpot', name: 'Jackpot', desc: 'Claim the block-16 jackpot in Cold Storage', icon: 'Gift', tier: 'silver', condition: (c) => !!(c.meta.coldStorage && c.meta.coldStorage.blocksClaimed && c.meta.coldStorage.blocksClaimed[15]) },
  { id: 'deep_scrub', name: 'Deep Scrub', desc: 'Complete a Deep Archive Scrub', icon: 'Archive', tier: 'silver', progress: (c) => st(c, 'deepJobsCompletedLifetime'), target: 1 },
  // Math.max(0, ...[]) is 0, so a save with no Cold Storage upgrades reports
  // no progress rather than -Infinity.
  { id: 'tape_master', name: 'Tape Master', desc: 'Max out any tape-tree upgrade', icon: 'Layers', tier: 'gold', progress: (c) => Math.max(0, ...Object.values((c.meta.coldStorage && c.meta.coldStorage.upgrades) || {})), target: 10 },
  { id: 'level_10', name: 'Junior Sysadmin', desc: 'Reach level 10', icon: 'ChevronsUp', tier: 'bronze', progress: (c) => c.meta.level || 0, target: 10 },
  { id: 'level_25', name: 'Senior Sysadmin', desc: 'Reach level 25', icon: 'ChevronsUp', tier: 'silver', progress: (c) => c.meta.level || 0, target: 25 },
  { id: 'level_50', name: 'Principal Sysadmin', desc: 'Reach level 50', icon: 'ChevronsUp', tier: 'gold', progress: (c) => c.meta.level || 0, target: 50 },
  { id: 'flops_g', name: 'Gigaflop', desc: 'Earn 1G FLOPS all-time', icon: 'Cpu', tier: 'bronze', progress: (c) => st(c, 'lifetimeFlopsAllTime'), target: 1e9 },
  { id: 'flops_t', name: 'Teraflop', desc: 'Earn 1T FLOPS all-time', icon: 'Cpu', tier: 'silver', progress: (c) => st(c, 'lifetimeFlopsAllTime'), target: 1e12 },
  { id: 'flops_p', name: 'Petaflop', desc: 'Earn 1P FLOPS all-time', icon: 'Cpu', tier: 'gold', progress: (c) => st(c, 'lifetimeFlopsAllTime'), target: 1e15 },
  { id: 'gamer', name: 'Cycle Burner', desc: 'Win 100 minigames', icon: 'Gamepad2', tier: 'silver', progress: (c) => st(c, 'minigamesWon'), target: 100 },
  { id: 'event_joined', name: 'Showed Up', desc: 'Take part in a live event', icon: 'Trophy', tier: 'bronze', condition: (c) => !!c.meta.eventProgress || (Array.isArray(c.meta.pendingEventClaims) && c.meta.pendingEventClaims.length > 0) },
  { id: 'event_champion', name: 'Event Champion', desc: 'Claim the top rung of a live event ladder', icon: 'Crown', tier: 'gold', progress: (c) => st(c, 'eventTopRungs'), target: 1 },
  { id: 'streak_week', name: 'Perfect Uptime', desc: 'Reach a 7-day login streak', icon: 'Flame', tier: 'silver', progress: (c) => st(c, 'bestStreak'), target: 7 },
  { id: 'contractor', name: 'Under Contract', desc: 'Complete 50 daily contracts', icon: 'ClipboardCheck', tier: 'gold', progress: (c) => st(c, 'contractsCompletedLifetime'), target: 50 },
  { id: 'completionist', name: 'Completionist', desc: 'Complete every static goal', icon: 'ListChecks', tier: 'gold', progress: (c) => GOAL_DEFS.filter((g) => c.meta.goalsCompleted[g.id]).length, target: GOAL_DEFS.length },
];

const TIER_ORDER = { gold: 0, silver: 1, bronze: 2 };

export function achievementDef(id) {
  if (typeof id !== 'string' || id === '') return null;
  return ACHIEVEMENT_DEFS.find((d) => d.id === id) || null;
}

/**
 * Whether an achievement is met. Scalar achievements derive this from their
 * own progress, so the bar the player sees and the unlock can never disagree -
 * there is one threshold, not two.
 */
export function isAchievementMet(def, ctx) {
  if (typeof def.condition === 'function') return !!def.condition(ctx);
  return def.progress(ctx) >= def.target;
}

/**
 * { current, target } for a scalar achievement, or null for a boolean one that
 * has no meaningful bar. `current` is NOT clamped to `target` - a player who
 * has 300 of 100 minigame wins reports 300, and it is the caller's job to clamp
 * the width it draws.
 */
export function achievementProgress(def, ctx) {
  if (typeof def.condition === 'function') return null;
  return { current: def.progress(ctx), target: def.target };
}

/**
 * Unlocks every newly-met achievement on `state`, stamping `now`, and returns
 * the ids unlocked by THIS call (so a caller can toast them). Already-held ids
 * are never re-stamped. Mutates `state.meta.achievements` in place - callers on
 * the reducer path pass the already-structuredClone'd state.
 *
 * Deliberately pays nothing: achievements are pure prestige (spec §6.3).
 * A condition (or progress function) that throws on a malformed save must not
 * take down the whole request, so each runs inside a try/catch and a throwing
 * def simply counts as unmet.
 */
export function checkAchievements(state, config, now) {
  const ctx = goalCtx(state, config, now);
  const held = state.meta.achievements;
  const unlocked = [];
  for (const def of ACHIEVEMENT_DEFS) {
    if (Object.prototype.hasOwnProperty.call(held, def.id)) continue;
    let met = false;
    try {
      met = isAchievementMet(def, ctx);
    } catch {
      met = false;
    }
    if (met) {
      held[def.id] = now;
      unlocked.push(def.id);
    }
  }
  return unlocked;
}

/**
 * At most `limit` unlocked ids, gold first, then ACHIEVEMENT_DEFS order.
 * Relies on Array.prototype.sort being stable (guaranteed since ES2019),
 * which is what preserves definition order within a tier.
 */
export function topBadges(achievements, limit = 3) {
  if (!achievements || typeof achievements !== 'object' || Array.isArray(achievements)) return [];
  return ACHIEVEMENT_DEFS
    .filter((d) => Object.prototype.hasOwnProperty.call(achievements, d.id))
    .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier])
    .slice(0, limit)
    .map((d) => d.id);
}
