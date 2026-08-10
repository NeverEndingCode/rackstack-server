export const DEFAULT_CONFIG = {
  schemaVersion: 1,
  // v1.12: venting is slower but passive Auto-Vent is far stronger, so the
  // sustainable Overclock fleet is a real decision instead of "free if you tap,
  // catastrophic if you don't". The per-level rates and the floor are tunables
  // because they were hardcoded in computeEffects and could not be rebalanced
  // without a deploy.
  heat: { capacity: 2000, ventPercent: 35, ventCooldownMs: 15000, overheatCooldownMs: 10000, overheatPopupMs: 15000,
          autoVentPerLevel: 4.0, thermalPerLevel: 0.05, heatsinkPerLevel: 0.15, discountFloor: 0.40 },
  minigames: {
    winCooldownMs: 300000,
    rush:  { durationSec: 10, waferDivisor: 6, maxTapsPerSec: 15 },
    debug: { durationSec: 15, spawnMinMs: 400, spawnMaxMs: 900, maxLit: 3, waferDivisor: 3 },
    match: { durationSec: 40, pairCount: 10, waferPerPair: 2 },
    balance: { durationSec: 12, waferPerPoint: 0.20, safeZoneMin: 35, safeZoneMax: 65, riskZoneWidth: 4,
               pointsSafe: 1, pointsRisk: 5, missPenalty: 2, maxScore: 150 },
  },
  production: { globalMult: 1, racksMult: 1, gridMult: 1, overclockMult: 1,
                levelBonusPerLevel: 0.02, levelBonusMaxLevel: 200 },
  // v1.12 prestige. `coreBonusCap` is load-bearing: it is what turns Singularity
  // from a strict downgrade into the required next step, and it is also what
  // makes a near-linear `migrateExponent` safe (the cap bounds the runaway).
  prestige: {
    migrateDivisor: 2e12,
    migrateExponent: 1.0,
    corePercentPerCore: 0.05,
    coreBonusCap: 400,
    echoPercentPerLevel: 0.05,
    shardsPerCore: 0.4,
  },
  offline: { baseCapHours: 4, capPerUptimeLevel: 1, hardCapHours: 72, onlineGapThresholdSec: 60 },
  // v1.12: rarer and more valuable, with a doubled catch window so the lower
  // frequency isn't a harsher attention tax. The payout magnitudes were
  // hardcoded in claimAnomaly; note boostDuration* is deliberately SEPARATE
  // from the payout and must never be scaled by Signal Boost - that is what
  // made the boost permanent.
  anomaly: { windowMs: 30000, minDelayMs: 420000, maxDelayMs: 900000,
             creditsSecondsMin: 30, creditsSecondsMax: 90,
             boostDurationMinMs: 45000, boostDurationMaxMs: 75000,
             boostMultMin: 1.5, boostMultMax: 3.0 },
  upgrades: { maxLevels: {
    firmware: 20, psu: 10, uptime: 8, signal: 10, gridamp: 15, legacy: 10,
    thermal: 8, autovent: 8, occlock: 15, lucky: 10, deepcache: 10,
    bootstrap: 5, temporal: 5, engine: 12, heatsink: 4, infiniteloop: 5, echocores: 10,
    compression: 10, robotarm: 20, priorityspinup: 10, headstart: 5, coldfusion: 15, heatsinktapes: 10, deepuptime: 10,
  } },
  batchQueue: {
    blockDurationMs: 21600000,        // 6h
    blockBaseTapes: 5,
    blockCycleBonusPct: 0.05,
    blockFlopsIntervalBlocks: 4,      // every 4th block (indices 3,7,11,15) also grants a FLOPS bonus
    blockFlopsSeconds: 120,
    jackpotMultiplier: 5,             // block 16 (index 15) tapes *= this
    jobBaseTapes: 20,
    jobIndexMultiplier: 10,
    jobDeepMultiplier: 36,
    jobDurationDefragMs: 3600000,     // 1h
    jobDurationIndexMs: 28800000,     // 8h
    jobDurationDeepMs: 86400000,      // 24h
  },
  // v1.5 Social & Retention. Every leaf here is admin-tunable via the
  // Balancing tab (which is TUNABLES-driven, so it needs no dashboard change)
  // and overlayable by a live event's modifiers - a "double streak rewards"
  // weekend is an authoring exercise, not a code change.
  social: {
    contractFlopsSeconds: 600,
    contractFlopsMin: 500,
    contractMinigamesTarget: 3,
    contractBlocksTarget: 4,
    contractTapesBase: 15,
    contractTapesPerLevel: 1,
    contractWafersBase: 5,
    contractWafersGrowth: 1.15,
    contractRewardWafers: 6,
    contractRewardTapes: 4,
    contractRewardLevelScalePct: 0.05,
    streakMaxDay: 7,
    streakFlopsSeconds: 300,
    streakWaferBase: 4,
    streakWaferPerDay: 2,
    streakDay7Tapes: 25,
    leaderboardCacheMs: 60000,
    leaderboardLimit: 50,
  },
  // v1.11 Risk & Reliability. Every effect in the release is an "outage"
  // (shared/outages.js); these are its dials. The seven booleans AND together
  // with `enabled` first, so the owner can kill the whole system in one click
  // without auditing the rest - see shared/outages.js's riskOn().
  risk: {
    enabled: true,
    hazardsEnabled: true,
    maintenanceEnabled: true,
    overheatShutdownEnabled: true,
    ransomwareEnabled: true,
    ispOutageEnabled: true,
    driveFailureEnabled: true,

    // v1.12: ~1 incident per 3h (was 6h). Twice as frequent but individually
    // softer, which raises the unmanaged drag from a 1.89% rounding error to
    // ~9.4% and makes every supply clearly EV-positive to buy. The player is
    // shown this RATE, derived from these two numbers - never
    // server.nextHazardAt (spec decision 3).
    hazardMinDelayMs: 7200000,    // 2h
    hazardMaxDelayMs: 14400000,   // 4h

    ransomwareFactor: 0.35,
    ransomwareDurationMs: 2700000,    // 45m, all lanes degraded
    ispOutageFactor: 0,
    ispOutageDurationMs: 2400000,     // 40m, Grid dark
    driveFailureFactor: 0,
    driveFailureDurationMs: 2700000,  // 45m, the TOP rack tier dark

    // Supply prices are expressed in SECONDS OF CURRENT OUTPUT, the same
    // idiom as social.contractFlopsSeconds and batchQueue.blockFlopsSeconds,
    // so a sink priced today still bites at 1e12 FLOPS/s. supplyPriceMin is
    // the floor for a fresh save whose output is ~0.
    // v1.12: sharply cheaper. At the old prices the EV of buying was 1.00x /
    // 0.30x / 0.19x - break-even at best and a straight loss for two of the
    // three - so the rational play was to ignore the whole prepaid economy.
    antivirusPriceSeconds: 500,
    backupIspPriceSeconds: 200,
    spareDrivesPriceSeconds: 250,
    supplyPriceMin: 500,

    // The reactive cure is priced strictly worse than preparing (decision 2):
    // cost = supplyPrice * cureMultiplier * (1 + remaining/total), so its
    // FLOOR is cureMultiplier times the supply it should have been.
    cureMultiplier: 2.5,

    maintenanceMinDelayMs: 43200000,  // 12h
    maintenanceMaxDelayMs: 86400000,  // 24h
    maintenanceDurationMs: 1800000,   // 30m

    overheatOutageMs: 900000,         // 15m of the top rack tier offline

    // v1.12: a random victim made both the drive failure and the overheat
    // unpredictable AND usually trivial (~1/14 of output). The top owned tier
    // is legible in the UI and actually worth insuring against. Switchable so
    // the old behaviour can be restored from the Balancing tab.
    driveFailureTargetsTopTier: true,
    overheatTargetsTopTier: true,

    // Overclock's conversion factor (spec §7). At 1 the lane contributes
    // exactly the output it used to produce directly, so a mid-game save's
    // total output is unchanged on the deploy - see shared/gameRules.js.
    overclockBoostGain: 1,
  },
};

