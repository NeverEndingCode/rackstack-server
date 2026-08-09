// Daily-player pacing harness. Point it at either shared/ or shared-proposed/
// and it reports when each rack tier / Migrate / Singularity lands.
//
//   SHARED=shared          node tools/pace.mjs   # shipped
//   SHARED=shared-proposed node tools/pace.mjs   # proposal
//
// Player model: one 60-minute session per day, rest of the day offline.
// That is the "daily player" the pacing targets are written against.

const DIR = process.env.SHARED || 'shared';
const DAYS = Number(process.env.DAYS || 45);
const SESSION_MIN = Number(process.env.SESSION_MIN || 60);
const TICKMS = 10000;

const { initialState, evaluate } = await import(`../${DIR}/state.js`);
const { applyAction, scheduleAnomaly } = await import(`../${DIR}/reducer.js`);
const { DEFAULT_CONFIG } = await import(`../${DIR}/configSchema.js`);
const { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS, UPGRADE_DEFS, SINGULARITY_DEFS } = await import(`../${DIR}/gameData.js`);
const { costAt, computeMults, tierRate, fmt, computeEffects, migrateGain } = await import(`../${DIR}/gameRules.js`);
const { goalCtx, GOAL_DEFS, REPEATABLE_DEFS } = await import(`../${DIR}/goals.js`);
const { scheduleNextHazard, scheduleGridMaintenance } = await import(`../${DIR}/outages.js`);
const { rolloverContracts } = await import(`../${DIR}/contracts.js`);

const config = structuredClone(DEFAULT_CONFIG);
let seed = 4242;
const rng = () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let x = seed;
  x = Math.imul(x ^ (x >>> 15), x | 1);
  x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
};

let state = initialState();
let t = Date.now();
const T0 = t;
let lastEval = t;
scheduleAnomaly(state.server, config, t, rng);

const mark = {};
const hoursNow = () => (t - T0) / 3600000;
const daysNow = () => hoursNow() / 24;
function note(k) { if (mark[k] === undefined) mark[k] = daysNow(); }

let overheats = 0, hazards = 0, anomalies = 0, boostSec = 0, sessionSec = 0;

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
  state = r.state; lastEval = t;
  if (state.server.overheated) overheats++;
  if (state.server.outageNotices) hazards += state.server.outageNotices.length;
  schedule();
}
function act(a) { const r = applyAction(state, a, config, t, rng); state = r.state; return r.result; }

function bestBuy() {
  const { racksMult, gridMult, overclockMult, thresholds } = computeMults(state.meta, config, 1);
  let best = null;
  const consider = (lane, i, def, owned, mult) => {
    const cost = costAt(def, owned);
    if (cost > state.run.credits) return;
    const gain = tierRate(owned + 1, def.baseProd, mult, thresholds)
               - tierRate(owned, def.baseProd, mult, thresholds);
    if (gain <= 0) return;
    const pb = cost / gain;
    if (!best || pb < best.payback) best = { lane, index: i, payback: pb };
  };
  state.run.tiers.forEach((ts, i) => {
    if (i > 0 && state.run.tiers[i - 1].owned < 1) return;
    consider('tiers', i, TIER_DEFS[i], ts.owned, racksMult);
  });
  state.run.grid.forEach((g, i) => consider('grid', i, GRID_DEFS[i], g.owned, gridMult));
  state.run.overclock.forEach((o, i) => consider('overclock', i, OVERCLOCK_DEFS[i], o.owned, overclockMult));
  return best;
}

