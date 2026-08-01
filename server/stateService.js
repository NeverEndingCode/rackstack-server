import { migrateSave, evaluate } from '../shared/state.js';
import { applyAction, scheduleAnomaly } from '../shared/reducer.js';
import {
  getSave, putSave, updateParticipationProgress,
} from './db.js';
import { getEffectiveConfig } from './configService.js';
import { joinEventIfEligible, resolvePlayerEvents } from './eventService.js';
import { rolloverContracts } from '../shared/contracts.js';
import { checkAchievements } from '../shared/achievements.js';

function safeParse(text, userId) {
  try {
    return JSON.parse(text);
  } catch (e) {
    // Falling through to null here means the caller treats this as "no save
    // existed" - a fresh initialState() - and the next persist overwrites
    // this row with that fresh state, discarding whatever was recoverable
    // in it. That's silent data loss with no way for an operator to notice
    // unless it's logged here.
    console.error(`[stateService] corrupt save JSON for user ${userId}; falling back to a fresh state`, e);
    return null;
  }
}

/**
 * Loads the raw save row (if any), migrates it to canonical shape, and
 * evaluates it forward to `now`. A brand-new user (no save row) is treated
 * as "last evaluated now" so they don't get charged an offline gap back to
 * the epoch.
 *
 * Does NOT persist - exported (in addition to loadAndEvaluate below) for
 * callers like the minigame/finish route that need to mutate the evaluated
 * state further (crediting wafers, setting a cooldown) before a single
 * putSave, the same one-write pattern applyActions uses.
 */
export function loadEvaluateAndSchedule(userId, now) {
  // getEffectiveConfig() (server/configService.js) is getConfig()'s admin
  // baseline with the currently active live event's modifiers merged on
  // top (Task 4) - never the other way around. This is the ONLY read of
  // config in the evaluate/applyAction path, so both loadAndEvaluate and
  // applyActions below get event-aware balancing "for free".
  //
  // `effectiveConfig.data` is a SHARED, cached object - either the admin
  // baseline itself (no event active) or configService's own
  // (version, eventId)-keyed effectiveCache.data (event active) - reused
  // across every user's request until that cache key changes. Below, this
  // function attaches a per-user `__claimableEvent` field (hotfix for the
  // 48h grace-period bug: claimEventRung needs the ladder for whatever
  // event the PLAYER is mid-run on, even after that event's DB status has
  // left 'active', which config.__activeEvent alone can't provide - see
  // shared/reducer.js's claimEventRung doc comment). That attachment MUST
  // land on a per-request shallow copy, never on `effectiveConfig.data`
  // itself - mutating the shared cached object would leak one user's
  // claimable event onto every other user's request that hits the same
  // cache before it next invalidates.
  const effectiveConfig = getEffectiveConfig();
  const config = { ...effectiveConfig.data };
  const row = getSave(userId);
  const raw = row ? safeParse(row.data, userId) : null;
  const lastEvaluatedAt = row ? row.last_save : now;

  const migrated = migrateSave(raw);
  const { state, gained } = evaluate(migrated, config, lastEvaluatedAt, now);

  // evaluate() never schedules anomalies itself (Task 6 review finding): a
  // fresh/reset state (nextAnomalyAt === 0) needs its first anomaly
  // scheduled here, and an expired-unclaimed window needs rolling forward.
  if (
    state.server.nextAnomalyAt === 0 ||
    (now > state.server.anomalyExpiresAt && state.server.nextAnomalyAt <= now)
  ) {
    scheduleAnomaly(state.server, config, now, Math.random);
  }

  // Join-on-login (spec §5.3): if a live event is active and this user
  // hasn't joined it yet, snapshot their baselines and start their personal
  // window; if their in-flight progress belongs to a now-superseded event,
  // clear it. Mutates state.meta.eventProgress in place, same convention as
  // scheduleAnomaly above.
  const activeEvent = joinEventIfEligible(userId, state, now);

  // Resolve the per-user claimable event(s), if any, AFTER join-on-login has
  // had a chance to settle state.meta.eventProgress/pendingEventClaims (new
  // join, supersede-into-pending, prune, or untouched lingering grace-period
  // progress - see joinEventIfEligible's doc comment). resolvePlayerEvents
  // looks rows up by id via getEvent() directly - NOT getActiveEvent() - so
  // this resolves regardless of whether that specific event is still
  // `status: 'active'`, `'ended'`, or anything else. If a record references
  // an id that no longer exists in the DB at all (e.g. a deleted event),
  // getEvent() returns undefined, the entry is simply dropped, and
  // claimEventRung's own `!activeEvent` guard fails closed with
  // invalid_target - never throws.
  const { current, pending } = resolvePlayerEvents(state);
  if (current) {
    config.__claimableEvent = {
      id: current.event.id, ladder: current.event.ladder, endsAt: current.event.ends_at,
    };
  }
  if (pending.length > 0) {
    config.__pendingClaimables = pending.map(({ event }) => ({
      id: event.id, ladder: event.ladder, endsAt: event.ends_at,
    }));
  }

  // v1.5: roll the contracts board to today's UTC day. Runs AFTER evaluate()
  // (so goalCtx's totalOutputPerSec reflects the gap just closed, and the
  // rate-scaled FLOPS target is computed against the player's real current
  // output) and AFTER joinEventIfEligible (so an active event's config
  // overlay is already in force when targets are computed). Idempotent - a
  // no-op on every load within the same UTC day.
  rolloverContracts(state, config, now);

  // v1.5: the offline half of the achievement sweep. shared/reducer.js's
  // applyAction sweeps after every successful ACTION, which covers everything
  // a player does - but the lifetime-FLOPS tiers are crossed by evaluate()'s
  // accrual during a gap, which no action touches. Without this, a player who
  // crossed 1T FLOPS while asleep wouldn't unlock until their next successful
  // action. Both call sites write to the same meta.achievements bag and
  // checkAchievements never re-stamps a held id, so a double sweep is free.
  const unlockedAchievements = checkAchievements(state, config, now);

  return { state, gained, config, activeEvent, unlockedAchievements };
}

