import { describe, it, expect, afterAll } from 'vitest';
import { provisionDatabase } from './helpers/backend.js';

// Provision before importing the facade: DATABASE_URL/DB_PATH must be set
// before the dynamic import below, since the facade resolves its driver at
// module-evaluation time.
const provisioned = await provisionDatabase();

afterAll(async () => {
  const mod = await import('../server/db/index.js');
  if (mod.driver.__backend === 'pg') await mod.driver.__raw.end();
  await provisioned.cleanup();
});

const INTERFACE = [
  'upsertUser', 'getUserById', 'getAllUsersWithSaves', 'getSave', 'putSave',
  'deleteSave', 'getRoles', 'setRoles', 'getToursCompleted', 'setToursCompleted',
  'setUsername', 'dedupeUsernames', 'createMinigameSession', 'getMinigameSession',
  'getOpenMinigameSession', 'finishMinigameSession', 'getMinigameBests',
  'getConfigRow', 'putConfigRow',
  'getConfigHistory', 'listEvents', 'getEvent', 'getActiveEvent', 'putEvent',
  'setEventStatus', 'deleteEvent', 'upsertParticipation', 'getParticipation',
  'updateParticipationProgress', 'listParticipation', 'setLeaderboardOptOut',
  'listLeaderboard', 'getLatestEventId', 'seedSeasonalEvents', 'listIdentities',
  'getIdentity', 'setSupertokensUserId',
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

describe('getMinigameBests', () => {
  it('returns the maximum finished score per game, ignoring unfinished sessions', async () => {
    const {
      upsertUser, createMinigameSession, finishMinigameSession, getMinigameBests,
    } = await import('../server/db/index.js');

    const user = await upsertUser({ provider: 'github', providerId: 'bests-1', username: 'bests', avatarUrl: null });
    const s1 = await createMinigameSession(user.id, 'rush');
    await finishMinigameSession(s1.id, 40);
    const s2 = await createMinigameSession(user.id, 'rush');
    await finishMinigameSession(s2.id, 120);
    await createMinigameSession(user.id, 'rush'); // never finished
    const s4 = await createMinigameSession(user.id, 'debug');
    await finishMinigameSession(s4.id, 7);

    const rows = await getMinigameBests(user.id);
    const byGame = Object.fromEntries(rows.map((r) => [r.game, r.best]));
    expect(byGame.rush).toBe(120);
    expect(byGame.debug).toBe(7);
  });

  it('returns an empty list for a player who has never played', async () => {
    const { upsertUser, getMinigameBests } = await import('../server/db/index.js');

    const user = await upsertUser({ provider: 'github', providerId: 'bests-2', username: 'bests2', avatarUrl: null });
    expect(await getMinigameBests(user.id)).toEqual([]);
  });
});
