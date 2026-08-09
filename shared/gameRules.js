import { GROWTH, MILESTONES, OVERCLOCK_DEFS } from './gameData.js';
import { computeColdStorageEffects } from './coldStorage.js';

export function costAt(def, owned) {
  return def.baseCost * Math.pow(GROWTH, owned);
}
export function costForN(def, owned, n) {
  if (n <= 0) return 0;
  const c0 = costAt(def, owned);
  return c0 * (Math.pow(GROWTH, n) - 1) / (GROWTH - 1);
}
export function maxAffordable(def, owned, credits) {
  const c0 = costAt(def, owned);
  if (credits < c0) return 0;
  const n = Math.floor(Math.log(1 + (credits * (GROWTH - 1)) / c0) / Math.log(GROWTH));
  return Math.max(n, 0);
}
export function milestoneMult(owned, thresholds) {
  let count = 0;
  for (const t of thresholds) if (owned >= t) count++;
  return Math.pow(2, count);
}
export function nextMilestone(owned, thresholds) {
  return thresholds.find((t) => owned < t) || null;
}
export function tierRate(owned, baseProd, mult, thresholds) {
  return owned * baseProd * mult * milestoneMult(owned, thresholds);
}
export function fmt(n) {
  if (!isFinite(n)) return '∞';
  if (n < 0) return '-' + fmt(-n);
  if (n < 1000) {
    if (n === 0) return '0';
    if (n < 10) return n.toFixed(2);
    if (n < 100) return n.toFixed(1);
    return Math.floor(n).toString();
  }
  const suffixes = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q'];
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier >= suffixes.length) return n.toExponential(2);
  const scaled = n / Math.pow(1000, tier);
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  return scaled.toFixed(decimals) + suffixes[tier];
}
export function xpForLevel(level) {
  return Math.floor(50 * Math.pow(level + 1, 1.6));
}

export function computeEffects(meta, config) {
  const lv = meta.upgrades || {};
  const sv = meta.shardUpgrades || {};
  return {
    firmwareMult: 1 + 0.10 * (lv.firmware || 0),
    engineMult: 1 + 0.50 * (sv.engine || 0),
    automationDiscount: Math.max(0.5, 1 - 0.04 * (lv.psu || 0)),
    offlineCapHours: config.offline.baseCapHours + config.offline.capPerUptimeLevel * (lv.uptime || 0),
    eventRewardMult: 1 + 0.20 * (lv.signal || 0),
    gridExtraMult: 1 + 0.25 * (lv.gridamp || 0),
    overclockExtraMult: 1 + 0.25 * (lv.occlock || 0),
    legacyGainMult: (1 + 0.10 * (lv.legacy || 0)) * (1 + 0.25 * (sv.temporal || 0)),
    levelBonusMult: 1 + 0.02 * (meta.level || 0),
    heatDiscount: Math.max(0.15, 1 - 0.08 * (lv.thermal || 0) - 0.25 * (sv.heatsink || 0)),
    autoVentPerSec: 0.5 * (lv.autovent || 0),
    luckyMinigameMult: 1 + 0.15 * (lv.lucky || 0),
    deepCacheBonus: 10 * (lv.deepcache || 0),
    bootstrapMult: Math.pow(10, sv.bootstrap || 0),
    milestoneDiscount: Math.max(0.3, 1 - 0.10 * (sv.infiniteloop || 0)),
    echoCoresBonus: sv.echocores || 0,
  };
}

/**
 * The milestone thresholds with the `infiniteloop` discount applied.
 *
 * Extracted from computeMults so the reducer can reach the same numbers
 * without computing a full multiplier bundle it does not need. There must be
 * exactly one expression of this: a second copy and the buy target would drift
 * from the multiplier the player actually earns.
 */
export function milestoneThresholds(meta, config) {
  const eff = computeEffects(meta, config);
  return MILESTONES.map((t) => Math.max(1, Math.round(t * eff.milestoneDiscount)));
}

export function computeMults(meta, config, boostMult = 1) {
  const eff = computeEffects(meta, config);
  const thresholds = milestoneThresholds(meta, config);
  const base = (1 + (meta.legacyCores || 0) * 0.05) * eff.firmwareMult * eff.engineMult
    * eff.levelBonusMult * boostMult * config.production.globalMult;
  // coldFusionMult folded in here (not applied ad-hoc by each caller) so
  // every consumer of computeMults - evaluate()'s online/offline branches,
  // goalCtx (goals/repeatables/anomaly rewards/block FLOPS bonus), and the
  // client's render-time computeMults call for displayed rates - inherits
  // the Cold Fusion tape-upgrade bonus automatically from this single
  // source, instead of some call sites applying it and others silently not.
  const coldFusionMult = computeColdStorageEffects(meta, config).coldFusionMult;
  return {
    eff,
    thresholds,
    racksMult: base * config.production.racksMult * coldFusionMult,
    gridMult: base * eff.gridExtraMult * config.production.gridMult * coldFusionMult,
    overclockMult: base * eff.overclockExtraMult * config.production.overclockMult * coldFusionMult,
  };
}

/**
 * v1.11: the Racks-output multiplier contributed by the Overclock lane.
 *
 * Overclock nodes no longer produce FLOPS directly - OVERCLOCK_DEFS[].baseProd
 * is now a BOOST CONTRIBUTION. The lane's would-be output is expressed as a
 * fraction of the Racks lane's:
 *
 *   boost = 1 + gain * overclockOutput / racksOutput
 *
 * At the default gain of 1 that is algebraically racksOutput +
 * overclockOutput, so a mid-game save's total output is UNCHANGED across the
 * deploy - which is what lets the existing goals/contracts/achievements suites
 * pass untouched, and turns the balance pass into one tunable rather than a
 * re-costing exercise. Raising risk.overclockBoostGain is how the lane becomes
 * worth pushing.
 *
 * Returns exactly 1 when there is nothing to amplify (racksOutput <= 0) or
 * nothing amplifying it, so an untouched save is unaffected.
 */
export function overclockBoost(run, config, overclockMult, thresholds, racksOutput) {
  if (!(racksOutput > 0)) return 1;
  const gain = config.risk.overclockBoostGain;
  if (!(gain > 0)) return 1;
  const ocOutput = run.overclock.reduce((sum, o, i) => {
    const def = OVERCLOCK_DEFS[i];
    if (!def || !o || o.owned === 0) return sum;
    return sum + tierRate(o.owned, def.baseProd, overclockMult, thresholds);
  }, 0);
  if (ocOutput <= 0) return 1;
  return 1 + gain * (ocOutput / racksOutput);
}

export function migrateGain(lifetimeRun, legacyGainMult) {
  return Math.floor(Math.sqrt(lifetimeRun / 1e6) * legacyGainMult);
}

export function minigameWafers(game, metric, meta, config) {
  const lucky = computeEffects(meta, config).luckyMinigameMult;
  const mg = config.minigames;
  if (game === 'rush') return Math.max(1, Math.floor((metric / mg.rush.waferDivisor) * lucky));
  if (game === 'debug') return Math.max(1, Math.floor((metric / mg.debug.waferDivisor) * lucky));
  if (game === 'match') return Math.floor(metric * mg.match.waferPerPair * lucky);
  if (game === 'balance') return Math.max(1, Math.floor(metric * 1.5 * lucky));
  throw new Error(`unknown game: ${game}`);
}
