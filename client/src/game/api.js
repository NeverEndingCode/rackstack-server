// Network layer for the server-authoritative economy: plain fetch wrappers
// for the one-shot endpoints, plus makeActionQueue() for batched/queued
// game actions (buy, collect, migrate, ...).
//
// Error convention: every exported function *returns* (never throws) on
// failure - this codebase prefers return values over exceptions for
// expected failure modes. On success, a function resolves to exactly the
// JSON shape documented on its declaration below. On failure - a non-2xx
// HTTP response or a network/fetch error - it resolves to a plain object
// `{ status, error, ...extra }`:
//   - `status` is the HTTP status code, or 0 for a network-level failure
//     (fetch threw, e.g. offline).
//   - `error` is the server's `error` code from the JSON body (e.g.
//     'cooldown_active', 'invalid_username'), or a generic fallback string
//     if the body wasn't JSON or had no `error` field.
//   - any other fields the server's error body included (e.g. `retryAt` on
//     a 429 cooldown response) are spread onto the result too.
// None of the documented success shapes ever contain a top-level `error`
// key, so callers can branch with `if (result.error) { ... }`.
//
// All requests send `credentials: 'include'` so the auth cookie rides
// along cross-origin-safe same-site requests.
//
// makeActionQueue() layers its own failure handling on top of the above for
// *batch-level* failures (the whole /api/actions POST failed, as opposed to
// an individual action in it being rejected): see its doc comment below for
// the retry/backoff/onQueueError contract.

import { ACTION_FLUSH_MS, ACTION_RETRY_MAX_MS } from './constants.js';

// ---------------------------------------------------------------------------
// Session refresh (v1.9)
// ---------------------------------------------------------------------------
//
// A SuperTokens access token expires long before the session does; renewing it
// is POST /auth/session/refresh, using the refresh cookie the browser already
// holds. Without this the player is silently logged out mid-session the first
// time the access token lapses.
//
// Off unless the server says the client is driving SuperTokens. In `passport`
// mode a 401 means "not logged in" and there is nothing to renew - the refresh
// endpoint is not even mounted - so attempting it would add a doomed round
// trip to every unauthenticated request.

let refreshEnabled = false;

/** Called once at boot with the payload of GET /api/auth-info. */
export function configureAuthRefresh(authInfo) {
  refreshEnabled = authInfo?.loginFlow === 'supertokens';
}

// Exported for tests only - module-level state otherwise leaks between cases.
export function __resetAuthRefreshForTests() {
  refreshEnabled = false;
  inFlightRefresh = null;
}

// The single shared in-flight refresh.
//
// This is the part most likely to be got wrong, and the failure is not merely
// wasteful. The app fires several requests at once, so an access token that
// has just expired produces a burst of simultaneous 401s. Refreshing per-401
// would send N concurrent refreshes with the SAME refresh token; SuperTokens
// rotates that token on use, so the first call invalidates the token the other
// N-1 are still presenting. Those look exactly like token theft to the core,
// which responds by revoking the session - turning a routine renewal into a
// forced logout, and only ever under concurrency.
//
// One promise, shared by every caller, same shape as server/userLock.js.
let inFlightRefresh = null;

