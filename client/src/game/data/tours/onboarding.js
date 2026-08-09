import {
  welcomeSteps, racksSteps, gridSteps, overclockSteps, upgradesSteps, goalsSteps,
  gamesSteps, coldStorageSteps, socialSteps, singularitySteps, migrateSteps,
  eventSteps, wrapUpSteps, resilienceSteps,
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
    // v1.11: appended per the maintenance obligation above. No separate
    // Resilience tour is registered in CLIENT_TOURS - these steps exist only
    // here, so onboarding remains a strict superset.
    ...resilienceSteps,
    ...socialSteps,
    ...singularitySteps,
    ...migrateSteps,
    ...eventSteps,
    ...wrapUpSteps,
  ],
};
