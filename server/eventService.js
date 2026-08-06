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
import {
  EVENT_METRIC_IDS, eventMetricValue, isValidRecurrence, rungProgress,
} from '../shared/events.js';
import { EVENT_CLAIM_GRACE_MS } from '../shared/reducer.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// How many superseded-but-still-claimable windows a save carries at once.
// Only reachable when a coordinator runs several events back-to-back inside
// one 48h grace period; the cap keeps a pathological schedule from growing
// meta.pendingEventClaims without bound.
const MAX_PENDING_EVENT_CLAIMS = 3;

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
 * Refuses to activate an event whose stored window has ALREADY fully
 * elapsed. This guard lives here, in the shared primitive, rather than only
 * on the manual /activate route (where it originally shipped): runScheduler
 * calls this same function, and a server that was down across a scheduled
 * event's entire window - a host reboot, a container redeploy, an Unraid
 * update, all routine for this deployment - would otherwise activate the
 * dead event on next boot. That wipes every mid-grace player's eventProgress
 * and joins them to a personal window (`min(now + duration, ends_at + 24h)`)
 * that expired days ago, so they get no event tab at all, while the stale
 * event's modifiers apply globally until the next hourly tick. The route
 * keeps its own identical check so it can answer with its documented 400
 * `invalid_target` before anything else happens.
 *
 * Returns `{ ok: true }` or `{ ok: false, error }`.
 */
