import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { SEASONAL_EVENTS } from './data/seasonalEvents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'rackstack.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    username TEXT,
    avatar_url TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(provider, provider_id)
  );

  CREATE TABLE IF NOT EXISTS saves (
    user_id TEXT PRIMARY KEY REFERENCES users(id),
    data TEXT NOT NULL,
    last_save INTEGER NOT NULL
  );
`);

// Guarded ALTERs: SQLite has no "ADD COLUMN IF NOT EXISTS", so on every boot
// we attempt the ALTER and swallow only the "duplicate column name" error
// (the column already exists from a prior boot) - anything else rethrows.
function guardedAddColumn(sql) {
  try {
    db.exec(sql);
  } catch (err) {
    if (!/duplicate column name/i.test(err.message)) throw err;
  }
}

guardedAddColumn("ALTER TABLE users ADD COLUMN roles TEXT DEFAULT '[]'");
guardedAddColumn('ALTER TABLE users ADD COLUMN custom_username INTEGER DEFAULT 0');
// v1.4 Live Events: the opt-out ships here (spec §5.2) and is reused by
// v1.5's global leaderboards - it's a per-user preference, not event-scoped.
guardedAddColumn('ALTER TABLE users ADD COLUMN leaderboard_opt_out INTEGER DEFAULT 0');
// v1.6 tours: a JSON array of completed tour ids (shared/tours.js owns the id
// list). Existing players default to '[]' - an empty completed-set is exactly
// what makes the onboarding tour fire once for them.
guardedAddColumn("ALTER TABLE users ADD COLUMN tours_completed TEXT DEFAULT '[]'");

db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );

  CREATE TABLE IF NOT EXISTS config_history (
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );

  CREATE TABLE IF NOT EXISTS minigame_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    game TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    score INTEGER
  );
`);

// v1.4 Live Events schema (additive). live_events holds both admin-authored
// and seeded (server/data/seasonalEvents.js) events; event_participation
// tracks each user's progress through one event's ladder while it's live.
db.exec(`
  CREATE TABLE IF NOT EXISTS live_events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    theme TEXT,
    modifiers TEXT NOT NULL,
    ladder TEXT NOT NULL,
    status TEXT NOT NULL,
    starts_at INTEGER,
    ends_at INTEGER,
    recurrence TEXT,
    created_at INTEGER NOT NULL,
    created_by TEXT
  );

  CREATE TABLE IF NOT EXISTS event_participation (
    user_id TEXT NOT NULL REFERENCES users(id),
    event_id TEXT NOT NULL REFERENCES live_events(id),
    started_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    rungs_claimed INTEGER NOT NULL DEFAULT 0,
    last_progress_at INTEGER,
    opted_out INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, event_id)
  );
`);

/**
 * Returns a username derived from `desiredName` that `isTaken` reports as
 * free, suffixing `-2`, `-3`, ... until one is. `desiredName` itself is
 * returned unchanged if it's already free. Shared by dedupeUsernames (bulk
 * cleanup, checks an in-memory Set) and upsertUser (per-insert retry,
 * checks the DB) so both use the same suffixing convention against the
 * same COLLATE NOCASE uniqueness rule.
 */
function findAvailableUsername(desiredName, isTaken) {
  if (!isTaken(desiredName)) return desiredName;
  let n = 2;
  let candidate = `${desiredName}-${n}`;
  while (isTaken(candidate)) {
    n += 1;
    candidate = `${desiredName}-${n}`;
  }
  return candidate;
}

// Duplicate usernames (case-insensitively) can exist from before the unique
// index below was introduced. Must run before the CREATE UNIQUE INDEX or
// that statement would fail on any pre-existing collision. No-op when there
// are no duplicates, so it's cheap to run unconditionally on every boot.
function dedupeUsernamesSync() {
  const rows = db.prepare(
    'SELECT id, username, created_at FROM users WHERE username IS NOT NULL ORDER BY created_at ASC, id ASC',
  ).all();
  const taken = new Set();
  for (const row of rows) {
    const lower = row.username.toLowerCase();
    if (!taken.has(lower)) {
      taken.add(lower);
      continue;
    }
    const candidate = findAvailableUsername(row.username, (name) => taken.has(name.toLowerCase()));
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(candidate, row.id);
    taken.add(candidate.toLowerCase());
  }
}

