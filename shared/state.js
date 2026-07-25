import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS } from './gameData.js';
import { computeMults, tierRate } from './gameRules.js';

function freshTiers() {
  return TIER_DEFS.map((t) => ({ id: t.id, owned: 0, manager: false, ready: 0 }));
}
function freshGrid() {
  return GRID_DEFS.map((g) => ({ id: g.id, owned: 0 }));
}
function freshOverclock() {
  return OVERCLOCK_DEFS.map((o) => ({ id: o.id, owned: 0 }));
}

export function initialState() {
  return {
    run: {
      credits: 10,
      lifetimeRun: 0,
      tiers: freshTiers(),
      grid: freshGrid(),
      overclock: freshOverclock(),
      heat: 0,
      heatCooldownUntil: null,
    },
    meta: {
      legacyCores: 0, wafers: 0, level: 0, xp: 0,
      goalsCompleted: {}, upgrades: {}, shardUpgrades: {}, repeatable: {},
      singularityShards: 0,
      stats: { migrates: 0, minigamesWon: 0, singularities: 0, totalWafersEarned: 0, lifetimeFlopsAllTime: 0 },
    },
    server: {
      nextAnomalyAt: 0,
      anomalyExpiresAt: 0,
      boost: null,
      lastVentAt: 0,
      gameCooldowns: { rush: 0, debug: 0, match: 0, balance: 0 },
    },
  };
}

/**
 * Lifts a v1.1 `{run, meta}` save (no `server` block, possibly short
 * `tiers`/`grid`/`overclock`, missing stats keys) into the canonical
 * `{run, meta, server}` shape. Idempotent: already-canonical input passes
 * through unchanged (padding/defaulting are no-ops on complete data).
 */
export function migrateSave(raw) {
  const src = structuredClone(raw) || {};
  const base = initialState();
  const srcRun = src.run || {};
  const srcMeta = src.meta || {};
  const srcServer = src.server || {};

  const padArray = (arr, defs, fresh) => {
    const list = Array.isArray(arr) ? arr.slice() : [];
    for (let i = 0; i < defs.length; i++) {
      if (!list[i]) list[i] = fresh[i];
      else list[i] = { ...fresh[i], ...list[i] };
    }
    return list.slice(0, defs.length);
  };

  const run = {
    ...base.run,
    ...srcRun,
    tiers: padArray(srcRun.tiers, TIER_DEFS, base.run.tiers),
    grid: padArray(srcRun.grid, GRID_DEFS, base.run.grid),
    overclock: padArray(srcRun.overclock, OVERCLOCK_DEFS, base.run.overclock),
    heatCooldownUntil: srcRun.heatCooldownUntil ?? null,
  };

  const meta = {
    ...base.meta,
    ...srcMeta,
    goalsCompleted: { ...base.meta.goalsCompleted, ...(srcMeta.goalsCompleted || {}) },
    upgrades: { ...base.meta.upgrades, ...(srcMeta.upgrades || {}) },
    shardUpgrades: { ...base.meta.shardUpgrades, ...(srcMeta.shardUpgrades || {}) },
    repeatable: { ...base.meta.repeatable, ...(srcMeta.repeatable || {}) },
    stats: { ...base.meta.stats, ...(srcMeta.stats || {}) },
  };

  const server = {
    ...base.server,
    ...srcServer,
    gameCooldowns: { ...base.server.gameCooldowns, ...(srcServer.gameCooldowns || {}) },
  };

  return { run, meta, server };
}

/**
 * Lazily advances `state` from `lastEvaluatedAt` to `now`. No game loop:
 * this closes the gap analytically, in one shot, whenever the server needs
 * an up-to-date view (a request comes in, a save happens, etc).
 */
