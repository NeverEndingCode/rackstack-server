export const DEFAULT_CONFIG = {
  schemaVersion: 1,
  heat: { capacity: 2000, ventAmount: 500, ventCooldownMs: 2500, overheatCooldownMs: 10000 },
  minigames: {
    winCooldownMs: 30000,
    rush:  { durationSec: 10, waferDivisor: 4, maxTapsPerSec: 15 },
    debug: { durationSec: 15, spawnMinMs: 400, spawnMaxMs: 900, maxLit: 3, waferDivisor: 2 },
    match: { durationSec: 40, pairCount: 10, waferPerPair: 2 },
    balance: { durationSec: 12, safeZoneMin: 35, safeZoneMax: 65, riskZoneWidth: 4,
               pointsSafe: 1, pointsRisk: 5, missPenalty: 2, maxScore: 150 },
  },
  production: { globalMult: 1, racksMult: 1, gridMult: 1, overclockMult: 1 },
  offline: { baseCapHours: 4, capPerUptimeLevel: 1, hardCapHours: 72, onlineGapThresholdSec: 60 },
  anomaly: { windowMs: 15000, minDelayMs: 70000, maxDelayMs: 150000 },
  upgrades: { maxLevels: {
    firmware: 20, psu: 10, uptime: 8, signal: 10, gridamp: 15, legacy: 10,
    thermal: 8, autovent: 8, occlock: 15, lucky: 10, deepcache: 10,
    bootstrap: 5, temporal: 5, engine: 8, heatsink: 4, infiniteloop: 5, echocores: 10,
  } },
};

