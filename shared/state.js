import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS } from './gameData.js';
import { computeMults, tierRate, overclockBoost } from './gameRules.js';
import { TOTAL_BLOCKS } from './coldStorageData.js';
import { computeColdStorageEffects, jobDurationSec } from './coldStorage.js';
import {
  effectiveFactor, pruneExpired, fireDueHazards, activateDueMaintenance,
  overheatOutage, riskOn,
} from './outages.js';

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
      stats: {
        migrates: 0, minigamesWon: 0, singularities: 0, totalWafersEarned: 0, lifetimeFlopsAllTime: 0,
        blocksClaimedLifetime: 0, jobsCompletedLifetime: 0, deepJobsCompletedLifetime: 0,
        tapesEarnedLifetime: 0,
        contractsCompletedLifetime: 0, bestStreak: 0, eventTopRungs: 0, bestLegacyCores: 0,
      },
      // v1.5 Social: the day's three contract TYPE IDS are deliberately not
      // stored - they're re-derived from `dateKey` by shared/contracts.js's
      // dailyContractTypes(), which is what guarantees the client and server
      // agree on them without a sync step. `targets` and `baseline` ARE
      // stored, because both are snapshotted at rollover: recomputing a
      // rate-scaled target on every read would move the goalposts every time
      // the player bought a rack.
      contracts: {
        dateKey: null,
        targets: [0, 0, 0],
        baseline: {},
        claimed: [false, false, false],
      },
      // Pure prestige - no payout, ever (spec §6.3). { [id]: unlockedAtMs }.
      achievements: {},
      streak: { count: 0, lastClaimDate: null },
      // v1.11: prepaid mitigation. Bought with CREDITS (the run currency, so
      // this is a sink for what players have most of) but stored in META, so
      // it survives Migrate - which gives a real reason to spend down before
      // prestiging instead of watching the balance evaporate. hardReset wipes
      // it along with everything else.
      supplies: { antivirus: 0, backupIsp: 0, spareDrives: 0 },
      eventProgress: null,
      // Live Events (v1.4): personal windows that were force-ended early by
      // a NEW event going active (spec §5.2) but whose 48h claim grace
      // (spec §5.3) hasn't run out yet. Force-ending the WINDOW is not the
      // same as destroying the CLAIM RIGHT - eventService.joinEventIfEligible
      // moves the superseded eventProgress here instead of dropping it, and
      // claimEventRung (shared/reducer.js) will still pay out any rung
      // already met at the moment it was superseded. Same record shape as
      // eventProgress; newest first, pruned once past grace.
      pendingEventClaims: [],
      coldStorage: {
        trackStartedAt: Date.now(),
        blocksClaimed: Array(TOTAL_BLOCKS).fill(false),
        trackCycle: 0,
        tapes: 0,
        upgrades: {},
        job: null,
      },
    },
    server: {
      nextAnomalyAt: 0,
      anomalyExpiresAt: 0,
      boost: null,
      lastVentAt: 0,
      gameCooldowns: { rush: 0, debug: 0, match: 0, balance: 0 },
      // v1.11 Risk & Reliability. `outages` IS the shared notion of capacity
      // currently offline - not a concept layered over two systems, but the
      // only representation either has (spec §3). `server` is the right home:
      // it already holds nextAnomalyAt/boost/gameCooldowns, it survives
      // Migrate and Singularity, and hardReset clears it wholesale.
      outages: [],
      nextHazardAt: 0,
      gridMaintenance: null,
    },
  };
}

// v1.11: an outage reaching evaluate() with a non-numeric startAt/endAt/factor
// would poison the integral into NaN and silently zero a player's income for
// the rest of the save's life. Validate on the way in, drop what fails.
function isValidOutage(o) {
  return !!o && typeof o === 'object'
    && typeof o.id === 'string'
    && !!o.scope && typeof o.scope === 'object' && typeof o.scope.lane === 'string'
    && Number.isFinite(o.factor) && o.factor >= 0 && o.factor <= 1
    && Number.isFinite(o.startAt) && Number.isFinite(o.endAt)
    && o.endAt > o.startAt;
}

