/**
 * The guided-tour registry: metadata ONLY, no step content and no predicates,
 * so server/routes/api.js can import it to validate tour ids without pulling
 * in JSX. Step content and the optional `availableWhen(ctx)` predicate live
 * client-side in client/src/game/data/tours/.
 *
 * Adding a tour in a future release:
 *   1. add its entry here,
 *   2. add its step array + module under client/src/game/data/tours/,
 *   3. register it in that directory's index.js,
 *   4. append its steps into onboarding.js (see the note there - the
 *      onboarding tour must always be a superset of the feature tours).
 * tests/tours.test.js fails if 1 and 3 disagree.
 */
export const ONBOARDING_TOUR_ID = 'onboarding';

export const TOURS = [
  {
    id: ONBOARDING_TOUR_ID,
    label: 'Full tutorial',
    description: 'A guided walk through every part of the rack you have unlocked.',
    autoStart: true,
  },
];

export const TOUR_IDS = TOURS.map((t) => t.id);

export function isValidTourId(id) {
  return typeof id === 'string' && TOUR_IDS.includes(id);
}
