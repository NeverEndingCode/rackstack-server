export const GROWTH = 1.14;
export const TICK_MS = 250;
export const MILESTONES = [25, 50, 100, 200, 500, 1000];

// Anomaly (formerly "event") timing is now server/config-authoritative
// (server.nextAnomalyAt/anomalyExpiresAt, config.anomaly.*) - these survive
// only as the client-side flavor-text pool plus legacy fallback numbers, no
// longer used to actually schedule anything.
export const ANOMALY_WINDOW = 15000;
export const ANOMALY_MIN_DELAY = 70000;
export const ANOMALY_MAX_DELAY = 150000;
export const ANOMALY_LABELS = [
  'Anomalous compute spike detected',
  'Unscheduled maintenance window open',
  'Surplus cycles up for grabs',
  'Rogue background process found',
];

// Overclock heat cooldown and vent cooldown are now server state/config
// (run.heatCooldownUntil, server.lastVentAt, config.heat.*) - no client
// constants needed for them any more.

// Per-game post-win cooldown, ephemeral (not persisted) - see gameCooldownsRef.
export const GAME_WIN_COOLDOWN_MS = 30000;

// Debug Sprint
export const DEBUG_MAX_LIT = 3;
export const DEBUG_SPAWN_MIN_MS = 400;
export const DEBUG_SPAWN_MAX_MS = 900;

// Cable Match
export const MATCH_PAIR_COUNT = 10;

// Action queue: how often makeActionQueue() (game/api.js) auto-flushes
// queued actions to the server when the queue is non-empty, and the cap on
// its exponential backoff after consecutive batch-send failures.
export const ACTION_FLUSH_MS = 1000;
export const ACTION_RETRY_MAX_MS = 30000;

// Overclock Balance
export const BALANCE_SAFE_ZONE_MIN = 35;
export const BALANCE_SAFE_ZONE_MAX = 65;
export const BALANCE_BASE_SPEED = 0.024; // % of bar per ms
export const BALANCE_SPEED_VARIANCE = 0.010; // +/- fluctuation applied periodically
export const BALANCE_MISS_PENALTY = 2;
