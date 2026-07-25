export const UPGRADE_DEFS = [
  { id: 'firmware', name: 'Overclocked Firmware', desc: '+10% output on every lane per level', baseCost: 5, costMult: 1.6, maxLevel: 20 },
  { id: 'psu', name: 'Redundant PSUs', desc: 'Automation costs -4% per level', baseCost: 8, costMult: 1.6, maxLevel: 10 },
  { id: 'uptime', name: 'Extended Uptime', desc: 'Offline earnings cap +1 hour per level', baseCost: 12, costMult: 1.8, maxLevel: 8 },
  { id: 'signal', name: 'Signal Boost', desc: 'Anomaly event rewards +20% per level', baseCost: 6, costMult: 1.5, maxLevel: 10 },
  { id: 'gridamp', name: 'Grid Amplifier', desc: 'Grid lane output +25% per level', baseCost: 10, costMult: 1.6, maxLevel: 15 },
  { id: 'legacy', name: 'Legacy Insight', desc: 'Migrate Legacy Core gain +10% per level', baseCost: 20, costMult: 2.0, maxLevel: 10 },
  { id: 'thermal', name: 'Thermal Regulators', desc: 'Overclock Bay heat generation -8% per level', baseCost: 8, costMult: 1.7, maxLevel: 8 },
  { id: 'autovent', name: 'Auto-Vent System', desc: 'Passively vents 0.5 heat/sec per level', baseCost: 15, costMult: 1.8, maxLevel: 8 },
  { id: 'occlock', name: 'Overclock Amplifier', desc: '+25% Overclock Bay output per level', baseCost: 12, costMult: 1.6, maxLevel: 15 },
  { id: 'lucky', name: 'Lucky Silicon', desc: 'Minigame wafer rewards +15% per level', baseCost: 6, costMult: 1.5, maxLevel: 10 },
  { id: 'deepcache', name: 'Deep Cache', desc: 'Start each Migrate with +10 Compute Balance per level', baseCost: 4, costMult: 1.4, maxLevel: 10 },
];

export const SINGULARITY_DEFS = [
  { id: 'bootstrap', name: 'Quantum Bootstrap', desc: 'Starting Compute Balance after Migrate x10 per level', baseCost: 3, costMult: 2.2, maxLevel: 5 },
  { id: 'temporal', name: 'Temporal Compression', desc: 'Legacy Core gain from Migrate +25% per level', baseCost: 4, costMult: 2.4, maxLevel: 5 },
  { id: 'engine', name: 'Singularity Engine', desc: '+50% output on every lane per level', baseCost: 6, costMult: 2.6, maxLevel: 8 },
  { id: 'heatsink', name: 'Heat Sink Mastery', desc: 'Overclock Bay heat generation -25% per level', baseCost: 3, costMult: 2.2, maxLevel: 4 },
  { id: 'infiniteloop', name: 'Infinite Loop', desc: 'Milestone thresholds -10% per level, easier to reach', baseCost: 5, costMult: 2.5, maxLevel: 5 },
  { id: 'echocores', name: 'Echo Cores', desc: 'Instantly regain 1 free Legacy Core per level after every Migrate', baseCost: 4, costMult: 2.3, maxLevel: 10 },
];
