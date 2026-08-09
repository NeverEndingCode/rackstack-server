// Progression simulator for the mathematical audit.
//
// Drives the REAL shared/ engine (evaluate + applyAction) on a synthetic
// player so the numbers below are the game's own, not a re-implementation.
//
// Usage: node tools/sim.mjs [--hours N] [--profile idle|active|whale]
//                           [--no-anomaly] [--no-risk] [--seed N] [--quiet]

import { initialState, evaluate } from '../shared/state.js';
import { applyAction, scheduleAnomaly } from '../shared/reducer.js';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS, UPGRADE_DEFS } from '../shared/gameData.js';
import { costAt, computeMults, tierRate, fmt, migrateGain, computeEffects } from '../shared/gameRules.js';
import { goalCtx, GOAL_DEFS, REPEATABLE_DEFS } from '../shared/goals.js';
import { scheduleNextHazard, scheduleGridMaintenance } from '../shared/outages.js';
import { rolloverContracts } from '../shared/contracts.js';

const args = process.argv.slice(2);
const argVal = (k, d) => {
  const i = args.indexOf(k);
  return i === -1 ? d : args[i + 1];
};
const HOURS = Number(argVal('--hours', 168));
const PROFILE = argVal('--profile', 'active');
const QUIET = args.includes('--quiet');
const SEED = Number(argVal('--seed', 12345));

