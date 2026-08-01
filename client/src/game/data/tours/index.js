import { onboardingTour } from './onboarding.js';

/**
 * Client-side tour registry, keyed by the ids in shared/tours.js.
 * tests/tours.test.js fails if this and TOUR_IDS disagree, so a tour
 * registered in only one of the two places can never silently never fire.
 */
export const CLIENT_TOURS = {
  [onboardingTour.id]: onboardingTour,
};