const perDay = [];
for (let d = 0; d < DAYS; d++) {
  // offline until the session
  step(86400000 - SESSION_MIN * 60000);
  // session
  const ticks = (SESSION_MIN * 60000) / TICKMS;
  for (let k = 0; k < ticks; k++) {
    step(TICKMS);
    sessionSec += TICKMS / 1000;
    if (state.server.boost && t < state.server.boost.until) boostSec += TICKMS / 1000;
    if (state.server.nextAnomalyAt <= t && t <= state.server.anomalyExpiresAt) {
      if (act({ type: 'claimAnomaly' }).ok) anomalies++;
    }
    if (state.run.heat > config.heat.capacity * 0.5) act({ type: 'vent' });
    act({ type: 'collectAll' });
    for (let i = 0; i < TIER_DEFS.length; i++) {
      if (state.run.tiers[i].owned >= 1 && !state.run.tiers[i].manager) act({ type: 'hireManager', index: i });
    }
    for (let n = 0; n < 200; n++) {
      const b = bestBuy();
      if (!b) break;
      if (!act({ type: 'buy', lane: b.lane, index: b.index, mode: 1 }).ok) break;
      if (b.lane === 'tiers' && state.run.tiers[b.index].owned === 1) note(`tier${b.index}`);
    }
    if (k % 6 === 0) {
      for (const g of GOAL_DEFS) if (!state.meta.goalsCompleted[g.id]) act({ type: 'claimGoal', id: g.id });
      for (const rp of REPEATABLE_DEFS) for (let z = 0; z < 20; z++) if (!act({ type: 'claimRepeatable', id: rp.id }).ok) break;
      for (let z = 0; z < 30; z++) {
        const aff = UPGRADE_DEFS.map((u) => ({ u, lvl: state.meta.upgrades[u.id] || 0 }))
          .filter(({ u, lvl }) => lvl < config.upgrades.maxLevels[u.id])
          .map(({ u, lvl }) => ({ id: u.id, cost: Math.ceil(u.baseCost * Math.pow(u.costMult, lvl)) }))
          .filter((x) => x.cost <= state.meta.wafers).sort((a, b) => a.cost - b.cost);
        if (!aff.length) break;
        if (!act({ type: 'buyUpgrade', id: aff[0].id }).ok) break;
      }
      for (let z = 0; z < 30; z++) {
        const aff = SINGULARITY_DEFS.map((u) => ({ u, lvl: state.meta.shardUpgrades[u.id] || 0 }))
          .filter(({ u, lvl }) => lvl < config.upgrades.maxLevels[u.id])
          .map(({ u, lvl }) => ({ id: u.id, cost: Math.ceil(u.baseCost * Math.pow(u.costMult, lvl)) }))
          .filter((x) => x.cost <= state.meta.singularityShards).sort((a, b) => a.cost - b.cost);
        if (!aff.length) break;
        if (!act({ type: 'buyShardUpgrade', id: aff[0].id }).ok) break;
      }
      act({ type: 'claimAllBlocks' });
      if (state.meta.coldStorage.blocksClaimed.every(Boolean)) act({ type: 'resetTrack' });
      if (!state.meta.coldStorage.job) act({ type: 'startJob', jobType: 'deep' });
      act({ type: 'claimJob' });
      act({ type: 'claimStreak' });
      for (let i = 0; i < 3; i++) act({ type: 'claimContract', index: i });
    }
  }

  // prestige decisions, once per day at end of session
  const eff = computeEffects(state.meta, config);
  const gain = migrateGain(state.run.lifetimeRun, eff.legacyGainMult);
  // a real player resets when it at least TRIPLES their permanent multiplier
  if (gain > 0 && gain >= Math.max(3, state.meta.legacyCores * 2)) {
    if (act({ type: 'migrate' }).ok) note(`migrate${state.meta.stats.migrates}`);
  }
  const shards = Math.floor(Math.sqrt(state.meta.legacyCores || 0));
  if (shards >= 10 && shards >= state.meta.singularityShards * 1.5) {
    if (act({ type: 'singularity' }).ok) note(`singularity${state.meta.stats.singularities}`);
  }

  perDay.push({
    d: d + 1,
    out: goalCtx(state, config, t).totalOutputPerSec,
    top: state.run.tiers.reduce((m, ts, i) => (ts.owned > 0 ? i : m), 0),
    cores: state.meta.legacyCores,
    shards: state.meta.singularityShards,
    mig: state.meta.stats.migrates,
    sing: state.meta.stats.singularities,
    lvl: state.meta.level,
    wafers: state.meta.stats.totalWafersEarned,
  });
}

console.log(`\n===== ${DIR} — ${SESSION_MIN}min/day, ${DAYS} days =====`);
console.log(' day |     output/s | topTier | cores | shards | mig | sing | lvl | lifetime wafers');
for (const r of perDay) {
  if (r.d <= 10 || r.d % 5 === 0) {
    console.log(String(r.d).padStart(4) + ' | ' + fmt(r.out).padStart(12) + ' | ' + String(r.top).padStart(7) +
      ' | ' + String(r.cores).padStart(5) + ' | ' + String(r.shards).padStart(6) + ' | ' + String(r.mig).padStart(3) +
      ' | ' + String(r.sing).padStart(4) + ' | ' + String(r.lvl).padStart(3) + ' | ' + fmt(r.wafers).padStart(15));
  }
}
console.log('\nfirst reached (in DAYS):');
for (let i = 0; i < TIER_DEFS.length; i++) {
  const v = mark[`tier${i}`];
  console.log(`  tier ${String(i).padStart(2)} ${TIER_DEFS[i].name.padEnd(26)} ${v === undefined ? 'NOT REACHED' : 'day ' + v.toFixed(1)}`);
}
for (const k of ['migrate1', 'migrate2', 'migrate3', 'singularity1', 'singularity2']) {
  console.log(`  ${k.padEnd(34)} ${mark[k] === undefined ? 'NOT REACHED' : 'day ' + mark[k].toFixed(1)}`);
}
console.log(`\nanomalies claimed: ${anomalies} | boost uptime in-session: ${(100 * boostSec / sessionSec).toFixed(1)}%`);
console.log(`overheats: ${overheats} | hazard notices: ${hazards}`);
