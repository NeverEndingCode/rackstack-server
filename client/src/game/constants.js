export const GROWTH = 1.14;
export const TICK_MS = 250;
export const MILESTONES = [25, 50, 100, 200, 500, 1000];
export const EVENT_WINDOW = 15000;
export const EVENT_MIN_DELAY = 70000;
export const EVENT_MAX_DELAY = 150000;
export const EVENT_LABELS = [
  'Anomalous compute spike detected',
  'Unscheduled maintenance window open',
  'Surplus cycles up for grabs',
  'Rogue background process found',
];

// Overclock heat cooldown: mandatory lockout once heat hits 100%. Stored as
// an absolute timestamp (run.heatCooldownUntil) rather than a ref so it
// correctly reflects elapsed time even if the tab was closed and reopened.
export const HEAT_COOLDOWN_MS = 10000;
export const VENT_COOLDOWN_MS = 2500;

// Per-game post-win cooldown, ephemeral (not persisted) - see gameCooldownsRef.
export const GAME_WIN_COOLDOWN_MS = 30000;

// Debug Sprint
export const DEBUG_MAX_LIT = 3;
export const DEBUG_SPAWN_MIN_MS = 400;
export const DEBUG_SPAWN_MAX_MS = 900;

// Cable Match
export const MATCH_PAIR_COUNT = 10;

// Admin-only UI visibility - the real gate is server-side (server/auth.js),
// this only decides whether to show the section at all.
export const ADMIN_USER_ID = 'github:37058311';

// Overclock Balance
export const BALANCE_SAFE_ZONE_MIN = 35;
export const BALANCE_SAFE_ZONE_MAX = 65;
export const BALANCE_BASE_SPEED = 0.024; // % of bar per ms
export const BALANCE_SPEED_VARIANCE = 0.010; // +/- fluctuation applied periodically
export const BALANCE_MISS_PENALTY = 2;
