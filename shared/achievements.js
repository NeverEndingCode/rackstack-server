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
export const ACHIEVEMENT_DEFS = [
  { id: 'first_migrate', name: 'Fresh Rack', desc: 'Complete your first Migrate', icon: 'RefreshCw', tier: 'bronze', condition: (c) => st(c, 'migrates') >= 1 },
  { id: 'ten_migrates', name: 'Serial Rebuilder', desc: 'Complete 10 Migrates', icon: 'RefreshCw', tier: 'silver', condition: (c) => st(c, 'migrates') >= 10 },
  { id: 'first_singularity', name: 'Event Horizon', desc: 'Trigger your first Singularity', icon: 'Sparkles', tier: 'silver', condition: (c) => st(c, 'singularities') >= 1 },
  { id: 'five_singularities', name: 'Heat Death', desc: 'Trigger 5 Singularities', icon: 'Sparkles', tier: 'gold', condition: (c) => st(c, 'singularities') >= 5 },
  { id: 'jackpot', name: 'Jackpot', desc: 'Claim the block-16 jackpot in Cold Storage', icon: 'Gift', tier: 'silver', condition: (c) => !!(c.meta.coldStorage && c.meta.coldStorage.blocksClaimed && c.meta.coldStorage.blocksClaimed[15]) },
  { id: 'deep_scrub', name: 'Deep Scrub', desc: 'Complete a Deep Archive Scrub', icon: 'Archive', tier: 'silver', condition: (c) => st(c, 'deepJobsCompletedLifetime') >= 1 },
  { id: 'tape_master', name: 'Tape Master', desc: 'Max out any tape-tree upgrade', icon: 'Layers', tier: 'gold', condition: (c) => Object.values((c.meta.coldStorage && c.meta.coldStorage.upgrades) || {}).some((lv) => lv >= 10) },
  { id: 'level_10', name: 'Junior Sysadmin', desc: 'Reach level 10', icon: 'ChevronsUp', tier: 'bronze', condition: (c) => (c.meta.level || 0) >= 10 },
  { id: 'level_25', name: 'Senior Sysadmin', desc: 'Reach level 25', icon: 'ChevronsUp', tier: 'silver', condition: (c) => (c.meta.level || 0) >= 25 },
  { id: 'level_50', name: 'Principal Sysadmin', desc: 'Reach level 50', icon: 'ChevronsUp', tier: 'gold', condition: (c) => (c.meta.level || 0) >= 50 },
  { id: 'flops_g', name: 'Gigaflop', desc: 'Earn 1G FLOPS all-time', icon: 'Cpu', tier: 'bronze', condition: (c) => st(c, 'lifetimeFlopsAllTime') >= 1e9 },
  { id: 'flops_t', name: 'Teraflop', desc: 'Earn 1T FLOPS all-time', icon: 'Cpu', tier: 'silver', condition: (c) => st(c, 'lifetimeFlopsAllTime') >= 1e12 },
  { id: 'flops_p', name: 'Petaflop', desc: 'Earn 1P FLOPS all-time', icon: 'Cpu', tier: 'gold', condition: (c) => st(c, 'lifetimeFlopsAllTime') >= 1e15 },
  { id: 'gamer', name: 'Cycle Burner', desc: 'Win 100 minigames', icon: 'Gamepad2', tier: 'silver', condition: (c) => st(c, 'minigamesWon') >= 100 },
  { id: 'event_joined', name: 'Showed Up', desc: 'Take part in a live event', icon: 'Trophy', tier: 'bronze', condition: (c) => !!c.meta.eventProgress || (Array.isArray(c.meta.pendingEventClaims) && c.meta.pendingEventClaims.length > 0) },
  { id: 'event_champion', name: 'Event Champion', desc: 'Claim the top rung of a live event ladder', icon: 'Crown', tier: 'gold', condition: (c) => st(c, 'eventTopRungs') >= 1 },
  { id: 'streak_week', name: 'Perfect Uptime', desc: 'Reach a 7-day login streak', icon: 'Flame', tier: 'silver', condition: (c) => st(c, 'bestStreak') >= 7 },
  { id: 'contractor', name: 'Under Contract', desc: 'Complete 50 daily contracts', icon: 'ClipboardCheck', tier: 'gold', condition: (c) => st(c, 'contractsCompletedLifetime') >= 50 },
  { id: 'completionist', name: 'Completionist', desc: 'Complete every static goal', icon: 'ListChecks', tier: 'gold', condition: (c) => GOAL_DEFS.every((g) => c.meta.goalsCompleted[g.id]) },
];

const TIER_ORDER = { gold: 0, silver: 1, bronze: 2 };

export function achievementDef(id) {
  if (typeof id !== 'string' || id === '') return null;
  return ACHIEVEMENT_DEFS.find((d) => d.id === id) || null;
}

/**
 * Unlocks every newly-met achievement on `state`, stamping `now`, and returns
 * the ids unlocked by THIS call (so a caller can toast them). Already-held ids
 * are never re-stamped. Mutates `state.meta.achievements` in place - callers on
 * the reducer path pass the already-structuredClone'd state.
 *
 * Deliberately pays nothing: achievements are pure prestige (spec §6.3).
 * A condition that throws on a malformed save must not take down the whole
 * request, so each runs inside a try/catch and a throwing condition simply
 * counts as unmet.
 */
export function checkAchievements(state, config, now) {
  const ctx = goalCtx(state, config, now);
  const held = state.meta.achievements;
  const unlocked = [];
  for (const def of ACHIEVEMENT_DEFS) {
    if (Object.prototype.hasOwnProperty.call(held, def.id)) continue;
    let met = false;
    try {
      met = !!def.condition(ctx);
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