function isValidMaintenance(m) {
  return !!m && typeof m === 'object'
    && Number.isInteger(m.index) && m.index >= 0
    && Number.isFinite(m.startAt) && Number.isFinite(m.endAt)
    && m.endAt > m.startAt;
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
    // v1.4: added after eventProgress shipped, so pre-existing saves have no
    // such key - the base.meta spread above already defaults it, but pin the
    // ARRAY-ness explicitly here too. Every consumer (claimEventRung,
    // joinEventIfEligible, stateService's __pendingClaimables resolution)
    // iterates it, and a corrupt/hand-edited save carrying a non-array must
    // not reach them.
    pendingEventClaims: Array.isArray(srcMeta.pendingEventClaims) ? srcMeta.pendingEventClaims : [],
  };

  const srcCS = srcMeta.coldStorage || {};
  const padBoolArray = (arr, len, fill) => {
    const list = Array.isArray(arr) ? arr.slice(0, len) : [];
    while (list.length < len) list.push(fill);
    return list;
  };
  meta.coldStorage = {
    ...base.meta.coldStorage,
    ...srcCS,
    blocksClaimed: padBoolArray(srcCS.blocksClaimed, TOTAL_BLOCKS, false),
    upgrades: { ...base.meta.coldStorage.upgrades, ...(srcCS.upgrades || {}) },
  };

  // v1.5: every field below is defaulted AND shape-checked. A corrupt or
  // hand-edited save must never hand a non-array to claimContract's
  // validIndex path, or a non-object to the baseline lookup - same reasoning
  // as pendingEventClaims' explicit array pinning above.
  const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const srcContracts = isPlainObject(srcMeta.contracts) ? srcMeta.contracts : {};
  const padTo3 = (arr, fill) => {
    const list = Array.isArray(arr) ? arr.slice(0, 3) : [];
    while (list.length < 3) list.push(fill);
    return list;
  };
  meta.contracts = {
    dateKey: typeof srcContracts.dateKey === 'string' ? srcContracts.dateKey : null,
    targets: padTo3(srcContracts.targets, 0)
      .map((n) => (typeof n === 'number' && Number.isFinite(n) ? n : 0)),
    baseline: isPlainObject(srcContracts.baseline) ? { ...srcContracts.baseline } : {},
    claimed: padTo3(srcContracts.claimed, false).map((b) => b === true),
  };
  meta.achievements = isPlainObject(srcMeta.achievements) ? { ...srcMeta.achievements } : {};
  const srcStreak = isPlainObject(srcMeta.streak) ? srcMeta.streak : {};
  meta.streak = {
    count: typeof srcStreak.count === 'number' && Number.isFinite(srcStreak.count) ? srcStreak.count : 0,
    lastClaimDate: typeof srcStreak.lastClaimDate === 'string' ? srcStreak.lastClaimDate : null,
  };

  // v1.11: defaulted AND clamped. Absorption decrements this inside
  // evaluate(), so a negative or non-numeric count would let a hand-edited
  // save absorb hazards forever.
  const srcSupplies = isPlainObject(srcMeta.supplies) ? srcMeta.supplies : {};
  meta.supplies = {};
  for (const id of ['antivirus', 'backupIsp', 'spareDrives']) {
    const v = srcSupplies[id];
    meta.supplies[id] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }

  const server = {
    ...base.server,
    ...srcServer,
    gameCooldowns: { ...base.server.gameCooldowns, ...(srcServer.gameCooldowns || {}) },
    // v1.11: shape-pinned, not merely defaulted - same reasoning as
    // pendingEventClaims above. effectiveFactor()/pruneExpired() iterate this
    // on every evaluation, and a corrupt or hand-edited save carrying a
    // non-array (or an outage with a NaN bound) must never reach them.
    outages: Array.isArray(srcServer.outages) ? srcServer.outages.filter(isValidOutage) : [],
    nextHazardAt: typeof srcServer.nextHazardAt === 'number' && Number.isFinite(srcServer.nextHazardAt)
      ? srcServer.nextHazardAt : 0,
    gridMaintenance: isValidMaintenance(srcServer.gridMaintenance) ? srcServer.gridMaintenance : null,
  };

  return { run, meta, server };
}

/**
 * Lazily advances `state` from `lastEvaluatedAt` to `now`. No game loop:
 * this closes the gap analytically, in one shot, whenever the server needs
 * an up-to-date view (a request comes in, a save happens, etc).
 */