export const TUNABLES = [
  { path: 'heat.capacity', label: 'Heat capacity', min: 100, max: 100000, integer: true },
  { path: 'heat.ventAmount', label: 'Vent amount', min: 1, max: 100000, integer: true },
  { path: 'heat.ventCooldownMs', label: 'Vent cooldown (ms)', min: 0, max: 60000, integer: true },
  { path: 'heat.overheatCooldownMs', label: 'Overheat lockout (ms)', min: 0, max: 600000, integer: true },
  { path: 'minigames.winCooldownMs', label: 'Minigame win cooldown (ms)', min: 0, max: 3600000, integer: true },

  { path: 'minigames.rush.durationSec', label: 'Rush duration (s)', min: 1, max: 600, integer: true },
  { path: 'minigames.rush.waferDivisor', label: 'Rush wafer divisor', min: 1, max: 1000, integer: true },
  { path: 'minigames.rush.maxTapsPerSec', label: 'Rush max taps/sec', min: 1, max: 100, integer: true },

  { path: 'minigames.debug.durationSec', label: 'Debug duration (s)', min: 1, max: 600, integer: true },
  { path: 'minigames.debug.spawnMinMs', label: 'Debug spawn min (ms)', min: 0, max: 3600000, integer: true },
  { path: 'minigames.debug.spawnMaxMs', label: 'Debug spawn max (ms)', min: 0, max: 3600000, integer: true },
  { path: 'minigames.debug.maxLit', label: 'Debug max lit', min: 1, max: 100, integer: true },
  { path: 'minigames.debug.waferDivisor', label: 'Debug wafer divisor', min: 1, max: 1000, integer: true },

  { path: 'minigames.match.durationSec', label: 'Match duration (s)', min: 1, max: 600, integer: true },
  { path: 'minigames.match.pairCount', label: 'Match pair count', min: 1, max: 100, integer: true },
  { path: 'minigames.match.waferPerPair', label: 'Match wafer per pair', min: 1, max: 1000, integer: true },

  { path: 'minigames.balance.durationSec', label: 'Balance duration (s)', min: 1, max: 600, integer: true },
  { path: 'minigames.balance.safeZoneMin', label: 'Balance safe zone min', min: 0, max: 100, integer: true },
  { path: 'minigames.balance.safeZoneMax', label: 'Balance safe zone max', min: 0, max: 100, integer: true },
  { path: 'minigames.balance.riskZoneWidth', label: 'Balance risk zone width', min: 0, max: 100, integer: true },
  { path: 'minigames.balance.pointsSafe', label: 'Balance points (safe)', min: 1, max: 1000, integer: true },
  { path: 'minigames.balance.pointsRisk', label: 'Balance points (risk)', min: 1, max: 1000, integer: true },
  { path: 'minigames.balance.missPenalty', label: 'Balance miss penalty', min: 1, max: 1000, integer: true },
  { path: 'minigames.balance.maxScore', label: 'Balance max score', min: 1, max: 10000, integer: true },

  { path: 'production.globalMult', label: 'Global production multiplier', min: 0.1, max: 100, integer: false },
  { path: 'production.racksMult', label: 'Racks production multiplier', min: 0.1, max: 100, integer: false },
  { path: 'production.gridMult', label: 'Grid production multiplier', min: 0.1, max: 100, integer: false },
  { path: 'production.overclockMult', label: 'Overclock production multiplier', min: 0.1, max: 100, integer: false },

  { path: 'offline.baseCapHours', label: 'Offline base cap (hours)', min: 1, max: 168, integer: false },
  { path: 'offline.capPerUptimeLevel', label: 'Offline cap per uptime level (hours)', min: 1, max: 168, integer: false },
  { path: 'offline.hardCapHours', label: 'Offline hard cap (hours)', min: 1, max: 168, integer: false },
  { path: 'offline.onlineGapThresholdSec', label: 'Online gap threshold (s)', min: 10, max: 600, integer: true },

  { path: 'anomaly.windowMs', label: 'Anomaly window (ms)', min: 1000, max: 3600000, integer: true },
  { path: 'anomaly.minDelayMs', label: 'Anomaly min delay (ms)', min: 1000, max: 3600000, integer: true },
  { path: 'anomaly.maxDelayMs', label: 'Anomaly max delay (ms)', min: 1000, max: 3600000, integer: true },

  { path: 'upgrades.maxLevels.firmware', label: 'Max level: Overclocked Firmware', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.psu', label: 'Max level: Redundant PSUs', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.uptime', label: 'Max level: Extended Uptime', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.signal', label: 'Max level: Signal Boost', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.gridamp', label: 'Max level: Grid Amplifier', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.legacy', label: 'Max level: Legacy Insight', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.thermal', label: 'Max level: Thermal Regulators', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.autovent', label: 'Max level: Auto-Vent System', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.occlock', label: 'Max level: Overclock Amplifier', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.lucky', label: 'Max level: Lucky Silicon', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.deepcache', label: 'Max level: Deep Cache', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.bootstrap', label: 'Max level: Quantum Bootstrap', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.temporal', label: 'Max level: Temporal Compression', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.engine', label: 'Max level: Singularity Engine', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.heatsink', label: 'Max level: Heat Sink Mastery', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.infiniteloop', label: 'Max level: Infinite Loop', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.echocores', label: 'Max level: Echo Cores', min: 1, max: 99, integer: true },
];

export function getAtPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function setAtPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) { if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}; cur = cur[k]; }
  cur[last] = value;
}

function collectLeafPaths(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null) out.push(...collectLeafPaths(v, p));
    else out.push(p);
  }
  return out;
}

export function validateConfig(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['not an object'] };
  const allowed = new Set(['schemaVersion', ...TUNABLES.map((t) => t.path)]);
  for (const p of collectLeafPaths(doc)) {
    if (!allowed.has(p)) errors.push(`unknown key: ${p}`);
  }
  for (const t of TUNABLES) {
    const v = getAtPath(doc, t.path);
    if (typeof v !== 'number' || Number.isNaN(v)) { errors.push(`${t.path}: missing or not a number`); continue; }
    if (v < t.min || v > t.max) errors.push(`${t.path}: ${v} outside [${t.min}, ${t.max}]`);
    if (t.integer && !Number.isInteger(v)) errors.push(`${t.path}: must be an integer`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function upgradeConfig(doc) {
  const out = structuredClone(DEFAULT_CONFIG);
  for (const t of TUNABLES) {
    const v = getAtPath(doc || {}, t.path);
    if (typeof v === 'number' && !Number.isNaN(v)) setAtPath(out, t.path, v);
  }
  return out;
}
