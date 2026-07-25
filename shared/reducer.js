import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS } from './gameData.js';
import { costForN, maxAffordable, computeEffects } from './gameRules.js';

const LANE_DEFS = { tiers: TIER_DEFS, grid: GRID_DEFS, overclock: OVERCLOCK_DEFS };

function err(error) {
  return { ok: false, error };
}

function resolveBuyCount(mode, def, owned, credits) {
  if (mode === 'max') return maxAffordable(def, owned, credits);
  if (typeof mode === 'number' && Number.isInteger(mode) && mode > 0) return mode;
  return -1; // signals an invalid mode
}

function buy(s, action, config, now) {
  const { lane, index, mode } = action;
  const defs = LANE_DEFS[lane];
  if (!defs) return err('invalid_target');
  const def = defs[index];
  const laneState = s.run[lane] && s.run[lane][index];
  if (!def || !laneState) return err('invalid_target');

  if (lane === 'overclock' && s.run.heatCooldownUntil && now < s.run.heatCooldownUntil) {
    return err('cooldown_active');
  }

  const n = resolveBuyCount(mode, def, laneState.owned, s.run.credits);
  if (n < 0) return err('invalid_target');
  if (n === 0) return err('insufficient_credits');

  const cost = costForN(def, laneState.owned, n);
  if (cost > s.run.credits) return err('insufficient_credits');

  s.run.credits -= cost;
  laneState.owned += n;
  return { ok: true };
}

function collect(s, action) {
  const { index } = action;
  const ts = s.run.tiers[index];
  if (!ts) return err('invalid_target');
  if (ts.ready <= 0) return err('invalid_target');

  s.run.credits += ts.ready;
  ts.ready = 0;
  return { ok: true };
}

function collectAll(s) {
  let add = 0;
  for (const ts of s.run.tiers) {
    if (ts.ready > 0) {
      add += ts.ready;
      ts.ready = 0;
    }
  }
  s.run.credits += add;
  return { ok: true };
}

function hireManager(s, action, config) {
  const { index } = action;
  const def = TIER_DEFS[index];
  const ts = s.run.tiers[index];
  if (!def || !ts) return err('invalid_target');
  if (ts.manager) return err('already_automated');

  const eff = computeEffects(s.meta, config);
  const cost = def.managerCost * eff.automationDiscount;
  if (ts.owned < 1 || cost > s.run.credits) return err('insufficient_credits');

  s.run.credits += ts.ready - cost;
  ts.manager = true;
  ts.ready = 0;
  return { ok: true };
}

function vent(s, action, config, now) {
  if (now < s.server.lastVentAt + config.heat.ventCooldownMs) return err('cooldown_active');
  if (s.run.heatCooldownUntil && now < s.run.heatCooldownUntil) return err('cooldown_active');

  s.run.heat = Math.max(0, s.run.heat - config.heat.ventAmount);
  s.server.lastVentAt = now;
  return { ok: true };
}

const HANDLERS = { buy, collect, collectAll, hireManager, vent };

export function applyAction(state, action, config, now, rng = Math.random) {
  const handler = action && HANDLERS[action.type];
  if (!handler) {
    return { state: structuredClone(state), result: err('unknown_action') };
  }
  const s = structuredClone(state);
  const result = handler(s, action, config, now, rng);
  return { state: s, result };
}