// Transitional: module init still needs this to run synchronously before the
// unique index below is created. The exported async wrapper is what callers
// (Task 2 moves this into schema init properly) will use going forward.
export async function dedupeUsernames() {
  return dedupeUsernamesSync();
}

dedupeUsernamesSync();

db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE)');

function isUsernameTakenInDb(name) {
  return !!db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(name);
}

// Same check as isUsernameTakenInDb, but excludes the given user's own row -
// used by upsertUser's UPDATE (returning-user) path, where the row being
// updated already "has" the old username and must not be treated as its own
// collision.
function isUsernameTakenByOtherUser(name, excludeId) {
  return !!db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?').get(name, excludeId);
}

const insertUserStmt = db.prepare(`
  INSERT INTO users (id, provider, provider_id, username, avatar_url, created_at)
  VALUES (@id, @provider, @provider_id, @username, @avatar_url, @created_at)
`);

export async function upsertUser({ provider, providerId, username, avatarUrl }) {
  const id = `${provider}:${providerId}`;
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (existing) {
    // A user who has set a custom username keeps it on re-login; only the
    // avatar (which the user doesn't control) is refreshed from the profile.
    const desiredUsername = existing.custom_username ? existing.username : username;
    let nextUsername = desiredUsername;
    try {
      db.prepare('UPDATE users SET username = ?, avatar_url = ? WHERE id = ?').run(nextUsername, avatarUrl, id);
    } catch (e) {
      // The provider-supplied name can change between logins (e.g. the user
      // renamed their display name on the OAuth provider) and collide
      // case-insensitively with a DIFFERENT user's username. Without this
      // catch, that error would propagate to a 500 and - since upsertUser
      // runs on every login - permanently lock the account out until the
      // provider-side name changed back. Same suffixing convention/helper as
      // the INSERT path, excluding this user's own row from the collision
      // check (their old value isn't a collision against their new one).
      if (e.code !== 'SQLITE_CONSTRAINT_UNIQUE' && e.code !== 'SQLITE_CONSTRAINT') throw e;
      nextUsername = findAvailableUsername(desiredUsername, (name) => isUsernameTakenByOtherUser(name, id));
      db.prepare('UPDATE users SET username = ?, avatar_url = ? WHERE id = ?').run(nextUsername, avatarUrl, id);
    }
    return { ...existing, username: nextUsername, avatar_url: avatarUrl };
  }

  const user = {
    id, provider, provider_id: providerId, username, avatar_url: avatarUrl, created_at: Date.now(),
  };
  try {
    insertUserStmt.run(user);
  } catch (e) {
    // Two different brand-new OAuth accounts can independently supply the
    // same (or case-variant) username - the COLLATE NOCASE unique index
    // rejects the second insert with SQLITE_CONSTRAINT_UNIQUE. Without this
    // catch, that error would propagate to a 500 and - since upsertUser
    // runs on every login, not just the first - permanently block that
    // account from ever logging in. Pick a free variant using the same
    // suffixing convention as dedupeUsernames and retry once.
    if (e.code !== 'SQLITE_CONSTRAINT_UNIQUE' && e.code !== 'SQLITE_CONSTRAINT') throw e;
    user.username = findAvailableUsername(username, isUsernameTakenInDb);
    insertUserStmt.run(user);
  }
  return user;
}

export async function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

export async function getAllUsersWithSaves() {
  return db.prepare(`
    SELECT u.id, u.provider, u.username, u.avatar_url, u.created_at,
           u.leaderboard_opt_out,
           s.data, s.last_save
    FROM users u
    LEFT JOIN saves s ON s.user_id = u.id
    ORDER BY u.created_at DESC
  `).all();
}

export async function getSave(userId) {
  return db.prepare('SELECT * FROM saves WHERE user_id = ?').get(userId);
}

