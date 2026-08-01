import path from 'path';
import { fileURLToPath } from 'url';
import { createSqliteDriver } from './driver.sqlite.js';
import { createPgDriver } from './driver.pg.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'rackstack.db');

// Top-level await: every consumer does `import { getSave } from './db.js'`,
// so the driver must be resolved before this module finishes evaluating.
const driver = process.env.DATABASE_URL
  ? await createPgDriver({ url: process.env.DATABASE_URL })
  : await createSqliteDriver({ path: DB_PATH });

export const {
  upsertUser, getUserById, getAllUsersWithSaves, getSave, putSave, deleteSave,
  getRoles, setRoles, getToursCompleted, setToursCompleted, setUsername,
  dedupeUsernames, createMinigameSession, getMinigameSession,
  getOpenMinigameSession, finishMinigameSession, getConfigRow, putConfigRow,
  getConfigHistory, listEvents, getEvent, getActiveEvent, putEvent,
  setEventStatus, deleteEvent, upsertParticipation, getParticipation,
  updateParticipationProgress, listParticipation, setLeaderboardOptOut,
  listLeaderboard, getLatestEventId, seedSeasonalEvents,
} = driver;

export { driver };