export function evaluate(state, config, lastEvaluatedAt, now, rng = Math.random) {
  const s = structuredClone(state);
  const elapsedSec = Math.max(0, (now - lastEvaluatedAt) / 1000);
  recordLegacyCorePeak(s.meta);
  if (elapsedSec < 1) return { state: s, gained: 0 };

  // The overheat flag is a one-shot signal for the client toast: truthy only
  // on the evaluate() call that crossed the heat cap, cleared on every
  // subsequent call regardless of what happens this time.
  delete s.server.overheated;

  // v1.11: outage notices are one-shot client signals with exactly the same
  // lifecycle as `overheated` above - set by the evaluation that produced
  // them, cleared on every subsequent call.
  delete s.server.outageNotices;

  // Fire BEFORE the integral, so an incident that started part-way through
  // this window degrades the part it covered. (Pruning is the mirror image
  // and happens after - see the bottom of this function.) `outages` below is
  // the same array object fireDueHazards pushes into, so the integral sees
  // anything that just fired - do not re-bind or clone it between these.
  activateDueMaintenance(s, config, now);
  const notices = fireDueHazards(s, config, now, rng);
  if (notices.length > 0) s.server.outageNotices = notices;

  const outages = s.server.outages;

  const online = elapsedSec <= config.offline.onlineGapThresholdSec;
  let gained = 0;

  if (online) {
    let boostMult = 1;
    if (s.server.boost && now < s.server.boost.until) {
      boostMult = s.server.boost.mult;
    }
    // computeMults() already folds coldFusionMult into racksMult/gridMult/
    // overclockMult - do not re-multiply it in here (see gameRules.js).
    const { eff, thresholds, racksMult, gridMult, overclockMult } = computeMults(s.meta, config, boostMult);
    const csEff = computeColdStorageEffects(s.meta, config);

    let creditsGain = 0;
    let lifetimeGain = 0;

    // v1.11: the Overclock lane contributes a multiplier to Racks instead of
    // producing directly. The boost is NOT itself degraded by outages -
    // ransomware's { lane: '*' } already covers the Racks lane the boost
    // multiplies, and applying it to both would square the penalty.
    // An active heat cooldown freezes the lane, however it came to be set -
    // NOT gated on the toggle. Under the v1.11 default a cooldown is only ever
    // set by overheatOutage's fallback (shutdown enabled but no owned rack to
    // down), and a cooldown that is set but not honoured would let heat
    // re-cross the cap on every single evaluation. This also matches
    // goalCtx's condition exactly, so the displayed rate and the produced
    // rate cannot disagree.
    const legacyFreeze = !!s.run.heatCooldownUntil && now < s.run.heatCooldownUntil;
    const racksBase = s.run.tiers.reduce((sum, ts, i) => {
      const def = TIER_DEFS[i];
      if (!def || !ts || ts.owned === 0) return sum;
      return sum + tierRate(ts.owned, def.baseProd, racksMult, thresholds);
    }, 0);
    const ocBoost = legacyFreeze
      ? 1
      : overclockBoost(s.run, config, overclockMult, thresholds, racksBase);

    s.run.tiers = s.run.tiers.map((ts, i) => {
      const def = TIER_DEFS[i];
      if (!def || !ts || ts.owned === 0) return ts;
      const factor = effectiveFactor(outages, 'tiers', i, lastEvaluatedAt, now);
      const produced = tierRate(ts.owned, def.baseProd, racksMult, thresholds)
        * elapsedSec * factor * ocBoost;
      lifetimeGain += produced;
      if (ts.manager) { creditsGain += produced; return ts; }
      return { ...ts, ready: (ts.ready || 0) + produced };
    });

    s.run.grid.forEach((g, i) => {
      const def = GRID_DEFS[i];
      if (!def || !g || g.owned === 0) return;
      const factor = effectiveFactor(outages, 'grid', i, lastEvaluatedAt, now);
      const produced = tierRate(g.owned, def.baseProd, gridMult, thresholds) * elapsedSec * factor;
      creditsGain += produced;
      lifetimeGain += produced;
    });

    // v1.11: the Overclock lane no longer produces - its output became the
    // `ocBoost` multiplier applied to Racks above. Heat still accrues here,
    // which is what makes the lane a risk dial rather than free money.
    //
    // The legacy freeze (risk.overheatShutdownEnabled off) still stops heat
    // accrual entirely for the duration of the cooldown, exactly as it did
    // before v1.11.
    if (!legacyFreeze) {
      if (s.run.heatCooldownUntil && now >= s.run.heatCooldownUntil) {
        s.run.heatCooldownUntil = null;
      }
      const heatGain = s.run.overclock.reduce((sum, o, i) => {
        const def = OVERCLOCK_DEFS[i];
        if (!def || !o) return sum;
        return sum + o.owned * def.heatPerSec;
      }, 0) * eff.heatDiscount;
      const netHeat = heatGain - eff.autoVentPerSec;
      const newHeat = Math.max(0, s.run.heat + netHeat * elapsedSec);
      if (newHeat >= config.heat.capacity + csEff.heatCapacityBonus) {
        s.run.heat = 0;
        s.server.overheated = true;
        // The penalty moved from the Overclock lane to the Racks lane, which
        // is coherent now that Overclock multiplies Racks. overheatOutage
        // returns null when the shutdown is disabled (or there is no owned
        // tier to down), in which case fall back to today's lane freeze.
        if (!overheatOutage(s, config, now)) {
          s.run.heatCooldownUntil = now + config.heat.overheatCooldownMs;
        }
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
    // computeMults() already folds coldFusionMult into racksMult/gridMult/
    // overclockMult - do not re-multiply it in here (see gameRules.js).
    const { eff, thresholds, racksMult, gridMult, overclockMult } = computeMults(s.meta, config, 1);
    const csEff = computeColdStorageEffects(s.meta, config);
    const cappedHours = Math.min(eff.offlineCapHours + csEff.offlineCapHoursBonus, config.offline.hardCapHours);
    const cappedSec = Math.min(elapsedSec, cappedHours * 3600);

    if (s.meta.coldStorage && s.meta.coldStorage.job) {
      const durationSec = jobDurationSec(s.meta.coldStorage.job.type, config);
      // durationSec is null for an unrecognized job.type (see coldStorage.js)
      // - skip accrual rather than let Math.min coerce null to 0 and zero
      // out progress on every gap.
      if (durationSec != null) {
        s.meta.coldStorage.job.accruedOfflineSec = Math.min(
          durationSec,
          s.meta.coldStorage.job.accruedOfflineSec + elapsedSec * csEff.offlineJobRateMult,
        );
      }
    }

    let offlineCredits = 0;
    let offlineLifetime = 0;

    // DELIBERATE, AND ODD ON PURPOSE (spec decision 5): the outage factor is
    // computed over the WHOLE absence [lastEvaluatedAt, now] and then applied
    // to the CAPPED payout. An incident covering 2 of 12 absent hours costs
    // 2/12ths of what you were credited, regardless of the cap - the capped
    // window is a representative SAMPLE of the absence, not its first N hours.
    //
    // Do not "fix" this into the literal first-N-hours reading. At roughly one
    // incident per six hours, most incidents would land in unpaid time and
    // cost nothing, which quietly guts the system for exactly the players it
    // should reach most - the ones who are away for a long time. This was
    // considered and explicitly rejected by the owner.
    // v1.11: same conversion as the online branch - Overclock multiplies
    // Racks rather than producing. Heat is untouched offline, as before.
    const racksBaseOffline = s.run.tiers.reduce((sum, ts, i) => {
      const def = TIER_DEFS[i];
      if (!def || !ts || ts.owned === 0) return sum;
      return sum + tierRate(ts.owned, def.baseProd, racksMult, thresholds);
    }, 0);
    const ocBoostOffline = overclockBoost(s.run, config, overclockMult, thresholds, racksBaseOffline);

    s.run.tiers = s.run.tiers.map((ts, i) => {
      const def = TIER_DEFS[i];
      if (!def || !ts || ts.owned === 0) return ts;
      const factor = effectiveFactor(outages, 'tiers', i, lastEvaluatedAt, now);
      const produced = tierRate(ts.owned, def.baseProd, racksMult, thresholds)
        * cappedSec * factor * ocBoostOffline;
      offlineLifetime += produced;
      if (ts.manager) { offlineCredits += produced; return ts; }
      return { ...ts, ready: (ts.ready || 0) + produced };
    });

    s.run.grid.forEach((g, i) => {
      const def = GRID_DEFS[i];
      if (!def || !g || g.owned === 0) return;
      const factor = effectiveFactor(outages, 'grid', i, lastEvaluatedAt, now);
      const produced = tierRate(g.owned, def.baseProd, gridMult, thresholds) * cappedSec * factor;
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

  // Prune AFTER the integral, never before: an outage that ended part-way
  // through this window still degraded the part it covered, and pruning first
  // would silently pay that time in full.
  s.server.outages = pruneExpired(s.server.outages, now);

  return { state: s, gained };
}

/**
 * Raises meta.stats.bestLegacyCores to the current legacyCores if it is
 * higher. Called from two places, and both are required:
 *
 *  - evaluate(), which makes the stat self-backfilling: an existing save with
 *    no bestLegacyCores is seeded from its current cores on the first
 *    reconcile, so there is no migration.
 *  - singularity(), immediately before it zeroes legacyCores. POST
 *    /api/actions applies a BATCH with no evaluation between actions, so a
 *    Migrate that grants cores followed by a Singularity that spends them
 *    would otherwise destroy the peak before anything observed it.
 */
export function recordLegacyCorePeak(meta) {
  if (!meta || !meta.stats) return;
  const current = typeof meta.legacyCores === 'number' ? meta.legacyCores : 0;
  const best = typeof meta.stats.bestLegacyCores === 'number' ? meta.stats.bestLegacyCores : 0;
  meta.stats.bestLegacyCores = Math.max(best, current);
}
