/*
  Mirrors the numeric formulas in client/src/RackStack.jsx (computeEffects,
  tierRate, milestoneMult, and the offline-catch-up block from the load
  effect). This is the server-authoritative version used to compute
  production while a user was away, capped hard at OFFLINE_CAP_HOURS
  regardless of upgrades.

  IMPORTANT: if you change tier costs/production, upgrade effects, or
  milestone math on the client, mirror the change here too, or offline
  and online production will drift apart.
*/

export const GROWTH = 1.14;
export const MILESTONES = [25, 50, 100, 200, 500, 1000];
export const OFFLINE_CAP_HOURS = 72; // hard ceiling, independent of upgrades

export const TIER_DEFS = [
  { baseCost: 4, baseProd: 0.5 },
  { baseCost: 60, baseProd: 6 },
  { baseCost: 720, baseProd: 45 },
  { baseCost: 8800, baseProd: 320 },
  { baseCost: 110000, baseProd: 2200 },
  { baseCost: 1400000, baseProd: 16000 },
  { baseCost: 20000000, baseProd: 120000 },
  { baseCost: 330000000, baseProd: 900000 },
  { baseCost: 5000000000, baseProd: 7000000 },
  { baseCost: 80000000000, baseProd: 55000000 },
  { baseCost: 1250000000000, baseProd: 430000000 },
  { baseCost: 19000000000000, baseProd: 3300000000 },
  { baseCost: 300000000000000, baseProd: 26000000000 },
  { baseCost: 4600000000000000, baseProd: 200000000000 },
];

export const GRID_DEFS = [
  { baseCost: 50, baseProd: 3 },
  { baseCost: 900, baseProd: 28 },
  { baseCost: 15000, baseProd: 220 },
  { baseCost: 260000, baseProd: 1800 },
  { baseCost: 4500000, baseProd: 15000 },
];

export const OVERCLOCK_DEFS = [
  { baseCost: 300, baseProd: 40 },
  { baseCost: 5500, baseProd: 320 },
  { baseCost: 95000, baseProd: 2600 },
  { baseCost: 1600000, baseProd: 21000 },
  { baseCost: 28000000, baseProd: 170000 },
];

export function milestoneMult(owned, thresholds) {
  let count = 0;
  for (const t of thresholds) if (owned >= t) count++;
  return Math.pow(2, count);
}

export function tierRate(owned, baseProd, mult, thresholds) {
  return owned * baseProd * mult * milestoneMult(owned, thresholds);
}

export function computeEffects(meta) {
  const lv = (meta && meta.upgrades) || {};
  const sv = (meta && meta.shardUpgrades) || {};
  return {
    firmwareMult: 1 + 0.10 * (lv.firmware || 0),
    engineMult: 1 + 0.50 * (sv.engine || 0),
    offlineCapHours: 4 + (lv.uptime || 0),
    gridExtraMult: 1 + 0.25 * (lv.gridamp || 0),
    overclockExtraMult: 1 + 0.25 * (lv.occlock || 0),
    levelBonusMult: 1 + 0.02 * ((meta && meta.level) || 0),
    milestoneDiscount: Math.max(0.3, 1 - 0.10 * (sv.infiniteloop || 0)),
  };
}

/**
 * Advances `run` forward by however much offline time has passed since
 * `lastSave`, capped at OFFLINE_CAP_HOURS. Does not simulate Overclock Bay
 * heat while offline (matches client behavior - heat is left as-saved).
 * Returns { run, gained }.
 */
export function applyOfflineProgress(run, meta, lastSave, now) {
  if (!run || !meta) return { run, gained: 0 };
  const eff = computeEffects(meta);
  const cappedHours = Math.min(eff.offlineCapHours, OFFLINE_CAP_HOURS);
  const offlineCapSec = cappedHours * 3600;
  const elapsedSec = Math.min(Math.max(0, (now - lastSave) / 1000), offlineCapSec);
  if (elapsedSec <= 5) return { run, gained: 0 };

  const thresholds = MILESTONES.map((t) => Math.max(1, Math.round(t * eff.milestoneDiscount)));
  const legacyCores = meta.legacyCores || 0;
  const baseMult = (1 + legacyCores * 0.05) * eff.firmwareMult * eff.engineMult * eff.levelBonusMult;
  const gridMult = baseMult * eff.gridExtraMult;
  const overclockMult = baseMult * eff.overclockExtraMult;

  let offlineCredits = 0;
  let offlineLifetime = 0;

  const tiers = (run.tiers || []).map((ts, i) => {
    const def = TIER_DEFS[i];
    if (!def || !ts || ts.owned === 0) return ts;
    const produced = tierRate(ts.owned, def.baseProd, baseMult, thresholds) * elapsedSec;
    offlineLifetime += produced;
    if (ts.manager) { offlineCredits += produced; return ts; }
    return { ...ts, ready: (ts.ready || 0) + produced };
  });

  (run.grid || []).forEach((g, i) => {
    const def = GRID_DEFS[i];
    if (!def || !g || g.owned === 0) return;
    const produced = tierRate(g.owned, def.baseProd, gridMult, thresholds) * elapsedSec;
    offlineCredits += produced;
    offlineLifetime += produced;
  });

  (run.overclock || []).forEach((o, i) => {
    const def = OVERCLOCK_DEFS[i];
    if (!def || !o || o.owned === 0) return;
    const produced = tierRate(o.owned, def.baseProd, overclockMult, thresholds) * elapsedSec;
    offlineCredits += produced;
    offlineLifetime += produced;
  });

  const newRun = {
    ...run,
    credits: (run.credits || 0) + offlineCredits,
    lifetimeRun: (run.lifetimeRun || 0) + offlineLifetime,
    tiers,
  };
  // offlineLifetime is total production across all three lanes regardless of
  // manager status - the number worth showing the player. offlineCredits is
  // only the subset that auto-landed in spendable balance (manager-run tiers
  // + the always-auto Grid/Overclock lanes); unmanaged tiers' production is
  // sitting in their `ready` pile waiting to be tapped, not "extra" on top.
  return { run: newRun, gained: offlineLifetime };
}
