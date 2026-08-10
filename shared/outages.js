/**
 * v1.11 Risk & Reliability - the outage model.
 *
 * Every effect in the release is one object:
 *
 *   { id, kind, scope, factor, startAt, endAt, source }
 *
 * "This part of your infrastructure runs at `factor` between `startAt` and
 * `endAt`." Hazards, scheduled Grid maintenance and the overheat shutdown are
 * the same shape with different provenance - there is no separate hazard list
 * and maintenance list to reconcile, which is what lets the UI tell one
 * coherent story about a slowdown (spec §3).
 *
 * Zero runtime dependencies and no imports outside shared/ - this module is
 * consumed identically by the server's authoritative evaluate() and the
 * client's optimistic prediction, which is the whole reason it is pure.
 */

import { GRID_DEFS } from './gameData.js';

/**
 * Lanes an outage may cover. Cold Storage is deliberately ABSENT and must
 * stay absent: it is the safe harbour (spec decision 6), the one lane that
 * never fails, and the reason a player invests in it before a long absence.
 * A `{ lane: '*' }` wildcard covers the three lanes listed here and nothing
 * else - it is not "everything", it is "every ACTIVE lane".
 */
export const OUTAGE_LANES = ['tiers', 'grid', 'overclock'];

export function scopeCovers(scope, lane, index) {
  if (!scope || typeof scope !== 'object') return false;
  if (!OUTAGE_LANES.includes(lane)) return false;   // coldstorage, always
  if (scope.lane === '*') return true;
  if (scope.lane !== lane) return false;
  if (scope.index === undefined || scope.index === null) return true;
  return scope.index === index;
}

/** Outages covering an instant. Half-open: [startAt, endAt). */
export function activeAt(outages, at) {
  if (!Array.isArray(outages)) return [];
  return outages.filter((o) => o && o.startAt <= at && at < o.endAt);
}

/** A new array with finished outages dropped. Never mutates its input. */
export function pruneExpired(outages, now) {
  if (!Array.isArray(outages)) return [];
  return outages.filter((o) => o && o.endAt > now);
}

/**
 * The average output multiplier for one lane index across [from, to).
 *
 * Within a single evaluation window there are NO player actions - the window
 * is by definition the gap between two requests - so the only thing that
 * varies across it is which outages are active, and every outage is a
 * constant factor over an interval. Production is therefore a
 * piecewise-constant integral with a closed form: collect every outage
 * boundary inside the window, and for each resulting sub-interval multiply
 * together the factors of the outages covering it.
 *
 * This is EXACT, not an approximation, and it does not require stepping the
 * simulation - evaluate() stays one multiplication per lane (spec §4). Do not
 * replace it with sampling; tests/outages.test.js cross-checks it against a
 * brute-force integral precisely to pin that down.
 *
 * Overlapping outages MULTIPLY: ransomware (0.5 on everything) during an ISP
 * outage (0 on the Grid) leaves the Grid at 0 and the other lanes at 0.5.
 */
export function effectiveFactor(outages, lane, index, from, to) {
  const span = to - from;
  if (!(span > 0)) return 1;
  if (!Array.isArray(outages) || outages.length === 0) return 1;

  const relevant = outages.filter(
    (o) => o && scopeCovers(o.scope, lane, index) && o.endAt > from && o.startAt < to,
  );
  if (relevant.length === 0) return 1;

  const bounds = new Set([from, to]);
  for (const o of relevant) {
    if (o.startAt > from && o.startAt < to) bounds.add(o.startAt);
    if (o.endAt > from && o.endAt < to) bounds.add(o.endAt);
  }
  const points = [...bounds].sort((a, b) => a - b);

  let weighted = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    // Sample at the midpoint: every boundary is already a split point, so no
    // outage can start or end strictly inside (a, b) and the midpoint's
    // membership is the whole sub-interval's membership.
    const mid = (a + b) / 2;
    let f = 1;
    for (const o of relevant) {
      if (o.startAt <= mid && mid < o.endAt) f *= o.factor;
    }
    weighted += (b - a) * f;
  }
  return weighted / span;
}