export const TUNABLES = [
  { path: 'heat.capacity', label: 'Heat capacity', min: 100, max: 100000, integer: true },
  // v1.6: venting is a percentage of effective capacity, not a flat amount,
  // so it isn't diluted by a raised heat.capacity (Summer Surge overlays
  // 4000) or the Cold Storage heatCapacityBonus. 25% of the default 2000
  // capacity is 500 - identical strength to the flat value it replaces.
  { path: 'heat.ventPercent', label: 'Vent amount (% of capacity)', min: 1, max: 100 },
  { path: 'heat.ventCooldownMs', label: 'Vent cooldown (ms)', min: 0, max: 60000, integer: true },
  { path: 'heat.overheatCooldownMs', label: 'Overheat lockout (ms)', min: 0, max: 600000, integer: true },
  { path: 'heat.overheatPopupMs', label: 'Overheat popup duration (ms)', min: 0, max: 600000, integer: true },
  { path: 'minigames.winCooldownMs', label: 'Minigame win cooldown (ms)', min: 0, max: 3600000, integer: true },

  { path: 'minigames.rush.durationSec', label: 'Rush duration (s)', min: 1, max: 600, integer: true },
  { path: 'minigames.rush.waferDivisor', label: 'Rush wafer divisor', min: 1, max: 1000, integer: true },
  { path: 'minigames.rush.maxTapsPerSec', label: 'Rush max taps/sec', min: 1, max: 100, integer: true },

  { path: 'minigames.debug.durationSec', label: 'Debug duration (s)', min: 1, max: 600, integer: true },
  { path: 'minigames.debug.spawnMinMs', label: 'Debug spawn min (ms)', min: 0, max: 3600000, integer: true },
  { path: 'minigames.debug.spawnMaxMs', label: 'Debug spawn max (ms)', min: 0, max: 3600000, integer: true },
  { path: 'minigames.debug.maxLit', label: 'Debug max lit', min: 1, max: 100, integer: true },
  { path: 'minigames.debug.waferDivisor', label: 'Debug wafer divisor', min: 1, max: 1000, integer: true },

  { path: 'minigames.match.durationSec', label: 'Match duration (s)', min: 1, max: 600, integer: true },
  { path: 'minigames.match.pairCount', label: 'Match pair count', min: 1, max: 100, integer: true },
  { path: 'minigames.match.waferPerPair', label: 'Match wafer per pair', min: 1, max: 1000, integer: true },

  { path: 'minigames.balance.durationSec', label: 'Balance duration (s)', min: 1, max: 600, integer: true },
  { path: 'minigames.balance.safeZoneMin', label: 'Balance safe zone min', min: 0, max: 100, integer: true },
  { path: 'minigames.balance.safeZoneMax', label: 'Balance safe zone max', min: 0, max: 100, integer: true },
  { path: 'minigames.balance.riskZoneWidth', label: 'Balance risk zone width', min: 0, max: 100, integer: true },
  { path: 'minigames.balance.pointsSafe', label: 'Balance points (safe)', min: 1, max: 1000, integer: true },
  { path: 'minigames.balance.pointsRisk', label: 'Balance points (risk)', min: 1, max: 1000, integer: true },
  { path: 'minigames.balance.missPenalty', label: 'Balance miss penalty', min: 1, max: 1000, integer: true },
  { path: 'minigames.balance.maxScore', label: 'Balance max score', min: 1, max: 10000, integer: true },

  { path: 'production.globalMult', label: 'Global production multiplier', min: 0.1, max: 100, integer: false },
  { path: 'production.racksMult', label: 'Racks production multiplier', min: 0.1, max: 100, integer: false },
  { path: 'production.gridMult', label: 'Grid production multiplier', min: 0.1, max: 100, integer: false },
  { path: 'production.overclockMult', label: 'Overclock production multiplier', min: 0.1, max: 100, integer: false },

  { path: 'offline.baseCapHours', label: 'Offline base cap (hours)', min: 1, max: 168, integer: false },
  { path: 'offline.capPerUptimeLevel', label: 'Offline cap per uptime level (hours)', min: 1, max: 168, integer: false },
  { path: 'offline.hardCapHours', label: 'Offline hard cap (hours)', min: 1, max: 168, integer: false },
  { path: 'offline.onlineGapThresholdSec', label: 'Online gap threshold (s)', min: 10, max: 600, integer: true },

  { path: 'anomaly.windowMs', label: 'Anomaly window (ms)', min: 1000, max: 3600000, integer: true },
  { path: 'anomaly.minDelayMs', label: 'Anomaly min delay (ms)', min: 1000, max: 3600000, integer: true },
  { path: 'anomaly.maxDelayMs', label: 'Anomaly max delay (ms)', min: 1000, max: 3600000, integer: true },

  { path: 'upgrades.maxLevels.firmware', label: 'Max level: Overclocked Firmware', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.psu', label: 'Max level: Redundant PSUs', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.uptime', label: 'Max level: Extended Uptime', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.signal', label: 'Max level: Signal Boost', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.gridamp', label: 'Max level: Grid Amplifier', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.legacy', label: 'Max level: Legacy Insight', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.thermal', label: 'Max level: Thermal Regulators', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.autovent', label: 'Max level: Auto-Vent System', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.occlock', label: 'Max level: Overclock Amplifier', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.lucky', label: 'Max level: Lucky Silicon', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.deepcache', label: 'Max level: Deep Cache', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.bootstrap', label: 'Max level: Quantum Bootstrap', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.temporal', label: 'Max level: Temporal Compression', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.engine', label: 'Max level: Singularity Engine', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.heatsink', label: 'Max level: Heat Sink Mastery', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.infiniteloop', label: 'Max level: Infinite Loop', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.echocores', label: 'Max level: Echo Cores', min: 1, max: 99, integer: true },

  { path: 'upgrades.maxLevels.compression', label: 'Max level: Compression Codecs', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.robotarm', label: 'Max level: Robot Arm', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.priorityspinup', label: 'Max level: Priority Spin-up', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.headstart', label: 'Max level: Head Start', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.coldfusion', label: 'Max level: Cold Fusion', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.heatsinktapes', label: 'Max level: Heat-Sink Tapes', min: 1, max: 99, integer: true },
  { path: 'upgrades.maxLevels.deepuptime', label: 'Max level: Deep Uptime', min: 1, max: 99, integer: true },

  { path: 'batchQueue.blockDurationMs', label: 'Block duration (ms)', min: 60000, max: 86400000, integer: true },
  { path: 'batchQueue.blockBaseTapes', label: 'Block base tapes', min: 1, max: 10000, integer: true },
  { path: 'batchQueue.blockCycleBonusPct', label: 'Block cycle bonus (%)', min: 0, max: 5, integer: false },
  { path: 'batchQueue.blockFlopsIntervalBlocks', label: 'Block FLOPS bonus interval', min: 1, max: 16, integer: true },
  { path: 'batchQueue.blockFlopsSeconds', label: 'Block FLOPS bonus (seconds of output)', min: 0, max: 3600, integer: true },
  { path: 'batchQueue.jackpotMultiplier', label: 'Jackpot (final block) multiplier', min: 1, max: 100, integer: false },
  { path: 'batchQueue.jobBaseTapes', label: 'Job base tapes (1h)', min: 1, max: 100000, integer: true },
  { path: 'batchQueue.jobIndexMultiplier', label: 'Job multiplier (8h)', min: 1, max: 1000, integer: false },
  { path: 'batchQueue.jobDeepMultiplier', label: 'Job multiplier (24h)', min: 1, max: 1000, integer: false },
  { path: 'batchQueue.jobDurationDefragMs', label: 'Job duration: Defrag Run (ms)', min: 60000, max: 604800000, integer: true },
  { path: 'batchQueue.jobDurationIndexMs', label: 'Job duration: Index Rebuild (ms)', min: 60000, max: 604800000, integer: true },
  { path: 'batchQueue.jobDurationDeepMs', label: 'Job duration: Deep Archive Scrub (ms)', min: 60000, max: 604800000, integer: true },

  { path: 'social.contractFlopsSeconds', label: 'Contract FLOPS target (seconds of output)', min: 1, max: 86400, integer: true },
  // A floor, never a cap: a player at zero output (a fresh save, or the
  // instant after a Migrate) would otherwise get a target of 0, which is
  // already met, and the contract would auto-complete for free. Set this to 0
  // to deliberately restore that behaviour.
  { path: 'social.contractFlopsMin', label: 'Contract FLOPS target floor', min: 0, max: 1e12, integer: false },
  { path: 'social.contractMinigamesTarget', label: 'Contract target: minigames won', min: 1, max: 100, integer: true },
  { path: 'social.contractBlocksTarget', label: 'Contract target: blocks claimed', min: 1, max: 100, integer: true },
  { path: 'social.contractTapesBase', label: 'Contract target: tapes base', min: 1, max: 10000, integer: true },
  { path: 'social.contractTapesPerLevel', label: 'Contract target: tapes per level', min: 0, max: 1000, integer: false },
  { path: 'social.contractWafersBase', label: 'Contract target: wafers base', min: 1, max: 10000, integer: true },
  { path: 'social.contractWafersGrowth', label: 'Contract target: wafers growth per level', min: 1, max: 3, integer: false },
  { path: 'social.contractRewardWafers', label: 'Contract reward: wafers', min: 0, max: 10000, integer: true },
  { path: 'social.contractRewardTapes', label: 'Contract reward: tapes', min: 0, max: 10000, integer: true },
  { path: 'social.contractRewardLevelScalePct', label: 'Contract reward scaling per level', min: 0, max: 1, integer: false },
  { path: 'social.streakMaxDay', label: 'Streak length (days)', min: 1, max: 30, integer: true },
  { path: 'social.streakFlopsSeconds', label: 'Streak FLOPS reward (seconds of output)', min: 0, max: 86400, integer: true },
  { path: 'social.streakWaferBase', label: 'Streak wafer reward base', min: 0, max: 10000, integer: true },
  { path: 'social.streakWaferPerDay', label: 'Streak wafer reward per day', min: 0, max: 1000, integer: true },
  { path: 'social.streakDay7Tapes', label: 'Streak final-day tape reward', min: 0, max: 10000, integer: true },
  { path: 'social.leaderboardCacheMs', label: 'Leaderboard cache TTL (ms)', min: 0, max: 3600000, integer: true },
  { path: 'social.leaderboardLimit', label: 'Leaderboard rows per board', min: 1, max: 500, integer: true },

  // v1.11 Risk & Reliability. `type: 'boolean'` rows carry no min/max - the
  // type is the range. Encoding these as 0/1 numbers was explicitly rejected:
  // a 0/1 "boolean" is exactly the kind of thing that later gets set to 2.
  { path: 'risk.enabled', label: 'Risk system enabled (master)', type: 'boolean' },
  { path: 'risk.hazardsEnabled', label: 'Hazards enabled', type: 'boolean' },
  { path: 'risk.maintenanceEnabled', label: 'Grid maintenance enabled', type: 'boolean' },
  { path: 'risk.overheatShutdownEnabled', label: 'Overheat knocks a rack offline', type: 'boolean' },
  { path: 'risk.ransomwareEnabled', label: 'Hazard enabled: Ransomware', type: 'boolean' },
  { path: 'risk.ispOutageEnabled', label: 'Hazard enabled: ISP outage', type: 'boolean' },
  { path: 'risk.driveFailureEnabled', label: 'Hazard enabled: Drive failure', type: 'boolean' },

  { path: 'risk.hazardMinDelayMs', label: 'Hazard min delay (ms)', min: 60000, max: 604800000, integer: true },
  { path: 'risk.hazardMaxDelayMs', label: 'Hazard max delay (ms)', min: 60000, max: 604800000, integer: true },
  { path: 'risk.ransomwareFactor', label: 'Ransomware output factor', min: 0, max: 1, integer: false },
  { path: 'risk.ransomwareDurationMs', label: 'Ransomware duration (ms)', min: 1000, max: 86400000, integer: true },
  { path: 'risk.ispOutageFactor', label: 'ISP outage output factor', min: 0, max: 1, integer: false },
  { path: 'risk.ispOutageDurationMs', label: 'ISP outage duration (ms)', min: 1000, max: 86400000, integer: true },
  { path: 'risk.driveFailureFactor', label: 'Drive failure output factor', min: 0, max: 1, integer: false },
  { path: 'risk.driveFailureDurationMs', label: 'Drive failure duration (ms)', min: 1000, max: 86400000, integer: true },
  { path: 'risk.antivirusPriceSeconds', label: 'Antivirus price (seconds of output)', min: 0, max: 86400, integer: true },
  { path: 'risk.backupIspPriceSeconds', label: 'Backup ISP price (seconds of output)', min: 0, max: 86400, integer: true },
  { path: 'risk.spareDrivesPriceSeconds', label: 'Spare drive price (seconds of output)', min: 0, max: 86400, integer: true },
  { path: 'risk.supplyPriceMin', label: 'Supply price floor (FLOPS)', min: 0, max: 1e12, integer: false },
  { path: 'risk.cureMultiplier', label: 'Cure price multiplier', min: 1, max: 100, integer: false },
  { path: 'risk.maintenanceMinDelayMs', label: 'Maintenance min delay (ms)', min: 60000, max: 604800000, integer: true },
  { path: 'risk.maintenanceMaxDelayMs', label: 'Maintenance max delay (ms)', min: 60000, max: 604800000, integer: true },
  { path: 'risk.maintenanceDurationMs', label: 'Maintenance duration (ms)', min: 1000, max: 86400000, integer: true },
  { path: 'risk.overheatOutageMs', label: 'Overheat rack shutdown (ms)', min: 1000, max: 86400000, integer: true },
  { path: 'risk.overclockBoostGain', label: 'Overclock boost gain', min: 0, max: 100, integer: false },

  // v1.12 Economy Rebalance. The recurring failure this release fixes is that
  // rate curves were tunable while reward MAGNITUDES were hardcoded constants,
  // so every payout system was calibrated for the early game and never
  // rescaled. Every magnitude below used to be a literal in gameRules.js or
  // reducer.js.
  { path: 'risk.driveFailureTargetsTopTier', label: 'Drive failure hits the top tier', type: 'boolean' },
  { path: 'risk.overheatTargetsTopTier', label: 'Overheat hits the top tier', type: 'boolean' },
  { path: 'heat.autoVentPerLevel', label: 'Auto-vent per level (heat/s)', min: 0, max: 100, integer: false },
  { path: 'heat.thermalPerLevel', label: 'Thermal Regulators per level', min: 0, max: 1, integer: false },
  { path: 'heat.heatsinkPerLevel', label: 'Heat Sink Mastery per level', min: 0, max: 1, integer: false },
  { path: 'heat.discountFloor', label: 'Heat generation discount floor', min: 0, max: 1, integer: false },
  { path: 'anomaly.creditsSecondsMin', label: 'Anomaly credits (min seconds of output)', min: 0, max: 3600, integer: false },
  { path: 'anomaly.creditsSecondsMax', label: 'Anomaly credits (max seconds of output)', min: 0, max: 3600, integer: false },
  { path: 'anomaly.boostDurationMinMs', label: 'Anomaly boost duration min (ms)', min: 0, max: 3600000, integer: true },
  { path: 'anomaly.boostDurationMaxMs', label: 'Anomaly boost duration max (ms)', min: 0, max: 3600000, integer: true },
  { path: 'anomaly.boostMultMin', label: 'Anomaly boost multiplier min', min: 1, max: 100, integer: false },
  { path: 'anomaly.boostMultMax', label: 'Anomaly boost multiplier max', min: 1, max: 100, integer: false },
  { path: 'production.levelBonusPerLevel', label: 'Output bonus per account level', min: 0, max: 1, integer: false },
  { path: 'production.levelBonusMaxLevel', label: 'Account level bonus cap (levels)', min: 1, max: 10000, integer: true },
  { path: 'prestige.migrateDivisor', label: 'Migrate: lifetime divisor', min: 1, max: 1e18, integer: false },
  { path: 'prestige.migrateExponent', label: 'Migrate: gain exponent', min: 0.05, max: 2, integer: false },
  { path: 'prestige.corePercentPerCore', label: 'Output per Legacy Core', min: 0, max: 1, integer: false },
  { path: 'prestige.coreBonusCap', label: 'Legacy Core bonus cap (cores)', min: 1, max: 1e9, integer: true },
  { path: 'prestige.echoPercentPerLevel', label: 'Echo Cores: % of Migrate gain per level', min: 0, max: 1, integer: false },
  { path: 'prestige.shardsPerCore', label: 'Singularity: shards per Legacy Core', min: 0, max: 10, integer: false },
  { path: 'minigames.balance.waferPerPoint', label: 'Balance wafers per point', min: 0, max: 100, integer: false },
];

export function getAtPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function setAtPath(obj, path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  let cur = obj;
  for (const k of keys) { if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {}; cur = cur[k]; }
  cur[last] = value;
}

function collectLeafPaths(obj, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'object' && v !== null) out.push(...collectLeafPaths(v, p));
    else out.push(p);
  }
  return out;
}