export async function activateEvent(id, now = Date.now()) {
  const event = await getEvent(id);
  if (!event) return { ok: false, error: 'not_found' };
  if (event.ends_at == null) return { ok: false, error: 'not_scheduled' };
  if (event.ends_at <= now) return { ok: false, error: 'invalid_target' };

  for (const other of await listEvents()) {
    if (other.status === 'active' && other.id !== id) {
      await setEventStatus(other.id, 'ended');
    }
  }

  const startsAt = event.starts_at ?? now;
  await setEventStatus(id, 'active', { startsAt, endsAt: event.ends_at });
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
export async function endEvent(id, now = Date.now()) {
  const event = await getEvent(id);
  if (!event) return { ok: false, error: 'not_found' };
  await setEventStatus(id, 'ended');
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
 * Materializes a recurrence into a concrete scheduled window. Two cases:
 *
 *  1. First run: `status: 'draft'`, has a `recurrence`, and has NO window yet
 *     (`starts_at`/`ends_at` both null). Deliberately narrow - a DRAFT with a
 *     coordinator-set window (even if it also carries a recurrence) is never
 *     touched here; hand-set scheduling wins over the annual default.
 *  2. Re-arming: `status: 'ended'`, has a `recurrence`, and its window has
 *     been fully past for longer than the claim grace period. Without this,
 *     "recurring" seasonal events ran exactly ONCE ever: nothing returns an
 *     event to 'draft', so after summer-surge's first year it stayed 'ended'
 *     forever and the README's "materialized automatically, every year"
 *     promise (and spec §5.1/§5.2's annual recurrence) was simply false.
 *     nextOccurrence() already targets next year once this year's window has
 *     elapsed, so re-scheduling from here lands on the right one.
 *
 * The `+ EVENT_CLAIM_GRACE_MS` settle period on case 2 matters twice over.
 * It keeps a just-ended event visibly 'ended' (rather than instantly
 * re-labelled 'scheduled' for next year) for as long as anyone could still
 * be claiming against it - and it's what exempts an event a coordinator
 * ENDED EARLY, by hand, mid-window: that row's `ends_at` is still in the
 * FUTURE, so it can't match here and won't be re-armed out from under the
 * coordinator's decision. The manual end kills that occurrence only; once
 * the authored window elapses, the annual recurrence resumes as authored. A
 * coordinator who wants an event to stop recurring removes its recurrence.
 *
 * Rows whose stored `recurrence` isn't a valid `{month, day, durationDays}`
 * are skipped outright: nextOccurrence() would compute a NaN window and
 * strand the event in 'scheduled' forever. POST /api/admin/events rejects
 * such shapes at write time (shared/events.js's validateRecurrence), so this
 * only ever fires on rows written before that validation existed, or edited
 * directly in the DB.
 */
async function materializeRecurrences(now) {
  for (const event of await listEvents()) {
    if (!isValidRecurrence(event.recurrence)) continue;

    const isUnscheduledDraft = event.status === 'draft'
      && event.starts_at == null && event.ends_at == null;
    const isElapsedRecurring = event.status === 'ended'
      && event.ends_at != null && now > event.ends_at + EVENT_CLAIM_GRACE_MS;
    if (!isUnscheduledDraft && !isElapsedRecurring) continue;

    const { startsAt, endsAt } = nextOccurrence(event.recurrence, now);
    await setEventStatus(event.id, 'scheduled', { startsAt, endsAt });
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
 *     call, so this is idempotent too. A candidate whose window has ALREADY
 *     fully elapsed by the time this tick runs (the server was down across
 *     the whole window - reboot, redeploy, Unraid update) is marked 'ended'
 *     here instead of activated; activateEvent refuses it anyway, but
 *     leaving it 'scheduled' would make it a candidate again on every
 *     subsequent tick, forever. Marking it 'ended' also hands it to
 *     materializeRecurrences above, which re-arms it for next year if it
 *     recurs.
 */
export async function runScheduler(now = Date.now()) {
  await materializeRecurrences(now);

  for (const event of await listEvents()) {
    if (event.status === 'active' && event.ends_at != null && event.ends_at <= now) {
      await endEvent(event.id, now);
    }
  }

  const arrived = (await listEvents())
    .filter((e) => e.status === 'scheduled' && e.starts_at != null && e.starts_at <= now)
    .sort((a, b) => (a.starts_at - b.starts_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const event of arrived) {
    if (event.ends_at == null || event.ends_at <= now) {
      await endEvent(event.id, now);
      continue;
    }
    await activateEvent(event.id, now);
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
 * Superseding is where the claim right used to die. This function used to
 * simply null out the old `eventProgress`; spec §5.2 does force-end a
 * lingering personal WINDOW when the next event activates, but §5.3 keeps
 * claims open for 48h past that personal end, and force-ending the window is
 * not the same as destroying the claim. A coordinator starting the next
 * event within 48h of the previous one's personal end - the normal cadence
 * for back-to-back weekend events - silently and permanently destroyed every
 * met-but-unclaimed rung. The superseded record is now moved to
 * `meta.pendingEventClaims` (newest first) for the remainder of its own
 * grace period instead, where claimEventRung, stateService's
 * `__pendingClaimables` and GET /api/event can all still reach it.
 *
 * Returns the active event row (or null/undefined if none) so callers
 * (stateService) don't need a second DB round-trip to build the API
 * response's `activeEvent` field.
 */
export async function joinEventIfEligible(userId, state, now = Date.now()) {
  const activeEvent = await getActiveEvent();
  const progress = state.meta.eventProgress;

  if (activeEvent && progress && progress.eventId !== activeEvent.id) {
    // The OUTGOING event, not the incoming one - supersede needs its ladder to
    // freeze the met-but-unclaimed rung set before the window is force-ended.
    supersedeEventProgress(state.meta, now, await getEvent(progress.eventId));
  }

  // Runs on every load, event active or not, so records age out of the save
  // on their own rather than only when the next event happens to activate.
  prunePendingEventClaims(state.meta, now);

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

  const user = await getUserById(userId);
  await upsertParticipation({
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

/**
 * Every event this player can still act on, resolved from their own save
 * rather than from "whatever is globally active right now":
 *
 *   { current: { event, progress } | null, pending: [{ event, progress }] }
 *
 * `current` is their live-or-in-grace `meta.eventProgress`; `pending` is each
 * force-ended-but-still-claimable window from `meta.pendingEventClaims`.
 * Rows are looked up by id with getEvent() - NOT getActiveEvent() - so this
 * resolves regardless of the event's current global status, which is the
 * whole point: gating on `status === 'active'` is what made the 48h claim
 * grace unreachable through the UI (GET /api/event returned event:null the
 * instant an event ended globally, so a player who reloaded mid-grace lost
 * the ladder and every Claim button, permanently).
 *
 * Deliberately does NOT filter on the grace window - callers decide. The
 * per-request `__claimableEvent`/`__pendingClaimables` config fields must
 * stay attached past grace so claimEventRung can answer `cooldown_active`
 * (its documented past-grace code) instead of falling through to
 * `invalid_target`; the presentation routes gate on inClaimGrace() below.
 */
export async function resolvePlayerEvents(state) {
  const result = { current: null, pending: [] };

  const ep = state.meta.eventProgress;
  if (ep && typeof ep.eventId === 'string') {
    const event = await getEvent(ep.eventId);
    if (event) result.current = { event, progress: ep };
  }

  const pending = Array.isArray(state.meta.pendingEventClaims) ? state.meta.pendingEventClaims : [];
  for (const p of pending) {
    if (!p || typeof p.eventId !== 'string') continue;
    const event = await getEvent(p.eventId);
    if (event) result.pending.push({ event, progress: p });
  }

  return result;
}

/** Whether a personal progress record is still inside its 48h claim grace. */
export function inClaimGrace(progress, now) {
  return !!(progress && typeof progress.endsAt === 'number'
    && now <= progress.endsAt + EVENT_CLAIM_GRACE_MS);
}

/**
 * Moves `meta.eventProgress` into `meta.pendingEventClaims` (force-ending the
 * window per spec §5.2 while keeping the §5.3 claim right alive) and clears
 * the live slot. A record whose grace has ALREADY run out is dropped rather
 * than stored - there's nothing left to claim on it.
 *
 * The window is genuinely FORCE-ENDED here, which means two things:
 *
 *  - `endsAt` collapses to `now` when the window was still running. `now` IS
 *    the personal end in that case, so the 48h grace runs from here. (A
 *    window that already ended naturally keeps its own earlier `endsAt`, so
 *    superseding can never EXTEND a grace that was already counting down.)
 *  - The set of rungs that were met-but-unclaimed at this instant is frozen
 *    onto the record as `claimableRungs`. Without it the superseded ladder
 *    keeps climbing against live `meta` alongside the new event's ladder, and
 *    a single grind pays out BOTH - spec §5.2 force-ends the window and §5.3
 *    keeps open only the rungs "already qualified", not future ones.
 */
function supersedeEventProgress(meta, now, outgoingEvent) {
  const progress = meta.eventProgress;
  meta.eventProgress = null;
  if (!progress || typeof progress.eventId !== 'string') return;
  if (typeof progress.endsAt !== 'number' || now > progress.endsAt + EVENT_CLAIM_GRACE_MS) return;

  const ladder = outgoingEvent && Array.isArray(outgoingEvent.ladder) ? outgoingEvent.ladder : [];
  const claimed = Array.isArray(progress.rungsClaimed) ? progress.rungsClaimed : [];
  progress.claimableRungs = ladder.reduce((acc, rung, i) => {
    if (!claimed.includes(i) && rungProgress(rung, meta, progress.baseline).met) acc.push(i);
    return acc;
  }, []);
  progress.endsAt = Math.min(progress.endsAt, now);

  const pending = Array.isArray(meta.pendingEventClaims) ? meta.pendingEventClaims : [];
  // Dedupe by eventId (`.find`-style filter, never a bare-key lookup) so a
  // re-activated event can't end up with two competing records.
  meta.pendingEventClaims = [progress, ...pending.filter((p) => p && p.eventId !== progress.eventId)]
    .slice(0, MAX_PENDING_EVENT_CLAIMS);
}

/** Drops pending records whose own 48h claim grace has fully run out. */
function prunePendingEventClaims(meta, now) {
  const pending = meta.pendingEventClaims;
  if (!Array.isArray(pending)) { meta.pendingEventClaims = []; return; }
  meta.pendingEventClaims = pending.filter(
    (p) => p && typeof p.eventId === 'string' && typeof p.endsAt === 'number'
      && now <= p.endsAt + EVENT_CLAIM_GRACE_MS,
  );
}