function refreshSession() {
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async () => {
    try {
      const res = await fetch('/auth/session/refresh', {
        method: 'POST',
        credentials: 'include',
        // Same reason as the signinup call in game/auth.js: this is what tells
        // SuperTokens to put the rotated tokens back in cookies. Refresh
        // tolerates its absence better than session creation does (it infers
        // the method from the tokens it was given), but a refresh that
        // silently switched the session to header transport would log the
        // player out on the next request, which is the same invisible failure
        // one step later.
        headers: { 'st-auth-mode': 'cookie' },
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      // Cleared before this promise settles, so the NEXT 401 starts a fresh
      // attempt rather than re-awaiting a completed one.
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

/**
 * fetch + one refresh-and-retry on 401.
 *
 * `allowRefresh` is what bounds it to a single attempt: the retry passes
 * false, so a second 401 is returned to the caller rather than starting a
 * refresh loop. A 401 after a successful refresh means the session is
 * genuinely gone, not stale.
 *
 * Throws on network failure, like fetch - callers translate that.
 */
async function fetchWithRefresh(path, opts, allowRefresh = true) {
  const res = await fetch(path, { credentials: 'include', ...opts });
  if (res.status !== 401 || !allowRefresh || !refreshEnabled) return res;

  const refreshed = await refreshSession();
  if (!refreshed) return res;
  return fetchWithRefresh(path, opts, false);
}

async function request(path, opts) {
  let res;
  try {
    res = await fetchWithRefresh(path, opts);
  } catch (e) {
    return { status: 0, error: 'network_error' };
  }

  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (e) { body = null; }
  }

  if (!res.ok) {
    const errBody = (body && typeof body === 'object') ? body : {};
    return { status: res.status, ...errBody, error: errBody.error || 'request_failed' };
  }
  return body;
}

function postJSON(path, payload, method = 'POST') {
  return request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// GET /api/state -> { run, meta, server, offlineGain, configVersion, serverTime }
export function fetchState() {
  return request('/api/state');
}

// GET /api/config -> { version, activeEventId, data }
// The GAMEPLAY config: the admin baseline with the currently active live
// event's modifiers already merged in, i.e. exactly the document the SERVER
// evaluates with. Runtime-only fields (__activeEvent) are stripped server-
// side. `activeEventId` is the other half of the cache key - the config
// `version` does NOT change when an event flips active/ended, so a client
// watching version alone would silently keep running on the wrong numbers.
// Admin tooling must use fetchAdminConfig() instead (see below).
export function fetchConfig() {
  return request('/api/config');
}

// GET /api/admin/config -> { version, data }
// The admin-authored BASELINE, with no event overlay. This is what the
// Balancing tab loads and PUTs back to /api/admin/config: loading the
// overlaid document there would bake an active event's modifiers into the
// stored config permanently on the next save.
export function fetchAdminConfig() {
  return request('/api/admin/config');
}

// POST /api/minigame/start { game } -> { sessionId }
//   | 429 { error: 'cooldown_active', retryAt } | 409 { error: 'session_open' }
export function startMinigame(game) {
  return postJSON('/api/minigame/start', { game });
}

// POST /api/minigame/finish { sessionId, metric } -> { state, wafers, newBest }
//   newBest: true iff this run's (clamped) score beat every prior finished
//   score for this game, per GET /api/minigame/bests - false on ties.
//   | 410 { error: 'gone' } | 404 { error: 'not_found' } | 429 { error: 'cooldown_active' }
export function finishMinigame(sessionId, metric) {
  return postJSON('/api/minigame/finish', { sessionId, metric });
}

// PUT /api/me/username { username } -> { ok, username }
//   | 400 { error: 'invalid_username' } | 409 { error: 'taken' }
export function setUsername(name) {
  return postJSON('/api/me/username', { username: name }, 'PUT');
}

// ---------------------------------------------------------------------------
// Admin (role-gated server-side; see server/routes/api.js)
// ---------------------------------------------------------------------------

// GET /api/admin/users -> { users: [{ id, username, provider, level, wafers,
//   legacyCores, singularityShards, stats }] }
export function fetchAdminUsers() {
  return request('/api/admin/users');
}

// PUT /api/admin/config { data } -> { version } | 400 { errors: string[] }
export function putAdminConfig(data) {
  return postJSON('/api/admin/config', { data }, 'PUT');
}

// GET /api/admin/config/history -> { history: [{ version, data, updatedAt, updatedBy }] }
// (newest-first)
export function fetchConfigHistory() {
  return request('/api/admin/config/history');
}

// POST /api/admin/config/rollback { version } -> { version }
//   | 400 { error: 'not_found' | 'corrupt' } | 400 { errors: string[] }
export function rollbackConfig(version) {
  return postJSON('/api/admin/config/rollback', { version });
}

// GET /api/admin/roles -> { users: [{ id, username, roles, isOwner }] }
export function fetchAdminRoles() {
  return request('/api/admin/roles');
}

// POST /api/admin/roles { userId, role: 'admin'|'event_coordinator', op: 'grant'|'revoke' }
//   -> { ok, roles } | 403 { error: 'owner_required' } | 400 { error: 'cannot_modify_owner' | 'invalid_request' }
export function postRoleChange(userId, role, op) {
  return postJSON('/api/admin/roles', { userId, role, op });
}

// ---------------------------------------------------------------------------
// Live Events (v1.4)
// ---------------------------------------------------------------------------

// GET /api/event -> { event: {id,name,description,theme,ladder}|null,
//   progress: {joinedAt,endsAt,rungsClaimed,rungs}|null, leaderboard,
//   pendingClaims: [{ event, progress }] }
// `event` is resolved from the CALLER's own eventProgress, not from whatever
// is globally active, so it stays populated for the whole 48h post-end claim
// grace (spec §5.3) and survives a page reload made inside that window. It is
// null only when the player has no live-or-in-grace window at all.
// `pendingClaims` carries windows force-ended early by a newer event
// activating that are still inside their own grace. `leaderboard` is already
// capped at 50 and opt-out-filtered server-side.
export function fetchEvent() {
  return request('/api/event');
}

// PUT /api/me/leaderboard-opt-out { optOut } -> { ok, optOut }
//   | 400 { error: 'invalid_request' }
// This is the AUTHORITATIVE write - it's what flips users.leaderboard_opt_out,
// the column server-side leaderboard filtering actually reads. The reducer
// action of the same name only mirrors the flag into meta.leaderboardOptOut
// for client display; RackStack.jsx's toggle handler calls both (see its
// doc comment) rather than treating either alone as sufficient.
export function setLeaderboardOptOut(optOut) {
  return postJSON('/api/me/leaderboard-opt-out', { optOut }, 'PUT');
}

// PUT /api/me/tours { tourId, completed } -> { ok, toursCompleted }
//   | 400 { error: 'invalid_request' }  (unregistered tourId, bad types)
// `completed: false` is the replay path. Completing 'onboarding' marks every
// registered tour complete server-side (spec §4.7), so the response's
// toursCompleted is authoritative - callers should adopt it rather than
// predicting the new set locally.
export function setTourCompleted(tourId, completed) {
  return postJSON('/api/me/tours', { tourId, completed }, 'PUT');
}

// GET /api/leaderboard -> { generatedAt, boards: { <boardKey>: [row] } }
//   where row is { userId, username, avatarUrl, value, badges: [achievementId] }
//
// Rows arrive already ranked, opt-out-filtered and capped server-side
// (server/leaderboardService.js) - the client renders them in order and never
// re-sorts. The payload is one shared in-memory server cache, so polling this
// costs nothing beyond the request itself; it's still throttled client-side by
// LEADERBOARD_REFRESH_THROTTLE_MS so a burst of reconciles can't turn into a
// request each.
export function fetchLeaderboard() {
  return request('/api/leaderboard');
}

// ---------------------------------------------------------------------------
// Event coordinator admin (role-gated server-side; Task 8 builds the UI that
// consumes these - included here since api.js is this task's one designated
// home for network calls)
// ---------------------------------------------------------------------------

// GET /api/admin/events -> { events: [{...event row, participationCount}] }
export function fetchAdminEvents() {
  return request('/api/admin/events');
}

// POST /api/admin/events { id, name, description?, theme?, modifiers?, ladder, recurrence? }
//   -> 201 { event } | 400 { errors: string[] } | 409 { error: 'id_taken' }
export function createEvent(data) {
  return postJSON('/api/admin/events', data);
}

// PUT /api/admin/events/:id { name?, description?, theme?, modifiers?, ladder?, startsAt?, endsAt? }
//   -> { event } | 404 { error: 'not_found' } | 409 { error: 'event_active' }
//   | 400 { errors: string[] }
export function updateEvent(id, data) {
  return postJSON(`/api/admin/events/${id}`, data, 'PUT');
}

// DELETE /api/admin/events/:id -> { ok: true }
//   | 404 { error: 'not_found' } | 409 { error: 'not_draft' }
// Drafts only (server-enforced) - no body to send, so this bypasses
// postJSON and calls request() directly.
export function deleteEvent(id) {
  return request(`/api/admin/events/${id}`, { method: 'DELETE' });
}

// POST /api/admin/events/:id/schedule { startsAt, endsAt } -> { event }
//   | 404 { error: 'not_found' } | 409 { error: 'event_active' }
//   | 400 { error: 'invalid_request' }
export function scheduleEvent(id, startsAt, endsAt) {
  return postJSON(`/api/admin/events/${id}/schedule`, { startsAt, endsAt });
}

// POST /api/admin/events/:id/activate -> { event }
//   | 404 { error: 'not_found' } | 409 { error: 'event_active' }
//   | 400 { error: 'not_scheduled' | 'invalid_target' }
export function activateEvent(id) {
  return postJSON(`/api/admin/events/${id}/activate`, {});
}

// POST /api/admin/events/:id/end -> { event } | 404 { error: 'not_found' }
export function endEvent(id) {
  return postJSON(`/api/admin/events/${id}/end`, {});
}

// GET /api/admin/events/:id/participation -> { participation: [row, ...] }
export function fetchEventParticipation(id) {
  return request(`/api/admin/events/${id}/participation`);
}

// GET /api/changelog -> plain text on success, { status, error } on failure.
export async function fetchChangelog() {
  let res;
  try {
    // Refresh-aware like every other call: this sits behind requireAuth too,
    // so an expired access token would otherwise render an empty changelog
    // rather than renewing and succeeding.
    res = await fetchWithRefresh('/api/changelog', {});
  } catch (e) {
    return { status: 0, error: 'network_error' };
  }
  const text = await res.text();
  if (!res.ok) return { status: res.status, error: text || 'request_failed' };
  return text;
}

// ---------------------------------------------------------------------------
// Action queue
// ---------------------------------------------------------------------------

// Action types that skip the 1s auto-flush timer and post immediately:
// one-off/high-stakes moves the player expects to resolve right away rather
// than sit queued for up to a second.
const IMMEDIATE = new Set([
  'migrate', 'singularity', 'hardReset', 'buyUpgrade', 'buyShardUpgrade',
  'claimGoal', 'claimRepeatable', 'claimAnomaly',
  // Cold Storage's direct analogs of the above: buyTapeUpgrade is an
  // upgrade-tree purchase (~buyUpgrade/buyShardUpgrade), claimBlock/
  // claimAllBlocks/claimJob are reward claims (~claimGoal/claimRepeatable/
  // claimAnomaly), and resetTrack is a reset action (~hardReset).
  // startJob/cancelJob deliberately excluded - starting/cancelling isn't a
  // claim or reset, so the normal batched flush is fine for those (same as
  // e.g. buy/collect/vent).
  'buyTapeUpgrade', 'claimBlock', 'claimAllBlocks', 'claimJob', 'resetTrack',
  // Live Events (v1.4): claimEventRung is a reward claim exactly like
  // claimGoal/claimAnomaly/claimBlock above - and it's additionally
  // time-boxed by the 48h grace period (shared/reducer.js's
  // EVENT_CLAIM_GRACE_MS), so sitting queued for up to a second is more
  // than "just a UX nicety" here, it's the difference between claimable and
  // not right at the edge of that window. (v1.3 shipped without its Cold
  // Storage analogs in this set and needed a follow-up fix round - see the
  // block above - so this one goes in from the start.)
  'claimEventRung',
  // Social (v1.5): both are reward claims exactly like claimGoal/
  // claimEventRung above, and both are gated on a UTC calendar-day key - so an
  // action left sitting in the queue across midnight is the difference between
  // claimable and rejected. They go in from the start.
  'claimContract', 'claimStreak',
]);

// makeActionQueue({ onReconcile, onReject, onQueueError }) -> { dispatch, flush, pending }
//
// - dispatch(action): assigns action._cid (an incrementing correlation id,
//   kept separate from any semantic `id` field the action itself carries -
//   e.g. buyUpgrade/buyShardUpgrade/claimGoal/claimRepeatable/buyTapeUpgrade
//   all pass `{ type, id: <string identifier> }`, and clobbering that with
//   this queue's own tracking id would silently break them), enqueues it,
//   and (for IMMEDIATE types) kicks off an immediate flush().
// - flush(): POSTs the queued batch to /api/actions. Only one flush is ever
//   in flight at a time - if one is already running, this is a no-op (and
//   anything dispatched meanwhile just accumulates for the next flush).
//   On success: calls onReconcile(state, results, serverTime, unlockedAchievements), then
//   onReject(result) for each per-action result with `ok: false`. Also
//   resets the backoff below to its normal cadence.
//   On batch-level failure (network error, or a non-2xx from the batch
//   endpoint itself - as opposed to an individual action inside it being
//   rejected, which is onReject's job): the whole batch is put back at the
//   front of the queue for retry, `onQueueError` is called (if provided)
//   with `{ status, error, attempts, nextRetryMs }` (`status` is 0 for a
//   network error; `attempts` is the number of consecutive batch failures
//   so far; `nextRetryMs` is how long until the next attempt is allowed),
//   and further attempts back off exponentially: ACTION_FLUSH_MS on the
//   first failure, doubling on each consecutive one, capped at
//   ACTION_RETRY_MAX_MS. The 1s auto-flush timer keeps ticking throughout,
//   but flush() no-ops until the backoff window elapses, so this never
//   sends more than one request per backoff interval - including
//   IMMEDIATE-triggered flushes, which go through the same gate rather
//   than bypassing it.
//   Special case: a 401 means the session itself is gone (expired/invalid
//   auth cookie) - retrying the same batch would just fail the same way
//   forever. On a 401, `onQueueError` is called with `nextRetryMs: null`
//   and the queue stops attempting to flush entirely (queued actions are
//   left in place, not dropped - `pending()` still reflects them). There
//   is no automatic recovery from this state; the caller is expected to
//   react to `onQueueError`'s 401 (e.g. by sending the user back to the
//   login gate, which will tear down and recreate this queue on reload).
// - pending(): a snapshot array of not-yet-flushed queued actions.
//
// Also wires up best-effort delivery on tab close/hide: pagehide and
// visibilitychange->hidden send whatever's still queued via
// navigator.sendBeacon (fire-and-forget, no response handling) and clear
// the queue. Because sendBeacon never yields a response, there's no
// `results` array to reconcile against - `onBeaconFlush(ids)` is called
// synchronously with the ids of the flushed actions right before they're
// sent, so a caller tracking "still-pending, needs replaying" actions (like
// RackStack's pendingActionsRef) can drop them instead of replaying them on
// every future reconcile forever. This is optimistic-and-assumed-durable:
// if the beacon didn't actually make it, the next GET /api/state or POST
// /api/actions reconcile will just show the pre-flush state again, the same
// eventual-correction tolerance the rest of the optimistic system relies on.
export function makeActionQueue({ onReconcile, onReject, onQueueError, onBeaconFlush }) {
  let queue = [];
  let nextId = 1;
  let inFlight = false;
  let consecutiveFailures = 0;
  let nextAllowedAttemptAt = 0;
  let authStopped = false;
  let intervalId = null;

  function dispatch(action) {
    const withId = { ...action, _cid: nextId++ };
    queue.push(withId);
    if (IMMEDIATE.has(action.type)) flush();
    return withId._cid;
  }

  async function flush() {
    if (authStopped || inFlight || queue.length === 0) return;
    if (Date.now() < nextAllowedAttemptAt) return;

    const batch = queue;
    queue = [];
    inFlight = true;
    const res = await postJSON('/api/actions', { actions: batch });
    inFlight = false;

    if (!res || res.error) {
      // Keep the batch queued (ahead of anything dispatched meanwhile) for
      // retry once the backoff window below elapses.
      queue = batch.concat(queue);
      consecutiveFailures += 1;
      const status = res && typeof res.status === 'number' ? res.status : 0;
      const error = (res && res.error) || 'network_error';

      if (status === 401) {
        authStopped = true;
        if (intervalId !== null) { clearInterval(intervalId); intervalId = null; }
        if (onQueueError) onQueueError({ status, error, attempts: consecutiveFailures, nextRetryMs: null });
        return;
      }

      const delayMs = Math.min(ACTION_FLUSH_MS * 2 ** (consecutiveFailures - 1), ACTION_RETRY_MAX_MS);
      nextAllowedAttemptAt = Date.now() + delayMs;
      if (onQueueError) onQueueError({ status, error, attempts: consecutiveFailures, nextRetryMs: delayMs });
      return;
    }

    consecutiveFailures = 0;
    nextAllowedAttemptAt = 0;

    const { state, results, serverTime, unlockedAchievements } = res;
    // `unlockedAchievements` (v1.5) is the merged set from BOTH server-side
    // sweep sites for this request - the load path (an offline threshold
    // crossed since the last visit) and each successful action - so passing
    // it separately is not redundant with the per-result field of the same
    // name, which only covers the action half.
    onReconcile(state, results, serverTime, unlockedAchievements);
    for (const result of results || []) {
      if (!result.ok) onReject(result);
    }
  }

  function pending() {
    return [...queue];
  }

  function flushViaBeacon() {
    if (queue.length === 0 || typeof navigator === 'undefined' || !navigator.sendBeacon) return;
    const blob = new Blob([JSON.stringify({ actions: queue })], { type: 'application/json' });
    navigator.sendBeacon('/api/actions', blob);
    if (onBeaconFlush) onBeaconFlush(queue.map((a) => a._cid));
    queue = [];
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flushViaBeacon);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushViaBeacon();
    });
  }

  intervalId = setInterval(() => { if (queue.length > 0) flush(); }, ACTION_FLUSH_MS);

  return { dispatch, flush, pending };
}
