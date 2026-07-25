import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS, UPGRADE_DEFS, SINGULARITY_DEFS } from './gameData.js';
import { costForN, maxAffordable, computeEffects, migrateGain, xpForLevel } from './gameRules.js';
import { initialState } from './state.js';
import { goalCtx, GOAL_DEFS, REPEATABLE_DEFS } from './goals.js';

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

function migrate(s, action, config) {
  const eff = computeEffects(s.meta, config);
  const gain = migrateGain(s.run.lifetimeRun, eff.legacyGainMult);
  if (gain <= 0) return err('invalid_target');

  const echoBonus = eff.echoCoresBonus || 0;
  const startCredits = (10 + eff.deepCacheBonus) * eff.bootstrapMult;

  s.run = { ...initialState().run, credits: startCredits };
  s.meta.legacyCores += gain + echoBonus;
  s.meta.stats.migrates += 1;
  return { ok: true };
}

function singularity(s) {
  const shardsGained = Math.floor(Math.sqrt(s.meta.legacyCores || 0));
  if (shardsGained <= 0) return err('invalid_target');

  s.run = initialState().run;
  s.meta.legacyCores = 0;
  s.meta.singularityShards += shardsGained;
  s.meta.stats.singularities += 1;
  return { ok: true, shardsGained };
}

function buyFromDefs(defs, levelsBag, currencyKey) {
  return (s, action, config) => {
    const { id } = action;
    const def = defs.find((u) => u.id === id);
    if (!def) return err('invalid_target');

    const level = s.meta[levelsBag][id] || 0;
    const maxLevel = config.upgrades.maxLevels[id];
    if (maxLevel == null || level >= maxLevel) return err('max_level');

    const cost = Math.ceil(def.baseCost * Math.pow(def.costMult, level));
    if (s.meta[currencyKey] < cost) return err('insufficient_credits');

    s.meta[currencyKey] -= cost;
    s.meta[levelsBag][id] = level + 1;
    return { ok: true };
  };
}

const buyUpgrade = buyFromDefs(UPGRADE_DEFS, 'upgrades', 'wafers');
const buyShardUpgrade = buyFromDefs(SINGULARITY_DEFS, 'shardUpgrades', 'singularityShards');

function applyLevelUps(meta, xpGain) {
  let xp = meta.xp + xpGain;
  let level = meta.level;
  let leveled = false;
  while (xp >= xpForLevel(level)) {
    xp -= xpForLevel(level);
    level++;
    leveled = true;
  }
  meta.xp = xp;
  meta.level = level;
  return leveled;
}

function claimGoal(s, action, config, now) {
  const { id } = action;
  const def = GOAL_DEFS.find((g) => g.id === id);
  if (!def) return err('invalid_target');
  if (s.meta.goalsCompleted[id]) return err('invalid_target');

  const ctx = goalCtx(s, config, now);
  const [cur, target] = def.progress(ctx);
  if (cur < target) return err('not_met');

  const leveled = applyLevelUps(s.meta, def.xp);
  s.meta.wafers += def.wafers;
  s.meta.goalsCompleted[id] = true;
  s.meta.stats.totalWafersEarned = (s.meta.stats.totalWafersEarned || 0) + def.wafers;
  return { ok: true, leveled, level: s.meta.level };
}

function claimRepeatable(s, action, config, now) {
  const { id } = action;
  const def = REPEATABLE_DEFS.find((r) => r.id === id);
  if (!def) return err('invalid_target');

  const level = s.meta.repeatable[id] || 0;
  const target = def.target(level);
  const ctx = goalCtx(s, config, now);
  const cur = def.metric(ctx);
  if (cur < target) return err('not_met');

  const xpGain = def.xp(level);
  const waferGain = def.wafers(level);
  const leveled = applyLevelUps(s.meta, xpGain);
  s.meta.wafers += waferGain;
  s.meta.repeatable[id] = level + 1;
  s.meta.stats.totalWafersEarned = (s.meta.stats.totalWafersEarned || 0) + waferGain;
  return { ok: true, leveled, level: s.meta.level };
}

export function scheduleAnomaly(server, config, now, rng = Math.random) {
  const { minDelayMs, maxDelayMs, windowMs } = config.anomaly;
  server.nextAnomalyAt = now + minDelayMs + rng() * (maxDelayMs - minDelayMs);
  server.anomalyExpiresAt = server.nextAnomalyAt + windowMs;
}

function claimAnomaly(s, action, config, now, rng) {
  if (!(s.server.nextAnomalyAt <= now && now <= s.server.anomalyExpiresAt)) {
    return err('cooldown_active');
  }

  const eff = computeEffects(s.meta, config);
  const roll = rng();
  let reward;

  if (roll < 0.5) {
    const ctx = goalCtx(s, config, now);
    const seconds = 30 + rng() * 60;
    const amount = Math.max(ctx.totalOutputPerSec * seconds, 20) * eff.eventRewardMult;
    s.run.credits += amount;
    s.run.lifetimeRun += amount;
    reward = { kind: 'credits', amount };
  } else {
    const mult = [2, 3, 4][Math.floor(rng() * 3)];
    const duration = (45 + rng() * 30) * eff.eventRewardMult;
    s.server.boost = { mult, until: now + duration * 1000 };
    reward = { kind: 'boost', mult, until: s.server.boost.until };
  }

  scheduleAnomaly(s.server, config, now, rng);
  return { ok: true, reward };
}

function hardReset(s, action, config, now, rng) {
  const fresh = initialState();
  s.run = fresh.run;
  s.meta = fresh.meta;
  s.server = fresh.server;
  scheduleAnomaly(s.server, config, now, rng);
  return { ok: true };
}

const HANDLERS = {
  buy, collect, collectAll, hireManager, vent,
  migrate, singularity, buyUpgrade, buyShardUpgrade,
  claimGoal, claimRepeatable, claimAnomaly, hardReset,
};

export function applyAction(state, action, config, now, rng = Math.random) {
  const handler = action && HANDLERS[action.type];
  if (!handler) {
    return { state: structuredClone(state), result: err('unknown_action') };
  }
  const s = structuredClone(state);
  const result = handler(s, action, config, now, rng);
  return { state: s, result };
}