export async function putSave(userId, data, lastSave) {
  db.prepare(`
    INSERT INTO saves (user_id, data, last_save) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, last_save = excluded.last_save
  `).run(userId, JSON.stringify(data), lastSave);
}

export async function deleteSave(userId) {
  db.prepare('DELETE FROM saves WHERE user_id = ?').run(userId);
}

/**
 * Roles are stored as a JSON array string in users.roles (default '[]').
 * Membership in the array is the only thing that matters - ordering and
 * duplicates are not deduped here; callers (server/auth.js, Task 8) treat
 * this as a plain set.
 */
export async function getRoles(userId) {
  const row = db.prepare('SELECT roles FROM users WHERE id = ?').get(userId);
  if (!row || !row.roles) return [];
  try {
    return JSON.parse(row.roles);
  } catch (e) {
    return [];
  }
}

export async function setRoles(userId, roles) {
  db.prepare('UPDATE users SET roles = ? WHERE id = ?').run(JSON.stringify(roles), userId);
}

/**
 * Completed guided tours, stored as a JSON array string in
 * users.tours_completed (default '[]') - the same shape and defensive-read
 * contract as users.roles above. Callers treat it as a plain set; the route
 * layer owns validation against shared/tours.js.
 */
export async function getToursCompleted(userId) {
  const row = db.prepare('SELECT tours_completed FROM users WHERE id = ?').get(userId);
  if (!row || !row.tours_completed) return [];
  try {
    const parsed = JSON.parse(row.tours_completed);
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
  } catch (e) {
    return [];
  }
}

export async function setToursCompleted(userId, ids) {
  db.prepare('UPDATE users SET tours_completed = ? WHERE id = ?').run(JSON.stringify(ids), userId);
}

/**
 * Sets a user's username, format-agnostic (the route layer owns the regex).
 * Performs its own case-insensitive availability check excluding the user
 * themself, and marks the username as user-chosen so upsertUser stops
 * overwriting it from the OAuth profile on future logins.
 */
export async function setUsername(userId, name) {
  const collision = db.prepare(
    'SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?',
  ).get(name, userId);
  if (collision) return { ok: false, error: 'taken' };
  db.prepare('UPDATE users SET username = ?, custom_username = 1 WHERE id = ?').run(name, userId);
  return { ok: true };
}

export async function createMinigameSession(userId, game) {
  const session = {
    id: randomUUID(),
    user_id: userId,
    game,
    started_at: Date.now(),
    finished_at: null,
    score: null,
  };
  db.prepare(`
    INSERT INTO minigame_sessions (id, user_id, game, started_at, finished_at, score)
    VALUES (@id, @user_id, @game, @started_at, @finished_at, @score)
  `).run(session);
  return session;
}

export async function getMinigameSession(id) {
  return db.prepare('SELECT * FROM minigame_sessions WHERE id = ?').get(id);
}

/**
 * Finds the most recent still-open (unfinished, not yet expired) session
 * for `userId`+`game`, if any. "Not yet expired" is caller-supplied as
 * `minStartedAt` (a session's `started_at` must be >= this to count) since
 * the expiry window depends on `config.minigames[game].durationSec`, which
 * this module doesn't have access to - the route layer computes it.
 * Used to block a burst of concurrently-open sessions for the same game
 * (each of which would otherwise dodge the win cooldown independently).
 */
export async function getOpenMinigameSession(userId, game, minStartedAt) {
  return db.prepare(`
    SELECT * FROM minigame_sessions
    WHERE user_id = ? AND game = ? AND finished_at IS NULL AND started_at >= ?
    ORDER BY started_at DESC LIMIT 1
  `).get(userId, game, minStartedAt);
}

export async function finishMinigameSession(id, score) {
  db.prepare('UPDATE minigame_sessions SET finished_at = ?, score = ? WHERE id = ?').run(Date.now(), score, id);
}

/**
 * Returns the singleton config row (id=1): { id, version, data, updated_at,
 * updated_by }, or undefined if no config has been seeded yet. `data` is
 * returned as the raw JSON text exactly as stored - mirroring getSave's
 * convention, callers JSON.parse it themselves.
 */
