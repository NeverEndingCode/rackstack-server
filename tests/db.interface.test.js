import { describe, it, expect, afterAll } from 'vitest';
import { provisionDatabase } from './helpers/backend.js';

// Provision before importing the facade: DATABASE_URL/DB_PATH must be set
// before the dynamic import below, since the facade resolves its driver at
// module-evaluation time.
const provisioned = await provisionDatabase();
if (provisioned.backend === 'pg') process.env.DATABASE_URL = provisioned.url;
else process.env.DB_PATH = provisioned.path;

afterAll(async () => {
  const mod = await import('../server/db/index.js');
  if (mod.driver.__backend === 'pg') await mod.driver.__raw.end();
  await provisioned.cleanup();
});

const INTERFACE = [
  'upsertUser', 'getUserById', 'getAllUsersWithSaves', 'getSave', 'putSave',
  'deleteSave', 'getRoles', 'setRoles', 'getToursCompleted', 'setToursCompleted',
  'setUsername', 'dedupeUsernames', 'createMinigameSession', 'getMinigameSession',
  'getOpenMinigameSession', 'finishMinigameSession', 'getConfigRow', 'putConfigRow',
  'getConfigHistory', 'listEvents', 'getEvent', 'getActiveEvent', 'putEvent',
  'setEventStatus', 'deleteEvent', 'upsertParticipation', 'getParticipation',
  'updateParticipationProgress', 'listParticipation', 'setLeaderboardOptOut',
  'listLeaderboard', 'getLatestEventId', 'seedSeasonalEvents',
];

describe('db facade', () => {
  it('exports every interface function', async () => {
    const mod = await import('../server/db/index.js');
    for (const name of INTERFACE) {
      expect(typeof mod[name], `missing export: ${name}`).toBe('function');
    }
  });

  it('every interface function returns a promise', async () => {
    const mod = await import('../server/db/index.js');
    const result = mod.getUserById('nobody');
    expect(typeof result.then).toBe('function');
    await result;
  });
});
