// v1.12 rebalance: TIER_DEFS baseCost is derived as
//   baseProd * 10 * 2.50^tier
// so the cost:production ratio grows ~2.5x per tier instead of the old ~1.95x.
// baseProd is deliberately UNCHANGED, which is what keeps goals, contracts,
// achievements and existing saves meaningful.
//
// GROWTH and MILESTONES are unchanged, and that was tested rather than assumed:
// GROWTH 1.16 and 1.20 were both simulated and neither moved pacing, while 1.20
// collapses within-tier depth (efficiency 0.0004 at the 50->100 step), deleting
// milestone play entirely.
export const GROWTH = 1.14;
export const MILESTONES = [25, 50, 100, 200, 500, 1000];

export const TIER_DEFS = [
  { id: 0, name: 'Spare Raspberry Pi', baseCost: 5, baseProd: 0.5, managerCost: 500 },
  { id: 1, name: 'Refurbished Gaming Rig', baseCost: 150, baseProd: 6, managerCost: 6000 },
  { id: 2, name: 'Home NAS Tower', baseCost: 2800, baseProd: 45, managerCost: 70000 },
  { id: 3, name: 'Colo Rack Unit', baseCost: 50000, baseProd: 320, managerCost: 900000 },
  { id: 4, name: 'Server Room', baseCost: 860000, baseProd: 2200, managerCost: 12000000 },
  { id: 5, name: 'Regional Data Center', baseCost: 16000000, baseProd: 16000, managerCost: 170000000 },
  { id: 6, name: 'Cloud Availability Zone', baseCost: 290000000, baseProd: 120000, managerCost: 2400000000 },
  { id: 7, name: 'Hyperscale Campus', baseCost: 5500000000, baseProd: 900000, managerCost: 40000000000 },
  { id: 8, name: 'Orbital Compute Platform', baseCost: 110000000000, baseProd: 7000000, managerCost: 650000000000 },
  { id: 9, name: 'Dyson Swarm Cluster', baseCost: 2100000000000, baseProd: 55000000, managerCost: 10000000000000 },
  { id: 10, name: 'Lunar Compute Colony', baseCost: 41000000000000, baseProd: 430000000, managerCost: 160000000000000 },
  { id: 11, name: 'Interstellar Relay Farm', baseCost: 790000000000000, baseProd: 3300000000, managerCost: 2400000000000000 },
  { id: 12, name: 'Galactic Mesh Network', baseCost: 15000000000000000, baseProd: 26000000000, managerCost: 37000000000000000 },
  { id: 13, name: 'Quantum Foam Harvester', baseCost: 300000000000000000, baseProd: 200000000000, managerCost: 580000000000000000 },
];

export const GRID_DEFS = [
  { id: 0, name: 'Home Volunteer', baseCost: 50, baseProd: 3 },
  { id: 1, name: "Internet Cafe Node", baseCost: 900, baseProd: 28 },
  { id: 2, name: 'University Cluster', baseCost: 15000, baseProd: 220 },
  { id: 3, name: 'Corporate Donor Farm', baseCost: 260000, baseProd: 1800 },
  { id: 4, name: 'Global BOINC Alliance', baseCost: 4500000, baseProd: 15000 },
];

export const OVERCLOCK_DEFS = [
  { id: 0, name: 'Air-Cooled Overclock Rig', baseCost: 300, baseProd: 40, heatPerSec: 0.15 },
  { id: 1, name: 'Liquid-Cooled Blade', baseCost: 5500, baseProd: 320, heatPerSec: 0.22 },
  { id: 2, name: 'Immersion Tank Cluster', baseCost: 95000, baseProd: 2600, heatPerSec: 0.30 },
  { id: 3, name: 'Cryo-Chilled Array', baseCost: 1600000, baseProd: 21000, heatPerSec: 0.40 },
  { id: 4, name: 'Superconducting Core', baseCost: 28000000, baseProd: 170000, heatPerSec: 0.55 },
];

export const UPGRADE_DEFS = [
  { id: 'firmware', name: 'Overclocked Firmware', desc: '+10% output on every lane per level', baseCost: 5, costMult: 1.6, maxLevel: 20 },
  { id: 'psu', name: 'Redundant PSUs', desc: 'Automation costs -4% per level', baseCost: 8, costMult: 1.6, maxLevel: 10 },
  { id: 'uptime', name: 'Extended Uptime', desc: 'Offline earnings cap +1 hour per level', baseCost: 12, costMult: 1.8, maxLevel: 8 },
  { id: 'signal', name: 'Signal Boost', desc: 'Anomaly event rewards +20% per level', baseCost: 6, costMult: 1.5, maxLevel: 10 },
  { id: 'gridamp', name: 'Grid Amplifier', desc: 'Grid lane output +25% per level', baseCost: 10, costMult: 1.6, maxLevel: 15 },
  { id: 'legacy', name: 'Legacy Insight', desc: 'Migrate Legacy Core gain +10% per level', baseCost: 20, costMult: 2.0, maxLevel: 10 },
  { id: 'thermal', name: 'Thermal Regulators', desc: 'Overclock Bay heat generation -5% per level', baseCost: 8, costMult: 1.7, maxLevel: 8 },
  { id: 'autovent', name: 'Auto-Vent System', desc: 'Passively vents 4 heat/sec per level', baseCost: 15, costMult: 1.8, maxLevel: 8 },
  { id: 'occlock', name: 'Overclock Amplifier', desc: '+25% Overclock Bay output per level', baseCost: 12, costMult: 1.6, maxLevel: 15 },
  { id: 'lucky', name: 'Lucky Silicon', desc: 'Minigame wafer rewards +15% per level', baseCost: 6, costMult: 1.5, maxLevel: 10 },
  { id: 'deepcache', name: 'Deep Cache', desc: 'Start each Migrate with +10 Compute Balance per level', baseCost: 4, costMult: 1.4, maxLevel: 10 },
];

export const SINGULARITY_DEFS = [
  { id: 'bootstrap', name: 'Quantum Bootstrap', desc: 'Starting Compute Balance after Migrate x3 per level', baseCost: 3, costMult: 2.2, maxLevel: 5 },
  { id: 'temporal', name: 'Temporal Compression', desc: 'Legacy Core gain from Migrate +25% per level', baseCost: 4, costMult: 2.4, maxLevel: 5 },
  // v1.12: maxLevel 8 -> 12. At 8 levels "tier 13 is reachable" and "the shard
  // tree is still a goal at day 45" are mutually exclusive - every calibration
  // setting that reached tier 13 also maxed the tree. The longer tail decouples
  // them: the x5 that actually powers the late tiers costs ~7% of the tree.
  { id: 'engine', name: 'Singularity Engine', desc: '+50% output on every lane per level', baseCost: 6, costMult: 1.9, maxLevel: 12 },
  { id: 'heatsink', name: 'Heat Sink Mastery', desc: 'Overclock Bay heat generation -15% per level', baseCost: 3, costMult: 2.2, maxLevel: 4 },
  { id: 'infiniteloop', name: 'Infinite Loop', desc: 'Milestone thresholds -10% per level, easier to reach', baseCost: 5, costMult: 2.5, maxLevel: 5 },
  { id: 'echocores', name: 'Echo Cores', desc: 'Migrate grants +5% bonus Legacy Cores per level', baseCost: 4, costMult: 1.8, maxLevel: 10 },
];
