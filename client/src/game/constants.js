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
