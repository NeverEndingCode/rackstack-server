import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS, UPGRADE_DEFS, SINGULARITY_DEFS } from './gameData.js';
import { costForN, maxAffordable, computeEffects, migrateGain, xpForLevel, milestoneThresholds, nextMilestone } from './gameRules.js';
import { initialState, recordLegacyCorePeak } from './state.js';
import { goalCtx, GOAL_DEFS, REPEATABLE_DEFS } from './goals.js';
import { TOTAL_BLOCKS, JOB_TYPES, TAPE_UPGRADE_DEFS } from './coldStorageData.js';
import { computeColdStorageEffects, blockReward, jobDurationSec, jobReward } from './coldStorage.js';
import { rungProgress } from './events.js';
import { utcDateKey } from './daily.js';
import { contractsForState, contractProgress } from './contracts.js';
import { canClaimStreak, nextStreakCount, streakReward } from './streak.js';
import { checkAchievements } from './achievements.js';

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

function resolveBuyCount(mode, def, owned, credits, thresholds) {
  if (mode === 'max') return maxAffordable(def, owned, credits);
  if (mode === 'milestone') {
    const next = nextMilestone(owned, thresholds);
    return next === null ? 0 : next - owned;
  }
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

  // Only 'milestone' reads the thresholds, and deriving them costs a full
  // computeEffects pass - not something every Buy 1 tap should pay for. The
  // other modes are handed null, which resolveBuyCount never dereferences.
  const thresholds = mode === 'milestone' ? milestoneThresholds(s.meta, config) : null;
  const n = resolveBuyCount(mode, def, laneState.owned, s.run.credits, thresholds);
  if (n < 0) return err('invalid_target');
  // A milestone request returning 0 means the lane is past its final
  // threshold - a different situation from not affording the jump, and the
  // button renders differently for each.
  if (n === 0 && mode === 'milestone') return err('no_milestone');
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

  // v1.6: vent a percentage of EFFECTIVE capacity rather than a flat amount,
  // so venting isn't diluted by a raised heat.capacity (Summer Surge overlays
  // 4000) or by Heat-Sink Tapes. The capacity expression here must stay
  // identical to the overheat threshold in shared/state.js - venting measured
  // against a different ceiling than the one that triggers a meltdown would
  // be a silent balance bug.
  const csEff = computeColdStorageEffects(s.meta, config);
  const capacity = config.heat.capacity + csEff.heatCapacityBonus;
  s.run.heat = Math.max(0, s.run.heat - (capacity * config.heat.ventPercent) / 100);
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

  recordLegacyCorePeak(s.meta);
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
  s.meta.stats.tapesEarnedLifetime = (s.meta.stats.tapesEarnedLifetime || 0) + tapes;
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
  s.meta.stats.tapesEarnedLifetime = (s.meta.stats.tapesEarnedLifetime || 0) + tapes;
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
    s.meta.stats.tapesEarnedLifetime = (s.meta.stats.tapesEarnedLifetime || 0) + tapes;
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
  s.meta.stats.tapesEarnedLifetime = (s.meta.stats.tapesEarnedLifetime || 0) + tapes;
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

// The 48h post-event grace period during which players can still claim
// rungs they already qualified for after the event itself ends. Exported so
// the client (Task 7's RackStack.jsx/EventPanel.jsx) can gate the event
// tab's visibility and grace-period messaging on the exact same window the
// server enforces here, rather than duplicating the constant and risking
// drift.
export const EVENT_CLAIM_GRACE_MS = 48 * 3600 * 1000;

// The ladder for the event a player is actually mid-run on isn't part of
// `state` - it lives in the DB (events table) and reaches here via
// `config.__claimableEvent = { id, ladder, endsAt }`, attached by
// server/stateService.js's loadEvaluateAndSchedule() (NOT
// getEffectiveConfig()/config.__activeEvent - that field only reflects
// whichever event is GLOBALLY `status: 'active'` right now, and disappears
// the instant an event ends, which made this reducer's own grace-period
// branch below unreachable end-to-end: the moment status flipped to
// 'ended', __activeEvent vanished and the guard below rejected every claim
// with invalid_target before now > ep.endsAt + EVENT_CLAIM_GRACE_MS was ever
// checked - a real bug, found and fixed post-Task-7).
// __claimableEvent is resolved per-user from `state.meta.eventProgress.
// eventId` regardless of that event's current DB status, so a player's
// claim window/grace period can outlive the event's global 'active' status
// exactly as spec'd. It's attached to a per-request shallow copy of the
// config object - never to configService's shared (version, eventId)-keyed
// cache - so one user's claimable event can never leak into another user's
// request. If no event is active AND the player has no lingering
// eventProgress, config.__claimableEvent is simply absent.
//
// `config.__pendingClaimables` (same `{ id, ladder, endsAt }` shape, an
// array) carries the ladders for any personal windows that were force-ended
// early by a NEWER event going active - spec §5.2 force-ends the WINDOW, but
// §5.3's 48h claim grace still applies, so those rungs stay claimable from
// `state.meta.pendingEventClaims`. `action.eventId` selects which of the two
// slots a claim targets; omitting it keeps the pre-existing behaviour (the
// current claimable event), so a direct API caller that only sends
// `{ type, index }` is unaffected.
function claimEventRung(s, action, config, now) {
  const { index, eventId } = action;

  const claimables = [];
  if (config.__claimableEvent) claimables.push(config.__claimableEvent);
  if (Array.isArray(config.__pendingClaimables)) {
    for (const c of config.__pendingClaimables) { if (c) claimables.push(c); }
  }

  // User-supplied id: resolved by .find() over the resolved list, never as a
  // bare object key.
  const activeEvent = eventId === undefined || eventId === null
    ? claimables[0]
    : claimables.find((c) => c.id === eventId);
  if (!activeEvent) return err('invalid_target');

  const ep = progressRecordFor(s.meta, activeEvent.id);
  if (!ep) return err('invalid_target');

  const ladder = activeEvent.ladder;
  if (!Array.isArray(ladder)) return err('invalid_target');
  if (!validIndex(index, ladder.length)) return err('invalid_target');
  if (!Array.isArray(ep.rungsClaimed)) return err('invalid_target');
  if (ep.rungsClaimed.includes(index)) return err('invalid_target');

  if (now > ep.endsAt + EVENT_CLAIM_GRACE_MS) return err('cooldown_active');

  // A superseded window (meta.pendingEventClaims) carries `claimableRungs`:
  // the met-but-unclaimed set frozen at the instant it was force-ended. Its
  // ladder must NOT be re-evaluated against live `meta`, or it keeps climbing
  // in parallel with the new event's ladder and one grind pays out both -
  // spec §5.3 keeps open only the rungs already qualified. A live window has
  // no such field and is measured normally.
  if (Array.isArray(ep.claimableRungs)) {
    if (!ep.claimableRungs.includes(index)) return err('not_met');
  } else if (!rungProgress(ladder[index], s.meta, ep.baseline).met) {
    return err('not_met');
  }

  const rung = ladder[index];

  const reward = rung.reward || {};
  // Match existing reward-crediting precedent exactly: FLOPS go to BOTH
  // run.credits and run.lifetimeRun (see claimAnomaly's credits branch and
  // claimBlock's FLOPS bonus); tapes go to BOTH coldStorage.tapes and
  // stats.tapesEarnedLifetime; wafers go to meta.wafers and
  // stats.totalWafersEarned (see claimGoal).
  if (typeof reward.wafers === 'number') {
    s.meta.wafers += reward.wafers;
    s.meta.stats.totalWafersEarned = (s.meta.stats.totalWafersEarned || 0) + reward.wafers;
  }
  if (typeof reward.tapes === 'number') {
    s.meta.coldStorage.tapes += reward.tapes;
    s.meta.stats.tapesEarnedLifetime = (s.meta.stats.tapesEarnedLifetime || 0) + reward.tapes;
  }
  if (typeof reward.flops === 'number') {
    s.run.credits += reward.flops;
    s.run.lifetimeRun += reward.flops;
  }

  ep.rungsClaimed.push(index);
  // Feeds the 'event_champion' achievement through the ordinary
  // condition-driven path (shared/achievements.js) rather than special-casing
  // a badge grant here - spec §5.1's "top rung awards a badge".
  if (index === ladder.length - 1) {
    s.meta.stats.eventTopRungs = (s.meta.stats.eventTopRungs || 0) + 1;
  }
  // `eventId` echoes back which event's ladder this rung came from - the
  // claim may have targeted a superseded (pendingEventClaims) window, so
  // callers that sync per-event bookkeeping (stateService.applyActions ->
  // updateParticipationProgress) must not assume meta.eventProgress.
  return { ok: true, reward, rungIndex: index, eventId: activeEvent.id };
}

/**
 * The player's own progress record for `eventId`: their live/in-grace
 * `meta.eventProgress` if it targets that event, otherwise a superseded
 * window still inside its claim grace (`meta.pendingEventClaims`). Returns
 * the record itself (callers mutate `rungsClaimed` in place on the already-
 * cloned state), or null. Both slots are searched by `.find()` on a stored
 * `eventId` string - never by bare-key lookup.
 */
function progressRecordFor(meta, eventId) {
  const ep = meta.eventProgress;
  if (ep && ep.eventId === eventId) return ep;
  const pending = meta.pendingEventClaims;
  if (!Array.isArray(pending)) return null;
  return pending.find((p) => p && p.eventId === eventId) || null;
}

// v1.5 Social. Both handlers below are gated on a CALENDAR-DAY key rather
// than a rolling window, so "already done today" is invalid_target (the
// existing string for a repeat claim, as in claimGoal/claimBlock) and never
// cooldown_active - no new error strings.

function claimContract(s, action, config, now) {
  const { index } = action;
  if (!validIndex(index, 3)) return err('invalid_target');

  // The board is rolled over on the server's load path
  // (server/stateService.js) BEFORE any action is applied, so a dateKey that
  // isn't today's here means this claim raced past a rollover - reject it
  // rather than pay out against a stale target/baseline pair.
  const today = utcDateKey(now);
  if (today === null || s.meta.contracts.dateKey !== today) return err('invalid_target');

  const contract = contractsForState(s.meta)[index];
  if (!contract || !contract.def) return err('invalid_target');
  if (s.meta.contracts.claimed[index] === true) return err('invalid_target');

  const baseline = s.meta.contracts.baseline[contract.def.metric];
  if (!contractProgress(contract.def, s.meta, baseline, contract.target).met) return err('not_met');

  const scale = 1 + config.social.contractRewardLevelScalePct * (s.meta.level || 0);
  const wafers = Math.round(config.social.contractRewardWafers * scale);
  const tapes = Math.round(config.social.contractRewardTapes * scale);

  s.meta.wafers += wafers;
  s.meta.stats.totalWafersEarned = (s.meta.stats.totalWafersEarned || 0) + wafers;
  s.meta.coldStorage.tapes += tapes;
  s.meta.stats.tapesEarnedLifetime = (s.meta.stats.tapesEarnedLifetime || 0) + tapes;
  s.meta.contracts.claimed[index] = true;
  s.meta.stats.contractsCompletedLifetime = (s.meta.stats.contractsCompletedLifetime || 0) + 1;

  return { ok: true, reward: { wafers, tapes }, index };
}

function claimStreak(s, action, config, now) {
  const today = utcDateKey(now);
  if (today === null) return err('invalid_target');
  if (!canClaimStreak(s.meta.streak, today)) return err('invalid_target');

  const day = nextStreakCount(s.meta.streak, today, config);
  const ctx = goalCtx(s, config, now);
  const reward = streakReward(day, config, ctx);

  if (reward.flops > 0) {
    s.run.credits += reward.flops;
    s.run.lifetimeRun += reward.flops;
  }
  if (reward.wafers > 0) {
    s.meta.wafers += reward.wafers;
    s.meta.stats.totalWafersEarned = (s.meta.stats.totalWafersEarned || 0) + reward.wafers;
  }
  if (reward.tapes > 0) {
    s.meta.coldStorage.tapes += reward.tapes;
    s.meta.stats.tapesEarnedLifetime = (s.meta.stats.tapesEarnedLifetime || 0) + reward.tapes;
  }

  s.meta.streak = { count: day, lastClaimDate: today };
  s.meta.stats.bestStreak = Math.max(s.meta.stats.bestStreak || 0, day);
  return { ok: true, reward, day };
}

// Boolean-validated client display preference; the route layer (Task 6)
// mirrors this to the `users` column. The reducer only records it in `meta`.
function setLeaderboardOptOut(s, action) {
  const { optOut } = action;
  if (typeof optOut !== 'boolean') return err('invalid_target');
  s.meta.leaderboardOptOut = optOut;
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
  claimEventRung, setLeaderboardOptOut,
  claimContract, claimStreak,
});

export function applyAction(state, action, config, now, rng = Math.random) {
  const handler = action && HANDLERS[action.type];
  if (!handler) {
    return { state: structuredClone(state), result: err('unknown_action') };
  }
  const s = structuredClone(state);
  const result = handler(s, action, config, now, rng);
  // Achievements unlock automatically, never by claim (spec §6.3). Sweeping
  // here - after any SUCCESSFUL action - is what makes "unlocked in the
  // reducer" true for everything a player does. A rejected action changed
  // nothing, so there is nothing new to unlock and sweeping would only burn a
  // goalCtx build on every bad request. The offline half (thresholds crossed
  // by evaluate()'s accrual, which no action touches) is swept separately in
  // server/stateService.js.
  if (result && result.ok) {
    const unlocked = checkAchievements(s, config, now);
    if (unlocked.length > 0) result.unlockedAchievements = unlocked;
  }
  return { state: s, result };
}
