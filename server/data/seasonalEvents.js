// Seeded seasonal Live Events (v1.4, ladders retuned in v1.12). Pure data, no
// runtime dependencies -
// consumed by server/db.js's seedSeasonalEvents() at boot.
//
// Every entry's `modifiers` and `ladder` are asserted (tests/db.events.test.js)
// to pass shared/events.js's validateModifiers/validateLadder, so every
// modifier `value` is authored within its TUNABLES [min, max] range
// (shared/configSchema.js) and every ladder's per-metric targets strictly
// increase. `recurrence` is annual: {month (1-indexed), day, durationDays} -
// Task 4's scheduler materializes these into concrete starts_at/ends_at
// windows; the seeded rows themselves carry no window (status 'draft').
//
// v1.12: every flopsEarned rung is expressed in `unit: 'secondsOfOutput'`.
// Absolute FLOPS targets were the one reward system not priced against the
// player's rate, so the entire FLOPS ladder of every event cleared in under
// 0.02 seconds. The count-based rungs are raised to suit the event's duration
// under the retuned economy, and every `flops` REWARD is now paid in
// wafers/tapes - a literal FLOPS payout has exactly the scaling problem the
// targets did.

export const SEASONAL_EVENTS = [
  {
    id: 'summer-surge',
    name: 'Summer Surge',
    description: 'Peak-heat season: racks run hotter and the grid pushes harder. Extra headroom, extra output.',
    theme: { icon: '☀️', color: '#f59e0b' },
    modifiers: [
      { path: 'heat.capacity', value: 4000 },
      { path: 'production.gridMult', value: 1.5 },
    ],
    ladder: [
      { metric: 'wafersEarned', target: 400, reward: { wafers: 20 } },
      { metric: 'flopsEarned', target: 600, unit: 'secondsOfOutput', reward: { wafers: 15 } },
      { metric: 'minigamesWon', target: 10, reward: { wafers: 15 } },
      { metric: 'tapesEarned', target: 150, reward: { tapes: 10 } },
      { metric: 'blocksClaimed', target: 10, reward: { wafers: 25 } },
      { metric: 'wafersEarned', target: 1500, reward: { wafers: 40 } },
      { metric: 'flopsEarned', target: 1800, unit: 'secondsOfOutput', reward: { wafers: 35 } },
      { metric: 'minigamesWon', target: 30, reward: { wafers: 35 } },
      { metric: 'tapesEarned', target: 500, reward: { tapes: 30 } },
      { metric: 'blocksClaimed', target: 30, reward: { wafers: 75, tapes: 20 } },
    ],
    recurrence: { month: 7, day: 1, durationDays: 14 },
  },
  {
    id: 'spooky-packets',
    name: 'Spooky Packets',
    description: 'Something is loose in the minigame queue. Faster spawns, tighter cooldowns, wider risk zones.',
    theme: { icon: '🎃', color: '#8b5cf6' },
    modifiers: [
      { path: 'minigames.winCooldownMs', value: 10000 },
      { path: 'minigames.rush.maxTapsPerSec', value: 25 },
      { path: 'minigames.debug.spawnMaxMs', value: 500 },
      { path: 'minigames.balance.riskZoneWidth', value: 10 },
    ],
    ladder: [
      { metric: 'minigamesWon', target: 12, reward: { wafers: 15 } },
      { metric: 'tapesEarned', target: 100, reward: { tapes: 8 } },
      { metric: 'wafersEarned', target: 250, reward: { wafers: 20 } },
      { metric: 'blocksClaimed', target: 6, reward: { wafers: 15 } },
      { metric: 'flopsEarned', target: 600, unit: 'secondsOfOutput', reward: { wafers: 15 } },
      { metric: 'minigamesWon', target: 36, reward: { wafers: 40 } },
      { metric: 'tapesEarned', target: 300, reward: { tapes: 20 } },
      { metric: 'wafersEarned', target: 900, reward: { wafers: 45 } },
      { metric: 'blocksClaimed', target: 18, reward: { tapes: 35 } },
      { metric: 'flopsEarned', target: 1800, unit: 'secondsOfOutput', reward: { wafers: 60 } },
    ],
    recurrence: { month: 10, day: 24, durationDays: 8 },
  },
  {
    id: 'black-frame-friday',
    name: 'Black Frame Friday',
    description: 'A short, brutal window of overclocked output. Blink and it is over.',
    theme: { icon: '⚡', color: '#171717' },
    modifiers: [
      { path: 'production.globalMult', value: 2.5 },
      { path: 'production.overclockMult', value: 2 },
      { path: 'production.racksMult', value: 1.5 },
    ],
    ladder: [
      { metric: 'flopsEarned', target: 600, unit: 'secondsOfOutput', reward: { wafers: 20 } },
      { metric: 'wafersEarned', target: 150, reward: { wafers: 25 } },
      { metric: 'tapesEarned', target: 50, reward: { tapes: 15 } },
      { metric: 'blocksClaimed', target: 3, reward: { wafers: 20 } },
      { metric: 'minigamesWon', target: 4, reward: { wafers: 20 } },
      { metric: 'flopsEarned', target: 1800, unit: 'secondsOfOutput', reward: { wafers: 55 } },
      { metric: 'wafersEarned', target: 500, reward: { wafers: 60 } },
      { metric: 'tapesEarned', target: 160, reward: { tapes: 45 } },
      { metric: 'blocksClaimed', target: 9, reward: { tapes: 60 } },
      { metric: 'minigamesWon', target: 12, reward: { wafers: 50, tapes: 30 } },
    ],
    recurrence: { month: 11, day: 27, durationDays: 4 },
  },
  {
    id: 'frost-uptime',
    name: 'Frost Uptime',
    description: 'Cold storage runs efficient in the cold. Leave it running - the offline caps stretch further this season.',
    theme: { icon: '❄️', color: '#38bdf8' },
    modifiers: [
      { path: 'offline.baseCapHours', value: 8 },
      { path: 'offline.hardCapHours', value: 120 },
      { path: 'offline.capPerUptimeLevel', value: 2 },
      { path: 'batchQueue.blockCycleBonusPct', value: 0.08 },
    ],
    ladder: [
      { metric: 'blocksClaimed', target: 20, reward: { wafers: 20 } },
      { metric: 'tapesEarned', target: 250, reward: { tapes: 20 } },
      { metric: 'wafersEarned', target: 600, reward: { wafers: 30 } },
      { metric: 'flopsEarned', target: 600, unit: 'secondsOfOutput', reward: { wafers: 25 } },
      { metric: 'minigamesWon', target: 15, reward: { wafers: 25 } },
      { metric: 'blocksClaimed', target: 60, reward: { tapes: 50 } },
      { metric: 'tapesEarned', target: 800, reward: { tapes: 60 } },
      { metric: 'wafersEarned', target: 2200, reward: { wafers: 80 } },
      { metric: 'flopsEarned', target: 1800, unit: 'secondsOfOutput', reward: { wafers: 70 } },
      { metric: 'minigamesWon', target: 45, reward: { wafers: 100, tapes: 80 } },
    ],
    recurrence: { month: 12, day: 20, durationDays: 21 },
  },
];
