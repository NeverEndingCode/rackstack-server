import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS } from './data/tiers.js';
import { GROWTH, EVENT_MIN_DELAY, EVENT_MAX_DELAY } from './constants.js';

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
export function randEventDelay() {
  return EVENT_MIN_DELAY + Math.random() * (EVENT_MAX_DELAY - EVENT_MIN_DELAY);
}
export function freshTiers() {
  return TIER_DEFS.map((t) => ({ id: t.id, owned: 0, manager: false, ready: 0 }));
}
export function freshGrid() {
  return GRID_DEFS.map((g) => ({ id: g.id, owned: 0 }));
}
export function freshOverclock() {
  return OVERCLOCK_DEFS.map((o) => ({ id: o.id, owned: 0 }));
}
export function initialRun() {
  return {
    credits: 10, lifetimeRun: 0, tiers: freshTiers(), grid: freshGrid(), overclock: freshOverclock(),
    heat: 0, heatCooldownUntil: null,
  };
}
export function initialMeta() {
  return {
    legacyCores: 0, wafers: 0, level: 0, xp: 0,
    goalsCompleted: {}, upgrades: {}, shardUpgrades: {}, repeatable: {},
    singularityShards: 0,
    stats: { migrates: 0, minigamesWon: 0, singularities: 0, totalWafersEarned: 0 },
  };
}
export function computeEffects(meta) {
  const lv = meta.upgrades || {};
  const sv = meta.shardUpgrades || {};
  return {
    firmwareMult: 1 + 0.10 * (lv.firmware || 0),
    engineMult: 1 + 0.50 * (sv.engine || 0),
    automationDiscount: Math.max(0.5, 1 - 0.04 * (lv.psu || 0)),
    offlineCapHours: 4 + (lv.uptime || 0),
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
export function migrateGain(lifetimeRun, legacyGainMult) {
  return Math.floor(Math.sqrt(lifetimeRun / 1e6) * legacyGainMult);
}
