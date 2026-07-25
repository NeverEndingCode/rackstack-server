import { fmt } from '../helpers.js';

export const GOAL_DEFS = [
  { id: 'g1', desc: 'Own 5 Spare Raspberry Pis', xp: 10, wafers: 2, progress: (ctx) => [ctx.run.tiers[0].owned, 5] },
  { id: 'g2', desc: 'Reach 100 FLOPS/s total output', xp: 15, wafers: 3, progress: (ctx) => [Math.floor(ctx.totalOutputPerSec), 100] },
  { id: 'g3', desc: 'Automate your first rack', xp: 15, wafers: 3, progress: (ctx) => [ctx.run.tiers.some((t) => t.manager) ? 1 : 0, 1] },
  { id: 'g4', desc: 'Own a Home NAS Tower', xp: 12, wafers: 3, progress: (ctx) => [ctx.run.tiers[2].owned >= 1 ? 1 : 0, 1] },
  { id: 'g5', desc: 'Recruit 5 Grid volunteers', xp: 18, wafers: 5, progress: (ctx) => [ctx.run.grid.reduce((s, g) => s + g.owned, 0), 5] },
  { id: 'g6', desc: 'Reach 10K FLOPS/s total output', xp: 25, wafers: 8, progress: (ctx) => [Math.floor(ctx.totalOutputPerSec), 10000] },
  { id: 'g7', desc: 'Hit a x2 milestone on any rack (own 25)', xp: 20, wafers: 6, progress: (ctx) => [ctx.run.tiers.some((t) => t.owned >= 25) ? 1 : 0, 1] },
  { id: 'g8', desc: 'Complete your first Migrate', xp: 30, wafers: 10, progress: (ctx) => [ctx.meta.stats.migrates, 1] },
  { id: 'g9', desc: 'Win a minigame', xp: 15, wafers: 5, progress: (ctx) => [ctx.meta.stats.minigamesWon, 1] },
  { id: 'g10', desc: 'Unlock the Hyperscale Campus', xp: 35, wafers: 12, progress: (ctx) => [ctx.unlockedUpTo >= 7 ? 1 : 0, 1] },
  { id: 'g11', desc: 'Reach 1M FLOPS/s total output', xp: 50, wafers: 18, progress: (ctx) => [Math.floor(ctx.totalOutputPerSec), 1000000] },
  { id: 'g12', desc: 'Own 3 Legacy Cores', xp: 45, wafers: 15, progress: (ctx) => [ctx.meta.legacyCores, 3] },
  { id: 'g13', desc: 'Buy your first Upgrade', xp: 20, wafers: 8, progress: (ctx) => [Object.values(ctx.meta.upgrades).some((l) => l > 0) ? 1 : 0, 1] },
  { id: 'g14', desc: 'Unlock the Quantum Foam Harvester', xp: 80, wafers: 30, progress: (ctx) => [ctx.unlockedUpTo >= 13 ? 1 : 0, 1] },
  { id: 'g15', desc: 'Recruit your first Overclock node', xp: 25, wafers: 8, progress: (ctx) => [ctx.run.overclock.reduce((s, o) => s + o.owned, 0) >= 1 ? 1 : 0, 1] },
  { id: 'g16', desc: 'Trigger your first Singularity', xp: 100, wafers: 40, progress: (ctx) => [ctx.meta.stats.singularities >= 1 ? 1 : 0, 1] },
];

export const REPEATABLE_DEFS = [
  { id: 'r_output', desc: (n) => `Reach ${fmt(n)} FLOPS/s total output`, target: (lvl) => 100 * Math.pow(8, lvl), xp: (lvl) => 15 + lvl * 8, wafers: (lvl) => 4 + lvl * 3, metric: (ctx) => ctx.totalOutputPerSec },
  { id: 'r_racks', desc: (n) => `Own ${n} of any single rack tier`, target: (lvl) => Math.round(10 * Math.pow(1.8, lvl)), xp: (lvl) => 12 + lvl * 6, wafers: (lvl) => 3 + lvl * 2, metric: (ctx) => Math.max(0, ...ctx.run.tiers.map((t) => t.owned)) },
  { id: 'r_grid', desc: (n) => `Recruit ${n} total Grid volunteers`, target: (lvl) => Math.round(10 * Math.pow(1.7, lvl)), xp: (lvl) => 12 + lvl * 6, wafers: (lvl) => 3 + lvl * 2, metric: (ctx) => ctx.run.grid.reduce((s, g) => s + g.owned, 0) },
  { id: 'r_overclock', desc: (n) => `Own ${n} total Overclock nodes`, target: (lvl) => Math.round(5 * Math.pow(1.7, lvl)), xp: (lvl) => 14 + lvl * 7, wafers: (lvl) => 4 + lvl * 2, metric: (ctx) => ctx.run.overclock.reduce((s, o) => s + o.owned, 0) },
  { id: 'r_migrate', desc: (n) => `Complete ${n} total Migrates`, target: (lvl) => lvl + 1, xp: (lvl) => 20 + lvl * 10, wafers: (lvl) => 6 + lvl * 3, metric: (ctx) => ctx.meta.stats.migrates },
  { id: 'r_wafers', desc: (n) => `Earn ${fmt(n)} Wafers lifetime`, target: (lvl) => Math.round(20 * Math.pow(2.2, lvl)), xp: (lvl) => 15 + lvl * 8, wafers: (lvl) => 5 + lvl * 3, metric: (ctx) => ctx.meta.stats.totalWafersEarned },
];
