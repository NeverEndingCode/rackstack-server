// Thin re-export barrel over @shared/gameRules.js. All game math (costs,
// production rates, milestones, XP curve, migrate gain, effect multipliers)
// lives in one place now, shared verbatim between the client's optimistic
// prediction and the server's authoritative reducer/evaluate. Nothing here
// duplicates that math - components keep importing from './helpers.js' (or
// '../helpers.js', etc.) unchanged; only the source moved.
export {
  costAt, costForN, maxAffordable, milestoneMult, nextMilestone, tierRate,
  fmt, xpForLevel, computeEffects, computeMults, migrateGain,
  fmtCores, CORE_FORMATS, CORE_FORMAT_LABELS, CORE_FORMAT_SAMPLES,
  DEFAULT_CORE_FORMAT, normalizeCoreFormat, nextCoreFormat,
} from '@shared/gameRules.js';