/** Loads, evaluates, persists, and returns { state, gained, activeEvent } for GET /api/state. */
export function loadAndEvaluate(userId, now = Date.now()) {
  const { state, gained, activeEvent, unlockedAchievements } = loadEvaluateAndSchedule(userId, now);
  putSave(userId, state, now);
  return { state, gained, activeEvent, unlockedAchievements };
}

/**
 * Loads + evaluates once, then applies each action in `actions` in order
 * against that single in-memory state, persisting only once at the end.
 * Never throws: applyAction() itself never throws, and each result carries
 * back the client-supplied `_cid` (the action queue's own correlation id -
 * see client/game/api.js) so the caller can reconcile. This is deliberately
 * separate from any semantic `id` field an action itself carries (e.g.
 * buyUpgrade/buyShardUpgrade/claimGoal/claimRepeatable/buyTapeUpgrade all
 * pass `{ type, id: <string identifier> }`) - echoing back `action.id`
 * here instead used to silently clobber those actions' own id client-side.
 */
export function applyActions(userId, actions, now = Date.now()) {
  const {
    state: loaded, config, unlockedAchievements: loadUnlocked,
  } = loadEvaluateAndSchedule(userId, now);

  let state = loaded;
  const results = [];
  for (const action of actions) {
    const { state: nextState, result } = applyAction(state, action, config, now, Math.random);
    state = nextState;
    results.push({ ...result, _cid: action && action._cid });
  }

  putSave(userId, state, now);

  // Hotfix: event_participation.rungs_claimed was previously only ever
  // written once, at join time (joinEventIfEligible -> upsertParticipation,
  // hardcoded rungsClaimed: 0) - nothing synced it again after a claim, so
  // listLeaderboard/listParticipation's `ORDER BY rungs_claimed DESC` sort
  // key was permanently 0 for every player. Re-derive from the final,
  // authoritative state.meta.eventProgress.rungsClaimed.length rather than
  // trusting the results array's ok/rungIndex flags directly - that's
  // idempotent and self-healing (safe to call even if triggered
  // redundantly, and correct even if a future action could somehow touch
  // rungsClaimed by a path other than claimEventRung). The `results.some`
  // check below is just the cheap gate for "was a claim even attempted this
  // batch" so a normal action batch with no event activity doesn't pay for
  // an extra DB write.
  //
  // Keyed off each successful claim's echoed-back `eventId` rather than
  // meta.eventProgress.eventId: a claim may target a SUPERSEDED window from
  // meta.pendingEventClaims (spec §5.3's 48h grace outliving the event), in
  // which case meta.eventProgress is either null or a different event
  // entirely, and syncing that one's count would be flatly wrong.
  const claimedEventIds = new Set(
    results.filter((r) => r.ok && typeof r.rungIndex === 'number' && typeof r.eventId === 'string')
      .map((r) => r.eventId),
  );
  for (const eventId of claimedEventIds) {
    const record = state.meta.eventProgress && state.meta.eventProgress.eventId === eventId
      ? state.meta.eventProgress
      : (state.meta.pendingEventClaims || []).find((p) => p && p.eventId === eventId);
    if (record && Array.isArray(record.rungsClaimed)) {
      updateParticipationProgress(userId, eventId, record.rungsClaimed.length, now);
    }
  }

  // v1.5: everything unlocked during THIS request, from either sweep site -
  // the load path (an offline threshold crossed since the last visit) and each
  // successful action. Merged and de-duplicated so the client can toast the
  // set once; a batch that both crosses an offline threshold and unlocks
  // something by acting must not drop either half. `unlockedAchievements` is
  // left on the individual results too, for callers that want attribution.
  const unlockedAchievements = [...new Set([
    ...(loadUnlocked || []),
    ...results.flatMap((r) => r.unlockedAchievements || []),
  ])];

  return { state, results, unlockedAchievements };
}
