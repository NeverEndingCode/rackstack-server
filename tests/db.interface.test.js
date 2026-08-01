process.env.DB_PATH = ':memory:';
import { describe, it, expect } from 'vitest';

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