/**
 * The single most severe outage covering a lane index right now, or null.
 * For UI copy only - never for math, which must use effectiveFactor's
 * integral over the whole window rather than an instant.
 */
export function laneOutageFor(outages, lane, index, at) {
  let worst = null;
  for (const o of activeAt(outages, at)) {
    if (!scopeCovers(o.scope, lane, index)) continue;
    if (!worst || o.factor < worst.factor) worst = o;
  }
  return worst;
}

// ---------------------------------------------------------------------------
// Hazards: derived, never rolled
// ---------------------------------------------------------------------------

/**
 * A save whose nextHazardAt is far in the past - a clock change, a restored
 * backup, a hand-edited save - must not spin the firing loop for hours of
 * simulated time. This bound is a REQUIREMENT, not a nicety. On hitting it,
 * fireDueHazards jumps nextHazardAt forward to a fresh schedule from `now`.
 */
export const MAX_HAZARDS_PER_EVALUATION = 8;

export const HAZARD_KINDS = ['ransomware', 'ispOutage', 'driveFailure'];

/** Which stockpile absorbs which hazard. */
export const SUPPLY_FOR_KIND = {
  ransomware: 'antivirus',
  ispOutage: 'backupIsp',
  driveFailure: 'spareDrives',
};

export const SUPPLY_IDS = ['antivirus', 'backupIsp', 'spareDrives'];

const SUPPLY_PRICE_KEY = {
  antivirus: 'antivirusPriceSeconds',
  backupIsp: 'backupIspPriceSeconds',
  spareDrives: 'spareDrivesPriceSeconds',
};

/**
 * A supply's credit price, expressed as seconds of the player's current
 * output with a flat floor - the same idiom as social.contractFlopsSeconds
 * and batchQueue.blockFlopsSeconds. A flat price would be a meaningful sink
 * for an hour and free forever after.
 *
 * `totalOutputPerSec` comes from goalCtx and is deliberately the UNDEGRADED
 * rate: pricing off a degraded rate would make supplies cheapest exactly when
 * an incident is running, which inverts the intended pressure.
 */
export function supplyPrice(supplyId, config, totalOutputPerSec) {
  const key = SUPPLY_PRICE_KEY[supplyId];
  if (!key) return Infinity;
  const rate = typeof totalOutputPerSec === 'number' && totalOutputPerSec > 0 ? totalOutputPerSec : 0;
  return Math.max(config.risk.supplyPriceMin, rate * config.risk[key]);
}

/**
 * What it costs to end `outage` right now.
 *
 *   cost = supplyPrice * cureMultiplier * (1 + remaining/total)
 *
 * The trailing factor is in (1, 2], so the cure's FLOOR is `cureMultiplier`
 * times the supply that would have prevented it - strictly worse than
 * preparing, at every remaining duration and every output rate (spec
 * decision 2). If curing is ever cheaper than preparing, the prepaid economy
 * is dead. tests/outages.test.js asserts that as a property across the whole
 * space; if you change this formula, that test is the contract.
 */
export function cureCost(outage, config, totalOutputPerSec, now) {
  const supply = SUPPLY_FOR_KIND[outage.kind];
  if (!supply) return Infinity;
  const total = outage.endAt - outage.startAt;
  const remaining = Math.max(0, outage.endAt - now);
  const share = total > 0 ? remaining / total : 0;
  return supplyPrice(supply, config, totalOutputPerSec) * config.risk.cureMultiplier * (1 + share);
}

const HAZARD_SPECS = {
  ransomware: { enabledKey: 'ransomwareEnabled', factorKey: 'ransomwareFactor', durationKey: 'ransomwareDurationMs' },
  ispOutage: { enabledKey: 'ispOutageEnabled', factorKey: 'ispOutageFactor', durationKey: 'ispOutageDurationMs' },
  driveFailure: { enabledKey: 'driveFailureEnabled', factorKey: 'driveFailureFactor', durationKey: 'driveFailureDurationMs' },
};

