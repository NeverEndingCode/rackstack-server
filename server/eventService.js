// Event lifecycle service (v1.4 Live Events, spec §5.1-§5.3): activation/
// end, the boot+hourly scheduler, and join-on-login. This module owns the
// "at most one globally active event" invariant - server/db.js deliberately
// does NOT enforce it (no partial unique index), so every mutation path
// here is written to be safe even if the DB ever ends up with more than one
// `status = 'active'` row (e.g. from a bug elsewhere, or a hand-edited row):
// activateEvent ends every OTHER active row, not just "the" one a LIMIT-1
// query happens to return, and runScheduler's expiry sweep checks every
// active row individually rather than trusting getActiveEvent()'s single
// row.
import {
  getEvent, getActiveEvent, listEvents, setEventStatus,
  upsertParticipation, getUserById,
} from './db.js';
import { invalidateEffectiveConfig } from './configService.js';
import { EVENT_METRIC_IDS, eventMetricValue } from '../shared/events.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Activates `id`: ends every other currently-active event first (enforcing
 * the one-active invariant regardless of how many rows happen to be
 * 'active' right now), then flips `id` to 'active'.
 *
 * Requires the event to already carry a window (`ends_at` set - via a prior
 * /schedule call or recurrence materialization, the normal
 * create -> schedule -> activate flow). `starts_at` is preserved if already
 * set, defaulting to `now` only for the defensive case of an event with an
 * end but no start. This does NOT decide whether a manual "trigger now"
 * request is allowed to override an already-active event - that UX/
 * permission check (spec §5.2: "requires explicitly ending it first") is
 * the route layer's job (Task 6); this function is the low-level primitive
 * both the route and the scheduler call, and it always restores the
 * invariant no matter what state it's called from.
 *
 * Returns `{ ok: true }` or `{ ok: false, error }`.
 */
export function activateEvent(id, now = Date.now()) {
  const event = getEvent(id);
  if (!event) return { ok: false, error: 'not_found' };
  if (event.ends_at == null) return { ok: false, error: 'not_scheduled' };

  for (const other of listEvents()) {
    if (other.status === 'active' && other.id !== id) {
      setEventStatus(other.id, 'ended');
    }
  }

  const startsAt = event.starts_at ?? now;
  setEventStatus(id, 'active', { startsAt, endsAt: event.ends_at });
  invalidateEffectiveConfig();
  return { ok: true };
}

/**
 * Ends `id` outright (status -> 'ended'). Does NOT touch any user's
 * `event_participation`/`meta.eventProgress` window - per spec §5.3
 * personal windows tail up to 24h past the global end and remain claimable
 * through their own 48h grace period; they're only force-cleared when a
 * *different* event next goes active (joinEventIfEligible, below).
 */
export function endEvent(id, now = Date.now()) {
  const event = getEvent(id);
  if (!event) return { ok: false, error: 'not_found' };
  setEventStatus(id, 'ended');
  invalidateEffectiveConfig();
  return { ok: true };
}

/**
 * Computes the next {startsAt, endsAt} window (ms epoch, UTC) for an annual
 * `{month (1-indexed), day, durationDays}` recurrence, on/after `now`. If
 * this year's window has already fully elapsed (its END, not just its
 * start, is in the past - so a window that's currently in-progress still
 * counts as "this year's"), targets next year instead.
 */
function nextOccurrence({ month, day, durationDays }, now) {
  const durationMs = durationDays * DAY_MS;
  const year = new Date(now).getUTCFullYear();

  const windowFor = (y) => {
    const startsAt = Date.UTC(y, month - 1, day, 0, 0, 0, 0);
    return { startsAt, endsAt: startsAt + durationMs };
  };

  const thisYear = windowFor(year);
  return thisYear.endsAt > now ? thisYear : windowFor(year + 1);
}

/**
 * Materializes recurrence into a concrete scheduled window for every event
 * that's currently `status: 'draft'`, has a `recurrence`, and has NO window
 * yet (`starts_at`/`ends_at` both null). Deliberately narrow: an event with
 * a coordinator-set window (even if it also carries a recurrence) is never
 * touched - hand-set scheduling always wins over the annual default.
 */
function materializeRecurrences(now) {
  for (const event of listEvents()) {
    if (event.status !== 'draft' || !event.recurrence) continue;
    if (event.starts_at != null || event.ends_at != null) continue;
    const { startsAt, endsAt } = nextOccurrence(event.recurrence, now);
    setEventStatus(event.id, 'scheduled', { startsAt, endsAt });
  }
}

