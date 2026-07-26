// Thin re-export barrel over @shared/gameRules.js. All game math (costs,
// production rates, milestones, XP curve, migrate gain, effect multipliers)
// lives in one place now, shared verbatim between the client's optimistic
// prediction and the server's authoritative reducer/evaluate. Nothing here
// duplicates that math - components keep importing from './helpers.js' (or
// '../helpers.js', etc.) unchanged; only the source moved.
export {
  costAt, costForN, maxAffordable, milestoneMult, nextMilestone, tierRate,
  fmt, xpForLevel, computeEffects, computeMults, migrateGain,
} from '@shared/gameRules.js';
