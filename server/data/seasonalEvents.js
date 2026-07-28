// Seeded seasonal Live Events (v1.4). Pure data, no runtime dependencies -
// consumed by server/db.js's seedSeasonalEvents() at boot.
//
// Every entry's `modifiers` and `ladder` are asserted (tests/db.events.test.js)
// to pass shared/events.js's validateModifiers/validateLadder, so every
// modifier `value` is authored within its TUNABLES [min, max] range
// (shared/configSchema.js) and every ladder's per-metric targets strictly
// increase. `recurrence` is annual: {month (1-indexed), day, durationDays} -
// Task 4's scheduler materializes these into concrete starts_at/ends_at
// windows; the seeded rows themselves carry no window (status 'draft').

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
      { metric: 'wafersEarned', target: 500, reward: { wafers: 20 } },
      { metric: 'flopsEarned', target: 5000, reward: { flops: 2000 } },
      { metric: 'minigamesWon', target: 3, reward: { wafers: 15 } },
      { metric: 'tapesEarned', target: 50, reward: { tapes: 10 } },
      { metric: 'blocksClaimed', target: 5, reward: { wafers: 25 } },
      { metric: 'wafersEarned', target: 1500, reward: { wafers: 40 } },
      { metric: 'flopsEarned', target: 20000, reward: { flops: 8000 } },
      { metric: 'minigamesWon', target: 8, reward: { wafers: 35 } },
      { metric: 'tapesEarned', target: 150, reward: { tapes: 30 } },
      { metric: 'blocksClaimed', target: 15, reward: { wafers: 75, tapes: 20, flops: 5000 } },
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
      { metric: 'minigamesWon', target: 5, reward: { wafers: 15 } },
      { metric: 'tapesEarned', target: 30, reward: { tapes: 8 } },
      { metric: 'wafersEarned', target: 300, reward: { wafers: 20 } },
      { metric: 'blocksClaimed', target: 3, reward: { wafers: 15 } },
      { metric: 'flopsEarned', target: 3000, reward: { flops: 1500 } },
      { metric: 'minigamesWon', target: 15, reward: { wafers: 40 } },
      { metric: 'tapesEarned', target: 90, reward: { tapes: 20 } },
      { metric: 'wafersEarned', target: 900, reward: { wafers: 45 } },
      { metric: 'blocksClaimed', target: 9, reward: { tapes: 35 } },
      { metric: 'flopsEarned', target: 12000, reward: { flops: 6000, wafers: 60 } },
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
      { metric: 'flopsEarned', target: 4000, reward: { flops: 2500 } },
      { metric: 'wafersEarned', target: 400, reward: { wafers: 25 } },
      { metric: 'tapesEarned', target: 40, reward: { tapes: 15 } },
      { metric: 'blocksClaimed', target: 4, reward: { wafers: 20 } },
      { metric: 'minigamesWon', target: 4, reward: { wafers: 20 } },
      { metric: 'flopsEarned', target: 12000, reward: { flops: 8000 } },
      { metric: 'wafersEarned', target: 1200, reward: { wafers: 60 } },
      { metric: 'tapesEarned', target: 120, reward: { tapes: 45 } },
      { metric: 'blocksClaimed', target: 12, reward: { tapes: 60 } },
      { metric: 'minigamesWon', target: 12, reward: { wafers: 50, tapes: 30, flops: 5000 } },
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
      { metric: 'blocksClaimed', target: 8, reward: { wafers: 20 } },
      { metric: 'tapesEarned', target: 80, reward: { tapes: 20 } },
      { metric: 'wafersEarned', target: 800, reward: { wafers: 30 } },
      { metric: 'flopsEarned', target: 8000, reward: { flops: 3000 } },
      { metric: 'minigamesWon', target: 6, reward: { wafers: 25 } },
      { metric: 'blocksClaimed', target: 24, reward: { tapes: 50 } },
      { metric: 'tapesEarned', target: 240, reward: { tapes: 60 } },
      { metric: 'wafersEarned', target: 2400, reward: { wafers: 80 } },
      { metric: 'flopsEarned', target: 30000, reward: { flops: 12000 } },
      { metric: 'minigamesWon', target: 18, reward: { wafers: 100, tapes: 80, flops: 8000 } },
    ],
    recurrence: { month: 12, day: 20, durationDays: 21 },
  },
];
