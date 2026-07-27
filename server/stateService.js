import { migrateSave, evaluate } from '../shared/state.js';
import { applyAction, scheduleAnomaly } from '../shared/reducer.js';
import { getSave, putSave } from './db.js';
import { getConfig } from './configService.js';

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
  const config = getConfig().data;
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

  return { state, gained, config };
}

/** Loads, evaluates, persists, and returns { state, gained } for GET /api/state. */
export function loadAndEvaluate(userId, now = Date.now()) {
  const { state, gained } = loadEvaluateAndSchedule(userId, now);
  putSave(userId, state, now);
  return { state, gained };
}

/**
 * Loads + evaluates once, then applies each action in `actions` in order
 * against that single in-memory state, persisting only once at the end.
 * Never throws: applyAction() itself never throws, and each result carries
 * back the client-supplied `id` so the caller can reconcile.
 */
export function applyActions(userId, actions, now = Date.now()) {
  const { state: loaded, config } = loadEvaluateAndSchedule(userId, now);

  let state = loaded;
  const results = [];
  for (const action of actions) {
    const { state: nextState, result } = applyAction(state, action, config, now, Math.random);
    state = nextState;
    results.push({ ...result, id: action && action.id });
  }

  putSave(userId, state, now);
  return { state, results };
}
