export const TICK_MS = 250;

// Anomaly (formerly "event") timing is now server/config-authoritative
// (server.nextAnomalyAt/anomalyExpiresAt, config.anomaly.*) - this survives
// only as the client-side flavor-text pool, no longer used to actually
// schedule anything.
export const ANOMALY_LABELS = [
  'Anomalous compute spike detected',
  'Unscheduled maintenance window open',
  'Surplus cycles up for grabs',
  'Rogue background process found',
];

// Overclock heat cooldown and vent cooldown are now server state/config
// (run.heatCooldownUntil, server.lastVentAt, config.heat.*) - no client
// constants needed for them any more.

// Minigame durations, spawn timing, pair counts, win cooldown, and the
// Balance risk-zone tuning are all server/config-authoritative as of Task 11
// (config.data.minigames.*, plus server.gameCooldowns for the per-game
// cooldown display) - no client constants needed for them any more.

// Action queue: how often makeActionQueue() (game/api.js) auto-flushes
// queued actions to the server when the queue is non-empty, and the cap on
// its exponential backoff after consecutive batch-send failures.
export const ACTION_FLUSH_MS = 1000;
export const ACTION_RETRY_MAX_MS = 30000;

// Live Events (v1.4): how often RackStack.jsx's refreshEventData() (the
// event identity/ladder + leaderboard fetch, GET /api/event) is allowed to
// piggyback on a reconcile - eventProgress itself (rungs claimed, baseline)
// is part of canonical state and updates for free on every reconcile; this
// throttle only bounds the *extra* GET /api/event call for the leaderboard/
// identity, so a burst of IMMEDIATE actions doesn't turn into a request per
// reconcile.
export const EVENT_REFRESH_THROTTLE_MS = 8000;

// Live Events (v1.4): how often the client re-checks GET /api/config for a
// changed EFFECTIVE config. Activating or ending an event overlays/removes
// that event's modifiers on the document the server evaluates with, WITHOUT
// bumping the stored config's `version` - so the admin-save refetch path
// (onConfigSaved) never fires for it, and an idle tab would otherwise keep
// predicting production and heat from the pre-event numbers indefinitely.
// The response is a cached in-memory document server-side and the client
// discards it unless (version, activeEventId) actually changed.
export const CONFIG_POLL_MS = 10000;
