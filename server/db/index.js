import { createSqliteDriver } from './driver.sqlite.js';
import { createPgDriver } from './driver.pg.js';
import { resolveSqlitePath } from './shared.js';

// Shared with db/migrate.js so the path the migrator reads as its source is
// always the path this facade would have opened. See resolveSqlitePath.
const DB_PATH = resolveSqlitePath(process.env);

// Top-level await: every consumer does `import { getSave } from './db.js'`,
// so the driver must be resolved before this module finishes evaluating.
const driver = process.env.DATABASE_URL
  ? await createPgDriver({ url: process.env.DATABASE_URL })
  : await createSqliteDriver({ path: DB_PATH });

export const {
  upsertUser, getUserById, getAllUsersWithSaves, getSave, putSave, deleteSave,
  getRoles, setRoles, getToursCompleted, setToursCompleted, setUsername,
  dedupeUsernames, createMinigameSession, getMinigameSession,
  getOpenMinigameSession, finishMinigameSession, getMinigameBests, getConfigRow, putConfigRow,
  getConfigHistory, listEvents, getEvent, getActiveEvent, putEvent,
  setEventStatus, deleteEvent, upsertParticipation, getParticipation,
  updateParticipationProgress, listParticipation, setLeaderboardOptOut,
  listLeaderboard, getLatestEventId, seedSeasonalEvents, listIdentities,
  getIdentity, setSupertokensUserId,
} = driver;

export { driver };
