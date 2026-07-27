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

async function request(path, opts) {
  let res;
  try {
    res = await fetch(path, { credentials: 'include', ...opts });
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

// GET /api/config -> { version, data }
export function fetchConfig() {
  return request('/api/config');
}

// POST /api/minigame/start { game } -> { sessionId }
//   | 429 { error: 'cooldown_active', retryAt } | 409 { error: 'session_open' }
export function startMinigame(game) {
  return postJSON('/api/minigame/start', { game });
}

// POST /api/minigame/finish { sessionId, metric } -> { state, wafers }
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

// GET /api/changelog -> plain text on success, { status, error } on failure.
export async function fetchChangelog() {
  let res;
  try {
    res = await fetch('/api/changelog', { credentials: 'include' });
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
//   On success: calls onReconcile(state, results, serverTime), then
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

    const { state, results, serverTime } = res;
    onReconcile(state, results, serverTime);
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
