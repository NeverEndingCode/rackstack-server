// Ablation: continuous play (100% online), layering one subsystem at a time,
// reporting time-to-unlock for every rack tier. Attribution by subtraction.

import { initialState, evaluate } from '../shared/state.js';
import { applyAction, scheduleAnomaly } from '../shared/reducer.js';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS, UPGRADE_DEFS } from '../shared/gameData.js';
import { costAt, computeMults, tierRate, fmt, computeEffects } from '../shared/gameRules.js';
import { goalCtx, GOAL_DEFS, REPEATABLE_DEFS } from '../shared/goals.js';
import { scheduleNextHazard, scheduleGridMaintenance } from '../shared/outages.js';
import { rolloverContracts } from '../shared/contracts.js';

const HOURS = Number(process.env.HOURS || 48);
const TICK = 5000;
const SLOW_EVERY = 12;   // run goal/upgrade/cold housekeeping once a minute

function run({ anomaly = false, goals = false, cold = false, risk = false, label }) {
  const config = structuredClone(DEFAULT_CONFIG);
  config.risk.enabled = risk;

  let state = initialState();
  let t = Date.now();
  const T0 = t;
  let lastEval = t;
  let seed = 999;
  const rng = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let x = seed;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  scheduleAnomaly(state.server, config, t, rng);

  const unlock = {};
  let anomalyClaims = 0;
  let boostSec = 0;
  let overheats = 0;
  let hazards = 0;
  let onlineSec = 0;

  const act = (a) => {
    const r = applyAction(state, a, config, t, rng);
    state = r.state;
    return r.result;
  };

  const bestBuy = () => {
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
  };

  const totalTicks = Math.floor(HOURS * 3600 / (TICK / 1000));
  for (let s = 0; s < totalTicks; s++) {
    t += TICK;
    const r = evaluate(state, config, lastEval, t, rng);
    state = r.state;
    lastEval = t;
    onlineSec += TICK / 1000;
    if (state.server.overheated) overheats++;
    if (state.server.outageNotices) hazards += state.server.outageNotices.length;
    if (state.server.boost && t < state.server.boost.until) boostSec += TICK / 1000;

    // server load-path scheduling
    if (state.server.nextAnomalyAt === 0 ||
        (t > state.server.anomalyExpiresAt && state.server.nextAnomalyAt <= t)) {
      scheduleAnomaly(state.server, config, t, rng);
    }
    if (!(state.server.nextHazardAt > 0)) scheduleNextHazard(state.server, config, t, rng);
    if (!state.server.gridMaintenance) scheduleGridMaintenance(state.server, config, t, rng);
    if ((goals || cold) && (s % SLOW_EVERY) === 0) rolloverContracts(state, config, t);

    act({ type: 'collectAll' });
    const eff = computeEffects(state.meta, config);
    for (let i = 0; i < TIER_DEFS.length; i++) {
      const ts = state.run.tiers[i];
      if (ts.owned >= 1 && !ts.manager) act({ type: 'hireManager', index: i });
    }
    if (anomaly && state.server.nextAnomalyAt <= t && t <= state.server.anomalyExpiresAt) {
      if (act({ type: 'claimAnomaly' }).ok) anomalyClaims++;
    }
    if (state.run.heat > config.heat.capacity * 0.6) act({ type: 'vent' });

    for (let k = 0; k < 300; k++) {
      const b = bestBuy();
      if (!b) break;
      if (!act({ type: 'buy', lane: b.lane, index: b.index, mode: 1 }).ok) break;
      if (b.lane === 'tiers' && state.run.tiers[b.index].owned === 1 && unlock[b.index] === undefined) {
        unlock[b.index] = (s * TICK / 1000) / 60;
      }
    }

    const slow = (s % SLOW_EVERY) === 0;
    if (goals && slow) {
      for (const g of GOAL_DEFS) if (!state.meta.goalsCompleted[g.id]) act({ type: 'claimGoal', id: g.id });
      for (const rp of REPEATABLE_DEFS) for (let k = 0; k < 30; k++) if (!act({ type: 'claimRepeatable', id: rp.id }).ok) break;
      for (let k = 0; k < 40; k++) {
        const aff = UPGRADE_DEFS
          .map((u) => ({ u, lvl: state.meta.upgrades[u.id] || 0 }))
          .filter(({ u, lvl }) => lvl < config.upgrades.maxLevels[u.id])
          .map(({ u, lvl }) => ({ id: u.id, cost: Math.ceil(u.baseCost * Math.pow(u.costMult, lvl)) }))
          .filter((x) => x.cost <= state.meta.wafers)
          .sort((a, b) => a.cost - b.cost);
        if (!aff.length) break;
        if (!act({ type: 'buyUpgrade', id: aff[0].id }).ok) break;
      }
      for (let i = 0; i < 3; i++) act({ type: 'claimContract', index: i });
      act({ type: 'claimStreak' });
    }
    if (cold && slow) {
      act({ type: 'claimAllBlocks' });
      if (state.meta.coldStorage.blocksClaimed.every(Boolean)) act({ type: 'resetTrack' });
    }
  }

  const out = goalCtx(state, config, t).totalOutputPerSec;
  return { label, unlock, out, anomalyClaims, boostSec, overheats, hazards, onlineSec,
           lifetime: state.meta.stats.lifetimeFlopsAllTime };
}

const scenarios = [
  { label: 'core only',            anomaly: false, goals: false, cold: false, risk: false },
  { label: '+ anomalies only',     anomaly: true,  goals: false, cold: false, risk: false },
  { label: '+ goals only',         anomaly: false, goals: true,  cold: false, risk: false },
  { label: 'ALL, risk OFF',        anomaly: true,  goals: true,  cold: true,  risk: false },
  { label: 'ALL, risk ON=shipped', anomaly: true,  goals: true,  cold: true,  risk: true  },
];

const results = scenarios.map(run);

console.log(`\n=== time to unlock each rack tier, CONTINUOUS play, ${HOURS}h budget (minutes) ===\n`);
const hdr = 'tier  ' + results.map((r) => r.label.padStart(20)).join('');
console.log(hdr);
console.log('-'.repeat(hdr.length));
for (let i = 0; i < TIER_DEFS.length; i++) {
  const row = results.map((r) => {
    const v = r.unlock[i];
    return (v === undefined ? '—' : (v < 60 ? v.toFixed(1) + 'm' : (v / 60).toFixed(1) + 'h')).padStart(20);
  }).join('');
  console.log(String(i).padStart(4) + '  ' + row);
}
console.log('\n' + 'final out/s'.padEnd(6) + results.map((r) => fmt(r.out).padStart(20)).join(''));
console.log('lifetime'.padEnd(6) + results.map((r) => fmt(r.lifetime).padStart(20)).join(''));
console.log('anomalies'.padEnd(6) + results.map((r) => String(r.anomalyClaims).padStart(20)).join(''));
console.log('boost%'.padEnd(6) + results.map((r) => (100 * r.boostSec / r.onlineSec).toFixed(1).padStart(20)).join(''));
console.log('overheat'.padEnd(6) + results.map((r) => String(r.overheats).padStart(20)).join(''));
console.log('hazards'.padEnd(6) + results.map((r) => String(r.hazards).padStart(20)).join(''));
