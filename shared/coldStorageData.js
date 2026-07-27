export const TOTAL_BLOCKS = 16;

export const JOB_TYPES = ['defrag', 'index', 'deep'];
export const JOB_LABELS = { defrag: 'Defrag Run', index: 'Index Rebuild', deep: 'Deep Archive Scrub' };

export const TAPE_UPGRADE_DEFS = [
  { id: 'compression', name: 'Compression Codecs', desc: '+5% tape rewards per level', baseCost: 10, costMult: 1.6, maxLevel: 10 },
  { id: 'robotarm', name: 'Robot Arm', desc: 'Block time -6min per level (floor 4h)', baseCost: 15, costMult: 1.7, maxLevel: 20 },
  { id: 'priorityspinup', name: 'Priority Spin-up', desc: '+10% offline job accrual rate per level', baseCost: 12, costMult: 1.6, maxLevel: 10 },
  { id: 'headstart', name: 'Head Start', desc: 'Reset Track instantly grants 1 pre-claimed block per level', baseCost: 20, costMult: 2.0, maxLevel: 5 },
  { id: 'coldfusion', name: 'Cold Fusion', desc: '+2% global FLOPS output per level', baseCost: 25, costMult: 2.2, maxLevel: 15 },
  { id: 'heatsinktapes', name: 'Heat-Sink Tapes', desc: '+100 heat capacity per level', baseCost: 10, costMult: 1.5, maxLevel: 10 },
  { id: 'deepuptime', name: 'Deep Uptime', desc: '+0.5h offline production cap per level', baseCost: 18, costMult: 1.8, maxLevel: 10 },
];