/**
 * The master switch ANDed with one source's own switch, master first
 * (spec §8). `risk.enabled` off means the whole system is inert regardless of
 * every other value, so the owner can kill it in one click without auditing
 * six other switches.
 */
export function riskOn(config, sourceKey) {
  const risk = config && config.risk;
  if (!risk || risk.enabled !== true) return false;
  return risk[sourceKey] === true;
}

/**
 * The standing risk rate the UI shows, in incidents per hour. Derived from
 * config - NEVER from server.nextHazardAt, which must not reach the client
 * (spec decision 3: showing it turns the prepaid economy into buying one
 * licence twenty minutes before it fires).
 */
export function hazardRatePerHour(config) {
  const { hazardMinDelayMs, hazardMaxDelayMs } = config.risk;
  const meanMs = (hazardMinDelayMs + hazardMaxDelayMs) / 2;
  if (!(meanMs > 0)) return 0;
  return 3600000 / meanMs;
}

// A small, pure, well-distributed 32-bit integer hash. Both the high and low
// halves of the millisecond timestamp are folded in, so two times 2^32ms
// apart do not collide.
function hash32(n) {
  const v = Math.floor(n);
  let x = (v ^ Math.floor(v / 4294967296)) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}

/**
 * A deterministic [0,1) draw keyed by (scheduledAt, salt). The scheduled time
 * is the ONLY input, so the client and the server derive the same incident
 * without communicating - which is the entire reason hazards are derived
 * rather than rolled (spec §5).
 */
function unitAt(scheduledAt, salt) {
  return hash32(hash32(scheduledAt) ^ Math.imul(salt + 1, 0x9e3779b1)) / 4294967296;
}

/**
 * The hazard scheduled for `scheduledAt`: its kind, target and duration, all
 * derived from that timestamp. Returns null when no kind is available (every
 * kind disabled, or a drive failure with no owned racks to fail).
 *
 * NEVER call Math.random() from here, and never store what this returns as a
 * second source of truth - it is re-derivable by definition, and a stored
 * copy is a copy that can disagree.
 */
export function hazardFrom(scheduledAt, config, state) {
  const kinds = HAZARD_KINDS.filter((k) => config.risk[HAZARD_SPECS[k].enabledKey] === true);
  if (kinds.length === 0) return null;

  const kind = kinds[Math.floor(unitAt(scheduledAt, 0) * kinds.length)];
  const spec = HAZARD_SPECS[kind];
  const factor = config.risk[spec.factorKey];
  const durationMs = config.risk[spec.durationKey];

  let scope;
  if (kind === 'ransomware') {
    scope = { lane: '*' };
  } else if (kind === 'ispOutage') {
    scope = { lane: 'grid' };
  } else {
    // Only an owned rack tier can suffer a drive failure. The victim is
    // derived from the timestamp too - two clients reconciling the same
    // incident must not disagree about which rack died.
    const owned = [];
    for (let i = 0; i < state.run.tiers.length; i++) {
      const t = state.run.tiers[i];
      if (t && t.owned > 0) owned.push(i);
    }
    if (owned.length === 0) return null;
    // v1.12: the TOP owned tier. A random victim was both unpredictable and
    // usually trivial (~1/14 of output); the top tier is legible in the UI
    // ("your Quantum Foam Harvester lost a drive") and actually worth insuring
    // against. `owned` is built in ascending order, so the last entry is the
    // highest tier. Switchable back to the derived-random pick.
    scope = {
      lane: 'tiers',
      index: config.risk.driveFailureTargetsTopTier
        ? owned[owned.length - 1]
        : owned[Math.floor(unitAt(scheduledAt, 1) * owned.length)],
    };
  }

  return {
    id: `hazard:${Math.floor(scheduledAt)}`,
    kind,
    scope,
    factor,
    startAt: scheduledAt,
    endAt: scheduledAt + durationMs,
    source: 'hazard',
  };
}

