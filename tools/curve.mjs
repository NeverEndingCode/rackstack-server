// Pure core-loop curve: a fresh save, 1s resolution, NOTHING but buying.
// No anomalies, no goals/wafers/upgrades, no cold storage, no risk.
// This isolates how fast the rack ladder falls on its own economics.

import { initialState, evaluate } from '../shared/state.js';
import { applyAction } from '../shared/reducer.js';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS, GROWTH, MILESTONES } from '../shared/gameData.js';
import { costAt, computeMults, tierRate, fmt, migrateGain } from '../shared/gameRules.js';
import { goalCtx } from '../shared/goals.js';

const config = structuredClone(DEFAULT_CONFIG);
config.risk.enabled = false;          // isolate: no outages
const HOURS = Number(process.argv[2] || 24);

let state = initialState();
let t = Date.now();
const T0 = t;
let lastEval = t;
const rng = () => 0.5;

const firstOwned = {};
function tick() {
  t += 1000;
  const r = evaluate(state, config, lastEval, t, rng);
  state = r.state;
  lastEval = t;
}
function act(a) {
  const r = applyAction(state, a, config, t, rng);
  state = r.state;
  return r.result;
}

function bestBuy() {
  const { racksMult, gridMult, overclockMult, thresholds } = computeMults(state.meta, config, 1);
  let best = null;
  const consider = (lane, i, def, owned, mult) => {
    const cost = costAt(def, owned);
    if (cost > state.run.credits) return;
    const gain = tierRate(owned + 1, def.baseProd, mult, thresholds)
               - tierRate(owned, def.baseProd, mult, thresholds);
    if (gain <= 0) return;
    const payback = cost / gain;
    if (!best || payback < best.payback) best = { lane, index: i, payback };
  };
  state.run.tiers.forEach((ts, i) => {
    if (i > 0 && state.run.tiers[i - 1].owned < 1) return;
    consider('tiers', i, TIER_DEFS[i], ts.owned, racksMult);
  });
  state.run.grid.forEach((g, i) => consider('grid', i, GRID_DEFS[i], g.owned, gridMult));
  state.run.overclock.forEach((o, i) => consider('overclock', i, OVERCLOCK_DEFS[i], o.owned, overclockMult));
  return best;
}

console.log('\n=== core loop only: fresh save, no anomaly/goals/cold-storage/risk ===');
const total = HOURS * 3600;
for (let s = 0; s < total; s++) {
  tick();
  act({ type: 'collectAll' });
  // managers as soon as affordable (pure idle income)
  for (let i = 0; i < TIER_DEFS.length; i++) {
    const ts = state.run.tiers[i];
    if (ts.owned >= 1 && !ts.manager) act({ type: 'hireManager', index: i });
  }
  for (let k = 0; k < 200; k++) {
    const b = bestBuy();
    if (!b) break;
    if (!act({ type: 'buy', lane: b.lane, index: b.index, mode: 1 }).ok) break;
    if (b.lane === 'tiers' && state.run.tiers[b.index].owned === 1 && firstOwned[b.index] === undefined) {
      firstOwned[b.index] = s;
      console.log(`  t=${(s / 60).toFixed(1).padStart(7)}min  unlock tier ${String(b.index).padStart(2)}  ${TIER_DEFS[b.index].name}`);
    }
  }
  if (s % 3600 === 0 && s > 0) {
    const out = goalCtx(state, config, t).totalOutputPerSec;
    console.log(`  --- ${s / 3600}h: output ${fmt(out)}/s  lifetimeRun ${fmt(state.run.lifetimeRun)}  ` +
      `migrateGain ${migrateGain(state.run.lifetimeRun, 1)} cores  owned=[${state.run.tiers.map((x) => x.owned).join(',')}]`);
  }
}

const out = goalCtx(state, config, t).totalOutputPerSec;
console.log(`\nafter ${HOURS}h: output ${fmt(out)}/s, lifetimeRun ${fmt(state.run.lifetimeRun)}`);
console.log(`tiers owned: [${state.run.tiers.map((x) => x.owned).join(', ')}]`);
console.log(`grid owned:  [${state.run.grid.map((x) => x.owned).join(', ')}]`);
console.log(`oc owned:    [${state.run.overclock.map((x) => x.owned).join(', ')}]`);
console.log(`first Migrate would grant ${migrateGain(state.run.lifetimeRun, 1)} Legacy Cores (+${(5 * migrateGain(state.run.lifetimeRun, 1)).toFixed(0)}% output)`);

// --- static tables --------------------------------------------------------
console.log('\n=== tier economics (base, no multipliers) ===');
console.log('tier | baseCost | baseProd | cost/prod | costRatio | prodRatio | payback@1');
TIER_DEFS.forEach((d, i) => {
  const p = TIER_DEFS[i - 1];
  console.log(
    `${String(i).padStart(4)} | ${fmt(d.baseCost).padStart(8)} | ${fmt(d.baseProd).padStart(8)} | ` +
    `${(d.baseCost / d.baseProd).toFixed(0).padStart(9)} | ` +
    `${(p ? (d.baseCost / p.baseCost).toFixed(1) : '-').padStart(9)} | ` +
    `${(p ? (d.baseProd / p.baseProd).toFixed(1) : '-').padStart(9)} | ` +
    `${(d.baseCost / d.baseProd).toFixed(0).padStart(9)}s`);
});

console.log('\n=== marginal payback vs owned count (tier 0, mult=1) ===');
console.log('owned | unit cost | marginal prod | payback');
for (const n of [1, 5, 10, 24, 25, 30, 49, 50, 60, 99, 100, 150, 199, 200, 300, 499, 500, 700, 999, 1000]) {
  const d = TIER_DEFS[0];
  const cost = costAt(d, n - 1);
  const gain = tierRate(n, d.baseProd, 1, MILESTONES) - tierRate(n - 1, d.baseProd, 1, MILESTONES);
  console.log(`${String(n).padStart(5)} | ${fmt(cost).padStart(9)} | ${fmt(gain).padStart(13)} | ${fmt(cost / gain).padStart(8)}s`);
}

console.log('\n=== how much does a doubling of owned cost vs. what it pays? (GROWTH=' + GROWTH + ') ===');
console.log('milestones at ' + MILESTONES.join(', ') + '  → x2 each, x' + Math.pow(2, MILESTONES.length) + ' at the top');
for (const [a, b] of [[25, 50], [50, 100], [100, 200], [200, 500], [500, 1000]]) {
  const costRatio = Math.pow(GROWTH, b - a);
  const outA = a * (2 ** MILESTONES.filter((m) => a >= m).length);
  const outB = b * (2 ** MILESTONES.filter((m) => b >= m).length);
  console.log(`  ${a}→${b}: next-unit cost x${costRatio.toFixed(1)}, total lane output x${(outB / outA).toFixed(1)}` +
    `  → efficiency ${(outB / outA / costRatio).toFixed(3)}x`);
}