export function validateConfig(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return { ok: false, errors: ['not an object'] };
  const allowed = new Set(['schemaVersion', ...TUNABLES.map((t) => t.path)]);
  for (const p of collectLeafPaths(doc)) {
    if (!allowed.has(p)) errors.push(`unknown key: ${p}`);
  }
  for (const t of TUNABLES) {
    const v = getAtPath(doc, t.path);
    // v1.11: a boolean tunable accepts ONLY a boolean. Both directions are
    // enforced - a number here, or a boolean on a numeric path below, is a
    // rejection rather than a silent coercion.
    if (t.type === 'boolean') {
      if (typeof v !== 'boolean') errors.push(`${t.path}: missing or not a boolean`);
      continue;
    }
    if (typeof v !== 'number' || Number.isNaN(v)) { errors.push(`${t.path}: missing or not a number`); continue; }
    if (v < t.min || v > t.max) errors.push(`${t.path}: ${v} outside [${t.min}, ${t.max}]`);
    if (t.integer && !Number.isInteger(v)) errors.push(`${t.path}: must be an integer`);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

export function upgradeConfig(doc) {
  const out = structuredClone(DEFAULT_CONFIG);
  for (const t of TUNABLES) {
    const v = getAtPath(doc || {}, t.path);
    if (t.type === 'boolean') {
      if (typeof v === 'boolean') setAtPath(out, t.path, v);
      continue;
    }
    if (typeof v === 'number' && !Number.isNaN(v)) setAtPath(out, t.path, v);
  }
  return out;
}
