import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS, UPGRADE_DEFS, SINGULARITY_DEFS } from './gameData.js';
import { costForN, maxAffordable, computeEffects, migrateGain, xpForLevel } from './gameRules.js';
import { initialState } from './state.js';
import { goalCtx, GOAL_DEFS, REPEATABLE_DEFS } from './goals.js';
import { TOTAL_BLOCKS, JOB_TYPES, TAPE_UPGRADE_DEFS } from './coldStorageData.js';
import { computeColdStorageEffects, blockReward, jobDurationSec, jobReward } from './coldStorage.js';

const LANE_DEFS = { tiers: TIER_DEFS, grid: GRID_DEFS, overclock: OVERCLOCK_DEFS };

function err(error) {
  return { ok: false, error };
}

// Every handler below that indexes into a defs array (TIER_DEFS/GRID_DEFS/
// OVERCLOCK_DEFS) or the matching run.* array using an action-supplied
// `index` must run this check BEFORE any property access on those arrays.
// Without it, a non-numeric `index` (e.g. 'push', 'length', '__proto__')
// is used directly as a property key - `arr['push']` resolves to
// Array.prototype.push (a function, so truthy "def"/"laneState" checks
// pass), and assigning through it corrupts state (observed: credits
// becoming NaN, which makes every later `cost > credits` affordability
// check evaluate false and lets subsequent actions in the same batch buy
// for free). A payload like `index: 'length'` throws outright, which
// applyAction's contract documents as never happening.
function validIndex(index, length) {
  return Number.isInteger(index) && index >= 0 && index < length;
}

function resolveBuyCount(mode, def, owned, credits) {
  if (mode === 'max') return maxAffordable(def, owned, credits);
  if (typeof mode === 'number' && Number.isInteger(mode) && mode > 0) return mode;
  return -1; // signals an invalid mode
}