export function evaluate(state, config, lastEvaluatedAt, now) {
  const s = structuredClone(state);
  const elapsedSec = Math.max(0, (now - lastEvaluatedAt) / 1000);
  if (elapsedSec < 1) return { state: s, gained: 0 };

  // The overheat flag is a one-shot signal for the client toast: truthy only
  // on the evaluate() call that crossed the heat cap, cleared on every
  // subsequent call regardless of what happens this time.
  delete s.server.overheated;

  const online = elapsedSec <= config.offline.onlineGapThresholdSec;
  let gained = 0;

  if (online) {
    let boostMult = 1;
    if (s.server.boost && now < s.server.boost.until) {
      boostMult = s.server.boost.mult;
    }
    const { eff, thresholds, racksMult, gridMult, overclockMult } = computeMults(s.meta, config, boostMult);

    let creditsGain = 0;
    let lifetimeGain = 0;

    s.run.tiers = s.run.tiers.map((ts, i) => {
      const def = TIER_DEFS[i];
      if (!def || !ts || ts.owned === 0) return ts;
      const produced = tierRate(ts.owned, def.baseProd, racksMult, thresholds) * elapsedSec;
      lifetimeGain += produced;
      if (ts.manager) { creditsGain += produced; return ts; }
      return { ...ts, ready: (ts.ready || 0) + produced };
    });

    s.run.grid.forEach((g, i) => {
      const def = GRID_DEFS[i];
      if (!def || !g || g.owned === 0) return;
      const produced = tierRate(g.owned, def.baseProd, gridMult, thresholds) * elapsedSec;
      creditsGain += produced;
      lifetimeGain += produced;
    });

    // Overclock lane: frozen entirely (no production, no heat change) while
    // an overheat cooldown from a previous gap is still active.
    const onCooldownNow = !!s.run.heatCooldownUntil && now < s.run.heatCooldownUntil;
    if (onCooldownNow) {
      // leave heat/cooldown as-is; nothing produced this gap on this lane
    } else {
      if (s.run.heatCooldownUntil && now >= s.run.heatCooldownUntil) {
        s.run.heatCooldownUntil = null;
      }
      s.run.overclock.forEach((o, i) => {
        const def = OVERCLOCK_DEFS[i];
        if (!def || !o || o.owned === 0) return;
        const produced = tierRate(o.owned, def.baseProd, overclockMult, thresholds) * elapsedSec;
        creditsGain += produced;
        lifetimeGain += produced;
      });
      const heatGain = s.run.overclock.reduce((sum, o, i) => {
        const def = OVERCLOCK_DEFS[i];
        if (!def || !o) return sum;
        return sum + o.owned * def.heatPerSec;
      }, 0) * eff.heatDiscount;
      const netHeat = heatGain - eff.autoVentPerSec;
      let newHeat = Math.max(0, s.run.heat + netHeat * elapsedSec);
      if (newHeat >= config.heat.capacity) {
        s.run.heat = 0;
        s.run.heatCooldownUntil = now + config.heat.overheatCooldownMs;
        s.server.overheated = true;
      } else {
        s.run.heat = newHeat;
      }
    }

    s.run.credits += creditsGain;
    s.run.lifetimeRun += lifetimeGain;
    s.meta.stats.lifetimeFlopsAllTime += lifetimeGain;
  } else {
    // Offline gap: production capped, heat untouched (v1.1
    // applyOfflineProgress semantics — unmanaged tiers accrue into `ready`,
    // managed tiers + grid + overclock lanes auto-land in credits).
    const { eff, thresholds, racksMult, gridMult, overclockMult } = computeMults(s.meta, config, 1);
    const cappedHours = Math.min(eff.offlineCapHours, config.offline.hardCapHours);
    const cappedSec = Math.min(elapsedSec, cappedHours * 3600);

    let offlineCredits = 0;
    let offlineLifetime = 0;

    s.run.tiers = s.run.tiers.map((ts, i) => {
      const def = TIER_DEFS[i];
      if (!def || !ts || ts.owned === 0) return ts;
      const produced = tierRate(ts.owned, def.baseProd, racksMult, thresholds) * cappedSec;
      offlineLifetime += produced;
      if (ts.manager) { offlineCredits += produced; return ts; }
      return { ...ts, ready: (ts.ready || 0) + produced };
    });

    s.run.grid.forEach((g, i) => {
      const def = GRID_DEFS[i];
      if (!def || !g || g.owned === 0) return;
      const produced = tierRate(g.owned, def.baseProd, gridMult, thresholds) * cappedSec;
      offlineCredits += produced;
      offlineLifetime += produced;
    });

    s.run.overclock.forEach((o, i) => {
      const def = OVERCLOCK_DEFS[i];
      if (!def || !o || o.owned === 0) return;
      const produced = tierRate(o.owned, def.baseProd, overclockMult, thresholds) * cappedSec;
      offlineCredits += produced;
      offlineLifetime += produced;
    });

    if (s.run.heatCooldownUntil && now >= s.run.heatCooldownUntil) {
      s.run.heatCooldownUntil = null;
    }

    s.run.credits += offlineCredits;
    s.run.lifetimeRun += offlineLifetime;
    s.meta.stats.lifetimeFlopsAllTime += offlineLifetime;
    gained = offlineLifetime;
  }

  if (s.server.boost && now >= s.server.boost.until) {
    s.server.boost = null;
  }

  return { state: s, gained };
}