/**
 * Boot + hourly (spec §5.2) scheduler tick. Idempotent - calling this twice
 * in a row with the same `now` produces identical DB state, because every
 * step below re-derives its worklist from current `status` and only acts on
 * rows still in the status it's looking for:
 *  1. Materialize recurrence -> 'scheduled' (only touches 'draft' rows).
 *  2. End every 'active' row whose window has closed (only touches 'active'
 *     rows whose ends_at <= now; ended rows won't match on a second call).
 *  3. Activate every 'scheduled' row whose window has opened, in
 *     (starts_at, id) order. If more than one candidate's window opened
 *     since the last tick (e.g. two events both scheduled for windows that
 *     start within the same missed hour), activateEvent's own one-active
 *     enforcement means only the LAST one processed - the one with the
 *     latest starts_at, ties broken by id - ends up 'active'; the other(s)
 *     are left 'ended', not 'scheduled' (documented choice: an event whose
 *     window opened and then got immediately superseded did, technically,
 *     run - if that's undesirable a coordinator should not schedule
 *     overlapping windows). Already-'active' rows won't match on a second
 *     call, so this is idempotent too.
 */
export function runScheduler(now = Date.now()) {
  materializeRecurrences(now);

  for (const event of listEvents()) {
    if (event.status === 'active' && event.ends_at != null && event.ends_at <= now) {
      endEvent(event.id, now);
    }
  }

  const arrived = listEvents()
    .filter((e) => e.status === 'scheduled' && e.starts_at != null && e.starts_at <= now)
    .sort((a, b) => (a.starts_at - b.starts_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const event of arrived) {
    activateEvent(event.id, now);
  }
}

/**
 * Called from the state-load path (stateService.js) on every request.
 * Mutates `state.meta.eventProgress` in place (matching the established
 * convention in this module - see scheduleAnomaly in shared/reducer.js -
 * `state` here is always the freshly-evaluate()'d clone loadEvaluateAndSchedule
 * just produced, safe to mutate directly) and, on a fresh join, writes a
 * matching `event_participation` row.
 *
 * Three cases, per spec §5.3:
 *  - No event active: leave `eventProgress` exactly as-is (a lingering run
 *    from a just-ended event must stay reachable through its own 48h grace
 *    period - see endEvent's doc comment - so "nothing active right now"
 *    must NOT clear it).
 *  - An event is active and `eventProgress` already targets it: no-op
 *    (idempotent - this runs on every load).
 *  - An event is active and `eventProgress` targets a DIFFERENT
 *    (now-superseded) event, or is null: clear/replace it. Baselines for
 *    all five event metrics are snapshotted at THIS moment (the user's
 *    personal start), and the personal window runs the event's full
 *    duration from here, capped at 24h past the event's global end.
 *
 * Returns the active event row (or null/undefined if none) so callers
 * (stateService) don't need a second DB round-trip to build the API
 * response's `activeEvent` field.
 */
export function joinEventIfEligible(userId, state, now = Date.now()) {
  const activeEvent = getActiveEvent();
  const progress = state.meta.eventProgress;

  if (activeEvent && progress && progress.eventId !== activeEvent.id) {
    state.meta.eventProgress = null;
  }

  if (!activeEvent) return activeEvent;
  if (state.meta.eventProgress && state.meta.eventProgress.eventId === activeEvent.id) {
    return activeEvent;
  }

  const baseline = {};
  for (const metricId of EVENT_METRIC_IDS) {
    baseline[metricId] = eventMetricValue(metricId, state.meta) ?? 0;
  }

  const eventDurationMs = activeEvent.ends_at - activeEvent.starts_at;
  const endsAt = Math.min(now + eventDurationMs, activeEvent.ends_at + DAY_MS);

  state.meta.eventProgress = {
    eventId: activeEvent.id,
    joinedAt: now,
    endsAt,
    baseline,
    rungsClaimed: [],
  };

  const user = getUserById(userId);
  upsertParticipation({
    userId,
    eventId: activeEvent.id,
    startedAt: now,
    endsAt,
    rungsClaimed: 0,
    lastProgressAt: now,
    optedOut: !!(user && user.leaderboard_opt_out),
  });

  return activeEvent;
}