function buy(s, action, config, now) {
  const { lane, index, mode } = action;
  const defs = LANE_DEFS[lane];
  // Array.isArray (not just truthiness) - `lane` is a user-supplied string
  // used as a property key against a plain object, so a value like
  // '__proto__' or 'toString' would otherwise resolve to an inherited
  // Object.prototype value instead of failing the lookup.
  if (!Array.isArray(defs)) return err('invalid_target');
  if (!validIndex(index, defs.length)) return err('invalid_target');
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
  if (!validIndex(index, s.run.tiers.length)) return err('invalid_target');
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
  if (!validIndex(index, TIER_DEFS.length)) return err('invalid_target');
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

// Cold Storage: batch-queue blocks, track resets, offline jobs, and the
// tape-upgrade shop. Tapes/upgrades live nested at s.meta.coldStorage.* -
// unlike buyFromDefs' flat s.meta[currencyKey] access - so buyTapeUpgrade is
// its own standalone handler rather than a buyFromDefs() instantiation.

function claimBlock(s, action, config, now) {
  const { index } = action;
  if (!validIndex(index, TOTAL_BLOCKS)) return err('invalid_target');
  const cs = s.meta.coldStorage;
  if (cs.blocksClaimed[index]) return err('invalid_target');

  const csEff = computeColdStorageEffects(s.meta, config);
  const arrivedCount = Math.floor((now - cs.trackStartedAt) / csEff.blockDurationMs);
  if (index >= arrivedCount) return err('not_met');

  const ctx = goalCtx(s, config, now);
  const { tapes, flops } = blockReward(index, cs.trackCycle, config, csEff, ctx.totalOutputPerSec);

  cs.blocksClaimed[index] = true;
  cs.tapes += tapes;
  if (flops > 0) {
    s.run.credits += flops;
    s.run.lifetimeRun += flops;
  }
  s.meta.stats.blocksClaimedLifetime = (s.meta.stats.blocksClaimedLifetime || 0) + 1;
  return { ok: true, tapes, flops };
}

function claimAllBlocks(s, action, config, now) {
  const cs = s.meta.coldStorage;
  const csEff = computeColdStorageEffects(s.meta, config);
  const arrivedCount = Math.floor((now - cs.trackStartedAt) / csEff.blockDurationMs);
  const ctx = goalCtx(s, config, now);

  let tapes = 0;
  let flops = 0;
  let claimedCount = 0;
  for (let i = 0; i < TOTAL_BLOCKS && i < arrivedCount; i++) {
    if (cs.blocksClaimed[i]) continue;
    const reward = blockReward(i, cs.trackCycle, config, csEff, ctx.totalOutputPerSec);
    cs.blocksClaimed[i] = true;
    tapes += reward.tapes;
    flops += reward.flops;
    claimedCount++;
  }
  if (claimedCount === 0) return err('invalid_target');

  cs.tapes += tapes;
  if (flops > 0) {
    s.run.credits += flops;
    s.run.lifetimeRun += flops;
  }
  s.meta.stats.blocksClaimedLifetime = (s.meta.stats.blocksClaimedLifetime || 0) + claimedCount;
  return { ok: true, tapes, flops, claimedCount };
}

function resetTrack(s, action, config, now) {
  const cs = s.meta.coldStorage;
  if (!cs.blocksClaimed.every(Boolean)) return err('not_met');

  const csEff = computeColdStorageEffects(s.meta, config);
  cs.trackCycle += 1;
  cs.trackStartedAt = now;
  cs.blocksClaimed = Array(TOTAL_BLOCKS).fill(false);

  // TOTAL_BLOCKS - 1, not TOTAL_BLOCKS: a headstart that could pre-claim
  // every block would immediately re-satisfy this function's own
  // `blocksClaimed.every(Boolean)` gate above, so a reset could pay itself
  // out forever with zero wall-clock time between resets. Reserving the
  // final block guarantees at least one block must actually arrive
  // (blockDurationMs of real time) before the track can be reset again.
  const headStart = Math.min(csEff.headStartBlocks, TOTAL_BLOCKS - 1);
  if (headStart > 0) {
    const ctx = goalCtx(s, config, now);
    let tapes = 0;
    let flops = 0;
    for (let i = 0; i < headStart; i++) {
      cs.blocksClaimed[i] = true;
      const reward = blockReward(i, cs.trackCycle, config, csEff, ctx.totalOutputPerSec);
      tapes += reward.tapes;
      flops += reward.flops;
    }
    cs.tapes += tapes;
    if (flops > 0) {
      s.run.credits += flops;
      s.run.lifetimeRun += flops;
    }
    s.meta.stats.blocksClaimedLifetime = (s.meta.stats.blocksClaimedLifetime || 0) + headStart;
  }
  return { ok: true };
}

function startJob(s, action, config, now) {
  const { jobType } = action;
  if (!JOB_TYPES.includes(jobType)) return err('invalid_target');
  if (s.meta.coldStorage.job) return err('invalid_target');

  s.meta.coldStorage.job = { type: jobType, accruedOfflineSec: 0, startedAt: now };
  return { ok: true };
}

function cancelJob(s) {
  if (!s.meta.coldStorage.job) return err('invalid_target');
  s.meta.coldStorage.job = null;
  return { ok: true };
}

function claimJob(s, action, config) {
  const job = s.meta.coldStorage.job;
  if (!job) return err('invalid_target');

  const durationSec = jobDurationSec(job.type, config);
  // null means job.type isn't a recognized JOB_TYPES entry - fail closed
  // rather than falling through to jobReward()'s if/if/else chain, which
  // defaults to the 'deep' branch (the largest payout) for anything it
  // doesn't recognize.
  if (durationSec == null) return err('invalid_target');
  if (job.accruedOfflineSec < durationSec) return err('not_met');

  const csEff = computeColdStorageEffects(s.meta, config);
  const tapes = Math.round(jobReward(job.type, config) * csEff.tapeRewardMult);

  s.meta.coldStorage.tapes += tapes;
  s.meta.coldStorage.job = null;
  s.meta.stats.jobsCompletedLifetime = (s.meta.stats.jobsCompletedLifetime || 0) + 1;
  if (job.type === 'deep') {
    s.meta.stats.deepJobsCompletedLifetime = (s.meta.stats.deepJobsCompletedLifetime || 0) + 1;
  }
  return { ok: true, tapes };
}

function buyTapeUpgrade(s, action, config) {
  const { id } = action;
  const def = TAPE_UPGRADE_DEFS.find((u) => u.id === id);
  if (!def) return err('invalid_target');

  const cs = s.meta.coldStorage;
  const level = cs.upgrades[id] || 0;
  const maxLevel = config.upgrades.maxLevels[id];
  if (maxLevel == null || level >= maxLevel) return err('max_level');

  const cost = Math.ceil(def.baseCost * Math.pow(def.costMult, level));
  if (cs.tapes < cost) return err('insufficient_credits');

  cs.tapes -= cost;
  cs.upgrades[id] = level + 1;
  return { ok: true };
}

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

// Object.create(null): a plain `{}` object literal inherits from
// Object.prototype, so a lookup like HANDLERS['__proto__'] doesn't resolve
// to `undefined` (the intended "unregistered action" signal) - it resolves
// Object.prototype's own __proto__ accessor, and HANDLERS['toString'] /
// HANDLERS['constructor'] / HANDLERS['hasOwnProperty'] similarly resolve to
// real inherited functions/objects. `applyAction` calls the lookup result as
// a function without checking it's one of the handlers registered below, so
// any of those action.type values crashed with "handler is not a function"
// (or, for 'constructor', called Object() and leaked part of internal
// state). A null-prototype object has no inherited properties at all, so
// every lookup that isn't one of the names below - including these - comes
// back `undefined` and falls through to the normal unknown_action path.
const HANDLERS = Object.assign(Object.create(null), {
  buy, collect, collectAll, hireManager, vent,
  migrate, singularity, buyUpgrade, buyShardUpgrade,
  claimGoal, claimRepeatable, claimAnomaly, hardReset,
  claimBlock, claimAllBlocks, resetTrack, startJob, cancelJob, claimJob, buyTapeUpgrade,
});

export function applyAction(state, action, config, now, rng = Math.random) {
  const handler = action && HANDLERS[action.type];
  if (!handler) {
    return { state: structuredClone(state), result: err('unknown_action') };
  }
  const s = structuredClone(state);
  const result = handler(s, action, config, now, rng);
  return { state: s, result };
}