/**
 * Picks WHEN the next hazard happens. Same shape and testability as
 * scheduleAnomaly (shared/reducer.js): an injected rng, decided once, stored.
 * Both sides then read the stored timestamp and DERIVE what that hazard is.
 *
 * The rng here is safe despite the client running evaluate() too: the next
 * hazard's time is never displayed (decision 3), and the client's whole state
 * is replaced by the authoritative copy on the next reconcile - so a
 * divergent draw is overwritten before anything can observe it. What must NOT
 * diverge is the identity of a hazard that actually fired, and that is
 * derived, not drawn.
 */
export function scheduleNextHazard(server, config, now, rng = Math.random) {
  const { hazardMinDelayMs, hazardMaxDelayMs } = config.risk;
  server.nextHazardAt = now + hazardMinDelayMs + rng() * (hazardMaxDelayMs - hazardMinDelayMs);
}

/**
 * Spends one matching supply to absorb `hazard`, or returns false.
 *
 * This is the ONE place in the release that decrements a stored value, and it
 * is not a violation of decision 1: supplies are a consumable the player
 * bought for exactly this purpose. Nothing here may ever touch credits,
 * wafers, tapes or owned counts.
 */
function absorbWithSupply(state, hazard, notices) {
  const supply = SUPPLY_FOR_KIND[hazard.kind];
  if (!supply) return false;
  const bag = state.meta.supplies;
  if (!bag) return false;
  const stock = typeof bag[supply] === 'number' ? bag[supply] : 0;
  if (stock < 1) return false;

  bag[supply] = stock - 1;
  // A silent save is a wasted save (spec §6): the moment a hedge pays off is
  // the only time the player learns hedging was worth it. This notice is a
  // requirement, not polish - do not drop it to "reduce noise".
  notices.push({
    kind: hazard.kind, absorbed: true, supply,
    remaining: bag[supply], at: hazard.startAt,
  });
  return true;
}

/**
 * Fires every hazard due at or before `now`, mutating `state` in place, and
 * returns the one-shot notices for the client.
 *
 * An anomaly is an OPPORTUNITY the player claims and never fires on its own;
 * a hazard fires unattended. Same scheduling shape, different lifecycle - do
 * not assume scheduleAnomaly's call sites are the right ones to copy.
 */
export function fireDueHazards(state, config, now, rng = Math.random) {
  const server = state.server;
  const notices = [];
  if (!riskOn(config, 'hazardsEnabled')) return notices;

  // A save that has never had one scheduled (fresh, migrated, or hard-reset)
  // gets its first schedule here rather than firing instantly from epoch 0.
  if (!(server.nextHazardAt > 0)) {
    scheduleNextHazard(server, config, now, rng);
    return notices;
  }

  const seen = new Set(server.outages.map((o) => o.id));
  let fired = 0;
  while (server.nextHazardAt <= now && fired < MAX_HAZARDS_PER_EVALUATION) {
    const scheduledAt = server.nextHazardAt;
    const hazard = hazardFrom(scheduledAt, config, state);
    if (hazard && !seen.has(hazard.id)) {
      seen.add(hazard.id);
      if (!absorbWithSupply(state, hazard, notices)) {
        server.outages.push(hazard);
        notices.push({
          kind: hazard.kind, absorbed: false, scope: hazard.scope,
          endAt: hazard.endAt, at: scheduledAt,
        });
      }
    }
    // From the FIRE time, not from `now` - otherwise a long absence produces
    // exactly one hazard however long it was.
    scheduleNextHazard(server, config, scheduledAt, rng);
    fired++;
  }

  // Hit the bound with work still pending: jump forward to a fresh schedule
  // from `now` and move on, rather than spinning.
  if (server.nextHazardAt <= now) scheduleNextHazard(server, config, now, rng);

  return notices;
}

