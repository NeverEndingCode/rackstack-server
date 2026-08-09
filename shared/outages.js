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
