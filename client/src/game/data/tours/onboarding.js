import {
  welcomeSteps, racksSteps, gridSteps, overclockSteps, upgradesSteps, goalsSteps,
  gamesSteps, coldStorageSteps, socialSteps, singularitySteps, migrateSteps,
  eventSteps, wrapUpSteps,
} from './steps.js';
import { ONBOARDING_TOUR_ID } from '../../../../../shared/tours.js';

/**
 * MAINTENANCE OBLIGATION (spec §4.7): completing this tour marks EVERY
 * registered tour complete, which is only correct because this tour is a
 * superset of them. When a future release adds a feature tour, append its
 * step array here too. Nothing in the test suite can catch a violation of
 * this - it is a rule about content, not shape.
 */
export const onboardingTour = {
  id: ONBOARDING_TOUR_ID,
  steps: [
    ...welcomeSteps,
    ...racksSteps,
    ...gridSteps,
    ...overclockSteps,
    ...upgradesSteps,
    ...goalsSteps,
    ...gamesSteps,
    ...coldStorageSteps,
    ...socialSteps,
    ...singularitySteps,
    ...migrateSteps,
    ...eventSteps,
    ...wrapUpSteps,
  ],
};