/**
 * Knocks one rack tier offline after a meltdown. Returns the outage, or null
 * when the shutdown is disabled (the caller then falls back to the pre-v1.11
 * Overclock-lane freeze) or there is no owned tier to knock out.
 *
 * The victim is DERIVED from the overheat's timestamp, exactly as a hazard's
 * target is: two clients reconciling the same overheat must not disagree
 * about which rack died.
 *
 * The penalty moved from the Overclock lane to the Racks lane because
 * Overclock now multiplies Racks - running hot risks the very thing it
 * amplifies, and the punishment is self-limiting.
 */
export function overheatOutage(state, config, now) {
  if (!riskOn(config, 'overheatShutdownEnabled')) return null;

  const owned = [];
  for (let i = 0; i < state.run.tiers.length; i++) {
    const t = state.run.tiers[i];
    if (t && t.owned > 0) owned.push(i);
  }
  if (owned.length === 0) return null;

  const index = config.risk.overheatTargetsTopTier
    ? owned[owned.length - 1]
    : owned[Math.floor(unitAt(now, 2) * owned.length)];
  const id = `overheat:${Math.floor(now)}`;
  if (state.server.outages.some((o) => o && o.id === id)) return null;

  const outage = {
    id,
    kind: 'overheat',
    scope: { lane: 'tiers', index },
    factor: 0,
    startAt: now,
    endAt: now + config.risk.overheatOutageMs,
    source: 'overheat',
  };
  state.server.outages.push(outage);
  return outage;
}

// ---------------------------------------------------------------------------
// Grid maintenance: telegraphed, not sprung
// ---------------------------------------------------------------------------

/**
 * Picks the next Grid maintenance window and stores it, VISIBLE, on
 * `server.gridMaintenance`.
 *
 * Called from the server load path only (server/stateService.js), never from
 * evaluate() - exactly the scheduleAnomaly precedent, and for a sharper
 * reason here: this window is DISPLAYED, with a countdown. If the client drew
 * it from its own rng the countdown would jump on every reconcile.
 *
 * Downtime you can route around is planning; downtime you cannot is
 * indistinguishable from the game being broken. That is the whole difference
 * between this and a hazard.
 */
export function scheduleGridMaintenance(server, config, now, rng = Math.random) {
  const { maintenanceMinDelayMs, maintenanceMaxDelayMs, maintenanceDurationMs } = config.risk;
  const startAt = now + maintenanceMinDelayMs
    + rng() * (maintenanceMaxDelayMs - maintenanceMinDelayMs);
  const index = Math.min(GRID_DEFS.length - 1, Math.floor(rng() * GRID_DEFS.length));
  server.gridMaintenance = { index, startAt, endAt: startAt + maintenanceDurationMs };
}

/**
 * Converts a due, already-scheduled window into an outage. Every parameter
 * was fixed when it was scheduled, so there is nothing to derive and this is
 * deterministic on both sides. Returns the outage, or null.
 */
export function activateDueMaintenance(state, config, now) {
  if (!riskOn(config, 'maintenanceEnabled')) return null;
  const gm = state.server.gridMaintenance;
  if (!gm || gm.startAt > now) return null;

  state.server.gridMaintenance = null;    // stateService schedules the next

  // Deliberately NO "gm.endAt <= now, so it is over, skip it" guard. A window
  // that covers the whole evaluation gap ends exactly at `now`, and skipping
  // it would pay the player in full for time they were demonstrably down. An
  // outage genuinely in the past is harmless to push: effectiveFactor ignores
  // anything with endAt <= from, and pruneExpired drops it at the end of this
  // same evaluate(). Let the integral decide, not a guard that cannot see
  // lastEvaluatedAt.
  const id = `maintenance:${Math.floor(gm.startAt)}`;
  if (state.server.outages.some((o) => o && o.id === id)) return null;

  const outage = {
    id,
    kind: 'maintenance',
    scope: { lane: 'grid', index: gm.index },
    factor: 0,
    startAt: gm.startAt,
    endAt: gm.endAt,
    source: 'scheduled',
  };
  state.server.outages.push(outage);
  return outage;
}