// deterministic rng so runs are comparable
let _s = SEED >>> 0;
function rng() {
  _s = (_s + 0x6d2b79f5) >>> 0;
  let t = _s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const config = structuredClone(DEFAULT_CONFIG);
if (args.includes('--no-risk')) config.risk.enabled = false;
const NO_ANOMALY = args.includes('--no-anomaly');

// Profiles: how much of the wall clock the player is actually at the keyboard,
// and how promptly they react to an anomaly / heat.
const PROFILES = {
  idle:   { sessionsPerDay: 2,  sessionMin: 10, anomalyCatch: 0.15, ventEager: false },
  active: { sessionsPerDay: 6,  sessionMin: 30, anomalyCatch: 0.75, ventEager: true },
  whale:  { sessionsPerDay: 16, sessionMin: 60, anomalyCatch: 0.98, ventEager: true },
};
const P = PROFILES[PROFILE];
if (!P) throw new Error(`unknown profile ${PROFILE}`);

let state = initialState();
let t = Date.now();
const T0 = t;
scheduleAnomaly(state.server, config, t, rng);
let lastEval = t;

const log = [];
const milestones = {};
function note(key, extra = {}) {
  if (milestones[key]) return;
  milestones[key] = { atHours: (t - T0) / 3600000, ...extra };
  if (!QUIET) {
    console.log(`  [${((t - T0) / 3600000).toFixed(2)}h] ${key}` +
      (extra.detail ? ` — ${extra.detail}` : ''));
  }
}

// Mirrors server/stateService.js loadEvaluateAndSchedule's scheduling block -
// evaluate() never (re)schedules anomalies or maintenance itself.
function schedule() {
  if (state.server.nextAnomalyAt === 0 ||
      (t > state.server.anomalyExpiresAt && state.server.nextAnomalyAt <= t)) {
    scheduleAnomaly(state.server, config, t, rng);
  }
  if (!(state.server.nextHazardAt > 0)) scheduleNextHazard(state.server, config, t, rng);
  if (!state.server.gridMaintenance) scheduleGridMaintenance(state.server, config, t, rng);
  rolloverContracts(state, config, t);
}

function step(ms) {
  t += ms;
  const r = evaluate(state, config, lastEval, t, rng);
  state = r.state;
  lastEval = t;
  schedule();
}

function act(action) {
  const r = applyAction(state, action, config, t, rng);
  state = r.state;
  return r.result;
}

// --- the bot's purchasing policy ------------------------------------------
// Greedy payback: buy whatever unit repays its own cost fastest. This is the
// policy a competent idle player converges on, so it is the right yardstick
// for "how fast CAN you progress", not a worst case.
function bestBuy() {
  const { racksMult, gridMult, overclockMult, thresholds } = computeMults(state.meta, config, 1);
  let best = null;
  const consider = (lane, i, def, owned, mult) => {
    const cost = costAt(def, owned);
    if (cost > state.run.credits) return;
    // marginal output of one more unit, milestones included
    const now = tierRate(owned, def.baseProd, mult, thresholds);
    const next = tierRate(owned + 1, def.baseProd, mult, thresholds);
    const gain = next - now;
    if (gain <= 0) return;
    const payback = cost / gain;
    if (!best || payback < best.payback) best = { lane, index: i, payback, cost };
  };
  state.run.tiers.forEach((ts, i) => {
    // gate: a tier is only sensible once the previous one is owned
    if (i > 0 && state.run.tiers[i - 1].owned < 1) return;
    consider('tiers', i, TIER_DEFS[i], ts.owned, racksMult);
  });
  state.run.grid.forEach((g, i) => consider('grid', i, GRID_DEFS[i], g.owned, gridMult));
  state.run.overclock.forEach((o, i) => consider('overclock', i, OVERCLOCK_DEFS[i], o.owned, overclockMult));
  return best;
}

function doPurchases() {
  // managers first: they convert an unmanaged tier into idle income
  const eff = computeEffects(state.meta, config);
  for (let i = 0; i < TIER_DEFS.length; i++) {
    const ts = state.run.tiers[i];
    if (ts.owned >= 1 && !ts.manager) {
      const cost = TIER_DEFS[i].managerCost * eff.automationDiscount;
      if (state.run.credits + ts.ready >= cost * 1.5) {
        if (act({ type: 'hireManager', index: i }).ok) note(`manager:${i}`);
      }
    }
  }
  for (let n = 0; n < 400; n++) {
    const b = bestBuy();
    if (!b) break;
    const r = act({ type: 'buy', lane: b.lane, index: b.index, mode: 1 });
    if (!r.ok) break;
    if (b.lane === 'tiers') {
      const owned = state.run.tiers[b.index].owned;
      if (owned === 1) note(`tier:${b.index}:${TIER_DEFS[b.index].name}`);
    }
  }
}

function doClaims() {
  act({ type: 'collectAll' });
  for (const g of GOAL_DEFS) {
    if (!state.meta.goalsCompleted[g.id]) act({ type: 'claimGoal', id: g.id });
  }
  for (const r of REPEATABLE_DEFS) {
    for (let k = 0; k < 40; k++) if (!act({ type: 'claimRepeatable', id: r.id }).ok) break;
  }
  // upgrades: buy anything affordable, cheapest first (wafers are the gate)
  for (let k = 0; k < 60; k++) {
    const affordable = UPGRADE_DEFS
      .map((u) => ({ u, lvl: state.meta.upgrades[u.id] || 0 }))
      .filter(({ u, lvl }) => lvl < config.upgrades.maxLevels[u.id])
      .map(({ u, lvl }) => ({ id: u.id, cost: Math.ceil(u.baseCost * Math.pow(u.costMult, lvl)) }))
      .filter((x) => x.cost <= state.meta.wafers)
      .sort((a, b) => a.cost - b.cost);
    if (!affordable.length) break;
    if (!act({ type: 'buyUpgrade', id: affordable[0].id }).ok) break;
  }
}

function tryAnomaly() {
  if (NO_ANOMALY) return;
  if (rng() > P.anomalyCatch) return;
  act({ type: 'claimAnomaly' });
}

function outputNow() {
  return goalCtx(state, config, t).totalOutputPerSec;
}

// --- the clock -------------------------------------------------------------
const TOTAL_MS = HOURS * 3600000;
const DAY_MS = 86400000;
let boostSecondsActive = 0;
let anomalyClaims = 0;
let overheats = 0;
let hazardsFired = 0;
let onlineSeconds = 0;

if (!QUIET) console.log(`\n=== profile=${PROFILE} hours=${HOURS} risk=${config.risk.enabled} anomaly=${!NO_ANOMALY} ===`);

while (t - T0 < TOTAL_MS) {
  const dayStart = t;
  // spread N sessions across the day
  for (let s = 0; s < P.sessionsPerDay && t - T0 < TOTAL_MS; s++) {
    // gap to next session (offline)
    const gapMs = Math.max(60000, DAY_MS / P.sessionsPerDay - P.sessionMin * 60000);
    step(gapMs);
    if (state.server.overheated) overheats++;
    // session: tick at 5s resolution so anomalies/heat are seen
    const sessionMs = P.sessionMin * 60000;
    for (let e = 0; e < sessionMs; e += 5000) {
      step(5000);
      onlineSeconds += 5;
      if (state.server.overheated) overheats++;
      if (state.server.outageNotices) hazardsFired += state.server.outageNotices.length;
      if (state.server.boost && t < state.server.boost.until) boostSecondsActive += 5;
      const before = state.server.nextAnomalyAt;
      if (state.server.nextAnomalyAt <= t && t <= state.server.anomalyExpiresAt) {
        const r0 = state.meta.wafers;
        tryAnomaly();
        if (state.server.nextAnomalyAt !== before) anomalyClaims++;
      }
      if (P.ventEager && state.run.heat > config.heat.capacity * 0.6) act({ type: 'vent' });
      doPurchases();
      doClaims();
    }
    // cold storage housekeeping
    act({ type: 'claimAllBlocks' });
    if (state.meta.coldStorage.blocksClaimed.every(Boolean)) act({ type: 'resetTrack' });
    if (!state.meta.coldStorage.job) act({ type: 'startJob', jobType: 'deep' });
    act({ type: 'claimJob' });
    act({ type: 'claimStreak' });
    for (let i = 0; i < 3; i++) act({ type: 'claimContract', index: i });

    // migrate when it is clearly worth it: gain would raise cores by >=50%
    const eff = computeEffects(state.meta, config);
    const gain = migrateGain(state.run.lifetimeRun, eff.legacyGainMult);
    if (gain > 0 && gain >= Math.max(1, state.meta.legacyCores * 0.5)) {
      if (act({ type: 'migrate' }).ok) {
        note(`migrate:${state.meta.stats.migrates}`, { detail: `+${gain} cores → ${state.meta.legacyCores}` });
      }
    }
  }
  // day boundary bookkeeping
  const day = Math.floor((t - T0) / DAY_MS);
  const out = outputNow();
  log.push({
    day,
    hours: (t - T0) / 3600000,
    output: out,
    credits: state.run.credits,
    lifetimeAll: state.meta.stats.lifetimeFlopsAllTime,
    cores: state.meta.legacyCores,
    migrates: state.meta.stats.migrates,
    level: state.meta.level,
    wafers: state.meta.wafers,
    tapes: state.meta.coldStorage.tapes,
    topTier: state.run.tiers.reduce((m, ts, i) => (ts.owned > 0 ? i : m), 0),
    heat: state.run.heat,
  });
  if (t - dayStart < 60000) break; // safety
}

const finalOut = outputNow();
console.log(`\n--- ${PROFILE} / ${HOURS}h ---`);
console.log('day | hours |     output/s |   lifetime |  cores | mig | lvl | topTier | heat');
for (const r of log) {
  console.log(
    `${String(r.day).padStart(3)} | ${r.hours.toFixed(0).padStart(5)} | ${fmt(r.output).padStart(12)} | ` +
    `${fmt(r.lifetimeAll).padStart(10)} | ${String(r.cores).padStart(6)} | ${String(r.migrates).padStart(3)} | ` +
    `${String(r.level).padStart(3)} | ${String(r.topTier).padStart(7)} | ${r.heat.toFixed(0).padStart(5)}`);
}
console.log('\nmilestones:');
for (const [k, v] of Object.entries(milestones)) {
  if (k.startsWith('tier:') || k.startsWith('migrate:')) {
    console.log(`  ${v.atHours.toFixed(2).padStart(8)}h  ${k}${v.detail ? ' — ' + v.detail : ''}`);
  }
}
console.log(`\nonline: ${(onlineSeconds / 3600).toFixed(1)}h of ${HOURS}h (${(100 * onlineSeconds / 3600 / HOURS).toFixed(0)}%)`);
console.log(`anomaly claims: ${anomalyClaims}  |  boost uptime while online: ${(100 * boostSecondsActive / onlineSeconds).toFixed(1)}%`);
console.log(`overheats: ${overheats}  |  hazard notices: ${hazardsFired}`);
console.log(`final output/s: ${fmt(finalOut)}  lifetime: ${fmt(state.meta.stats.lifetimeFlopsAllTime)}  cores: ${state.meta.legacyCores}  shards: ${state.meta.singularityShards}`);
console.log(`unlocked tiers: ${state.run.tiers.filter((x) => x.owned > 0).length}/${TIER_DEFS.length}`);
