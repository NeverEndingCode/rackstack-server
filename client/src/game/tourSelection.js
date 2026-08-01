/**
 * Pure tour-selection logic - no DOM, no React, so it is unit-testable on
 * its own. TutorialOverlay.jsx owns everything that touches the document.
 */

/** Steps of `tour` whose visibleWhen(ctx) passes. No predicate means always. */
export function resolveSteps(tour, ctx) {
  if (!tour || !Array.isArray(tour.steps)) return [];
  return tour.steps.filter((s) => (typeof s.visibleWhen === 'function' ? s.visibleWhen(ctx) : true));
}

/**
 * Spec §4.6: the first registered tour that is not completed, is allowed to
 * auto-start, is available in this ctx, and resolves to at least one visible
 * step. Returns { id, steps } or null.
 *
 * `autoStartById` maps tour id -> boolean (from shared/tours.js metadata);
 * a missing entry counts as allowed, which keeps the ad-hoc tours used in
 * tests from needing the metadata table.
 */
export function selectTour(clientTours, tourIds, toursCompleted, ctx, autoStartById = {}) {
  const done = new Set(Array.isArray(toursCompleted) ? toursCompleted : []);
  for (const id of tourIds) {
    if (done.has(id)) continue;
    if (autoStartById[id] === false) continue;
    const tour = clientTours[id];
    if (!tour) continue;
    if (typeof tour.availableWhen === 'function' && !tour.availableWhen(ctx)) continue;
    const steps = resolveSteps(tour, ctx);
    if (steps.length === 0) continue;
    return { id, steps };
  }
  return null;
}