export async function getConfigRow() {
  return db.prepare('SELECT * FROM config WHERE id = 1').get();
}

/**
 * Upserts the singleton config row (id=1) to `{ version, data, userId }`
 * and appends a matching row to config_history for audit/rollback. `data`
 * is a plain JS object; it is JSON.stringify'd here (the same convention
 * putSave uses) - callers never pass pre-stringified JSON.
 */
export async function putConfigRow(version, data, userId) {
  const text = JSON.stringify(data);
  const now = Date.now();
  db.prepare(`
    INSERT INTO config (id, version, data, updated_at, updated_by) VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET version = excluded.version, data = excluded.data,
      updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `).run(version, text, now, userId);
  db.prepare(`
    INSERT INTO config_history (version, data, updated_at, updated_by) VALUES (?, ?, ?, ?)
  `).run(version, text, now, userId);
}

export async function getConfigHistory() {
  return db.prepare('SELECT * FROM config_history ORDER BY rowid DESC').all();
}

// --- Live Events (v1.4) -----------------------------------------------
//
// Unlike getSave/getConfigRow (which hand back their JSON columns as raw
// text and let the caller JSON.parse), the event getters below parse
// `theme`, `modifiers`, `ladder`, and `recurrence` before returning. That's
// a deliberate departure from the rest of this module's convention: every
// caller of these getters (route layer, scheduler, reducer-side effective
// config merge) needs the structured value, never the raw text, so parsing
// once here avoids repeating (and re-risking) JSON.parse at every call site.

function parseEventRow(row) {
  if (!row) return row;
  return {
    ...row,
    theme: JSON.parse(row.theme ?? 'null'),
    modifiers: JSON.parse(row.modifiers),
    ladder: JSON.parse(row.ladder),
    recurrence: JSON.parse(row.recurrence ?? 'null'),
  };
}

export async function listEvents() {
  return db.prepare('SELECT * FROM live_events ORDER BY created_at ASC').all().map(parseEventRow);
}

export async function getEvent(id) {
  return parseEventRow(db.prepare('SELECT * FROM live_events WHERE id = ?').get(id));
}

/**
 * Returns the single event currently in status 'active', or undefined if
 * none is. Keeping at most one event active is an application-level
 * invariant enforced by the lifecycle/scheduler (Task 4), not a DB
 * constraint - this just reads the first match.
 */
export async function getActiveEvent() {
  return parseEventRow(db.prepare("SELECT * FROM live_events WHERE status = 'active' LIMIT 1").get());
}

const putEventStmt = db.prepare(`
  INSERT INTO live_events (id, name, description, theme, modifiers, ladder, status, starts_at, ends_at, recurrence, created_at, created_by)
  VALUES (@id, @name, @description, @theme, @modifiers, @ladder, @status, @starts_at, @ends_at, @recurrence, @created_at, @created_by)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name, description = excluded.description, theme = excluded.theme,
    modifiers = excluded.modifiers, ladder = excluded.ladder, status = excluded.status,
    starts_at = excluded.starts_at, ends_at = excluded.ends_at, recurrence = excluded.recurrence,
    created_by = excluded.created_by
`);

/**
 * Insert-or-replace for a single event, keyed on `event.id`. `theme`,
 * `modifiers`, `ladder`, and `recurrence` are plain JS values here (arrays/
 * objects/null); this function JSON.stringify's them for storage, mirroring
 * putSave/putConfigRow's convention of stringifying at the write boundary.
 * On conflict, `created_at` is intentionally left untouched (it's the
 * original creation time, not a "last written" timestamp) - everything else
 * is fully replaced. Accepts either camelCase (startsAt/createdAt/createdBy)
 * or snake_case (starts_at/created_at/created_by) keys for the non-JSON
 * fields, since callers may pass back a row previously read via getEvent
 * (snake_case) or freshly authored data (camelCase).
 */
export async function putEvent(event) {
  const row = {
    id: event.id,
    name: event.name,
    description: event.description ?? null,
    theme: JSON.stringify(event.theme ?? null),
    modifiers: JSON.stringify(event.modifiers ?? []),
    ladder: JSON.stringify(event.ladder ?? []),
    status: event.status ?? 'draft',
    starts_at: event.startsAt ?? event.starts_at ?? null,
    ends_at: event.endsAt ?? event.ends_at ?? null,
    recurrence: JSON.stringify(event.recurrence ?? null),
    created_at: event.createdAt ?? event.created_at ?? Date.now(),
    created_by: event.createdBy ?? event.created_by ?? null,
  };
  putEventStmt.run(row);
  return await getEvent(row.id);
}

/**
 * Updates only `status`, plus `starts_at`/`ends_at` when explicitly passed
 * in the options object (a key present but `null` clears that column; a key
 * simply absent leaves the existing value untouched). This lets the
 * scheduler flip status alone (e.g. active -> ended) without needing to
 * re-supply - or accidentally wipe - the event's window.
 */
export async function setEventStatus(id, status, { startsAt, endsAt } = {}) {
  const sets = ['status = @status'];
  const params = { id, status };
  if (startsAt !== undefined) { sets.push('starts_at = @starts_at'); params.starts_at = startsAt; }
  if (endsAt !== undefined) { sets.push('ends_at = @ends_at'); params.ends_at = endsAt; }
  db.prepare(`UPDATE live_events SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

/**
 * Deletes an event row outright. This module does not enforce "drafts
 * only" - the route layer (Task 6) is responsible for rejecting deletes of
 * scheduled/active/ended events before calling this.
 */
export async function deleteEvent(id) {
  db.prepare('DELETE FROM live_events WHERE id = ?').run(id);
}

const upsertParticipationStmt = db.prepare(`
  INSERT INTO event_participation (user_id, event_id, started_at, ends_at, rungs_claimed, last_progress_at, opted_out)
  VALUES (@user_id, @event_id, @started_at, @ends_at, @rungs_claimed, @last_progress_at, @opted_out)
  ON CONFLICT(user_id, event_id) DO UPDATE SET
    started_at = excluded.started_at, ends_at = excluded.ends_at,
    rungs_claimed = excluded.rungs_claimed, last_progress_at = excluded.last_progress_at,
    opted_out = excluded.opted_out
`);

/**
 * Insert-or-replace for one user's participation row in one event, keyed on
 * (user_id, event_id). Accepts camelCase or snake_case keys, same rationale
 * as putEvent.
 */
export async function upsertParticipation(row) {
  const params = {
    user_id: row.userId ?? row.user_id,
    event_id: row.eventId ?? row.event_id,
    started_at: row.startedAt ?? row.started_at,
    ends_at: row.endsAt ?? row.ends_at,
    rungs_claimed: row.rungsClaimed ?? row.rungs_claimed ?? 0,
    last_progress_at: row.lastProgressAt ?? row.last_progress_at ?? null,
    opted_out: (row.optedOut ?? row.opted_out) ? 1 : 0,
  };
  upsertParticipationStmt.run(params);
  return await getParticipation(params.user_id, params.event_id);
}

export async function getParticipation(userId, eventId) {
  return db.prepare('SELECT * FROM event_participation WHERE user_id = ? AND event_id = ?').get(userId, eventId);
}

const updateParticipationProgressStmt = db.prepare(`
  UPDATE event_participation SET rungs_claimed = ?, last_progress_at = ?
  WHERE user_id = ? AND event_id = ?
`);

/**
 * Narrow, idempotent progress sync used by stateService.applyActions after a
 * successful claimEventRung (hotfix for the "rungs_claimed frozen at 0" bug -
 * upsertParticipation was only ever called once, at join time, from
 * joinEventIfEligible). Deliberately NOT a call to upsertParticipation: that
 * function's ON CONFLICT clause overwrites every column, including
 * `opted_out` and `started_at`/`ends_at` - a caller here that doesn't have
 * (or doesn't want to re-fetch) the user's current opt-out flag would
 * silently un-opt-out them on every claim. A plain UPDATE touching only
 * `rungs_claimed`/`last_progress_at` leaves every other column alone, and is
 * a harmless no-op (0 rows affected, no throw) if the participation row
 * doesn't exist for some reason (e.g. the event was deleted out from under
 * an in-flight claim).
 */
export async function updateParticipationProgress(userId, eventId, rungsClaimed, lastProgressAt) {
  updateParticipationProgressStmt.run(rungsClaimed, lastProgressAt, userId, eventId);
}

/**
 * All participants in an event, ranked for the coordinator view / leaderboard:
 * most rungs claimed first, ties broken by whoever reached their current
 * progress earliest.
 */
export async function listParticipation(eventId) {
  return db.prepare(
    'SELECT * FROM event_participation WHERE event_id = ? ORDER BY rungs_claimed DESC, last_progress_at ASC',
  ).all(eventId);
}

export async function setLeaderboardOptOut(userId, optOut) {
  db.prepare('UPDATE users SET leaderboard_opt_out = ? WHERE id = ?').run(optOut ? 1 : 0, userId);
}

/**
 * Leaderboard rows for `eventId`, same ranking as listParticipation (most
 * rungs claimed first, ties broken by earliest last_progress_at), but -
 * unlike listParticipation - LEFT JOINed against `users` and filtered on
 * the LIVE `users.leaderboard_opt_out`, not the value snapshotted into
 * `event_participation.opted_out` at join time. That snapshot is written
 * once by joinEventIfEligible and never updated again, so a user who opts
 * out AFTER joining would otherwise keep appearing here (Task 6 review
 * carry-forward, hard requirement 1). PUT /api/me/leaderboard-opt-out
 * writes straight to `users.leaderboard_opt_out`, so this query picks up
 * that change immediately on the very next read - no re-sync step needed.
 * Capped at `limit` rows (default 50, per the route's leaderboard contract).
 */
export async function listLeaderboard(eventId, limit = 50) {
  return db.prepare(`
    SELECT ep.user_id AS userId, u.username AS username,
           ep.rungs_claimed AS rungsClaimed, ep.last_progress_at AS lastProgressAt
    FROM event_participation ep
    LEFT JOIN users u ON u.id = ep.user_id
    WHERE ep.event_id = ? AND COALESCE(u.leaderboard_opt_out, 0) = 0
    ORDER BY ep.rungs_claimed DESC, ep.last_progress_at ASC
    LIMIT ?
  `).all(eventId, limit);
}

/**
 * The most recently-STARTED event that has actually run (any status except
 * 'draft', which by definition has no window). Backs the v1.5 leaderboard's
 * latest-event board. Returns null when no event has ever been scheduled.
 */
export async function getLatestEventId() {
  const row = db.prepare(
    "SELECT id FROM live_events WHERE status != 'draft' AND starts_at IS NOT NULL ORDER BY starts_at DESC LIMIT 1",
  ).get();
  return row ? row.id : null;
}

const seedEventStmt = db.prepare(`
  INSERT OR IGNORE INTO live_events (id, name, description, theme, modifiers, ladder, status, starts_at, ends_at, recurrence, created_at, created_by)
  VALUES (@id, @name, @description, @theme, @modifiers, @ladder, 'draft', NULL, NULL, @recurrence, @created_at, NULL)
`);

/**
 * Inserts each SEASONAL_EVENTS entry as status 'draft' with no window, but
 * only when that id isn't already present - INSERT OR IGNORE makes this
 * safe to call on every boot (idempotent) without ever clobbering an
 * admin-edited copy of a seeded event (e.g. a coordinator tweaked
 * summer-surge's modifiers or already scheduled it). Called from
 * ensureConfig-adjacent boot code (Task 4).
 */
export async function seedSeasonalEvents() {
  const now = Date.now();
  for (const evt of SEASONAL_EVENTS) {
    seedEventStmt.run({
      id: evt.id,
      name: evt.name,
      description: evt.description ?? null,
      theme: JSON.stringify(evt.theme ?? null),
      modifiers: JSON.stringify(evt.modifiers ?? []),
      ladder: JSON.stringify(evt.ladder ?? []),
      recurrence: JSON.stringify(evt.recurrence ?? null),
      created_at: now,
    });
  }
}
