import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { SEASONAL_EVENTS } from '../data/seasonalEvents.js';
// Aliased on import: the schema-layer function and this driver's own
// `dedupeUsernames` interface method (a thin delegation to it, below) share
// a name on purpose - the alias just keeps the two from shadowing each
// other inside this file.
import { applySchema, dedupeUsernames as dedupeUsernamesSchema } from './schema.sqlite.js';
import {
  findAvailableUsername, parseEventRow, normalizeEventRow, normalizeParticipationRow,
} from './shared.js';

export async function createSqliteDriver({ path: dbPath }) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  await applySchema(db);

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
    INSERT INTO users (id, username, avatar_url, created_at)
    VALUES (@id, @username, @avatar_url, @created_at)
  `);

  const insertIdentityStmt = db.prepare(`
    INSERT INTO identities (provider, provider_id, user_id, created_at, last_login_at)
    VALUES (@provider, @provider_id, @user_id, @created_at, @last_login_at)
  `);

  // A brand-new login writes both `users` and `identities`. Wrapped in one
  // transaction so a failure on the second write rolls back the first -
  // without this, a users row with no matching identity is invisible to
  // the identity lookup at the top of upsertUser, so the very next login
  // attempt would retry INSERT INTO users with the same primary key,
  // raising SQLITE_CONSTRAINT_PRIMARYKEY (a code the username-collision
  // catch below doesn't recognize) and permanently locking the account out.
  const insertUserAndIdentity = db.transaction((user, identityRow) => {
    insertUserStmt.run(user);
    insertIdentityStmt.run(identityRow);
  });

  const putEventStmt = db.prepare(`
    INSERT INTO live_events (id, name, description, theme, modifiers, ladder, status, starts_at, ends_at, recurrence, created_at, created_by)
    VALUES (@id, @name, @description, @theme, @modifiers, @ladder, @status, @starts_at, @ends_at, @recurrence, @created_at, @created_by)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, description = excluded.description, theme = excluded.theme,
      modifiers = excluded.modifiers, ladder = excluded.ladder, status = excluded.status,
      starts_at = excluded.starts_at, ends_at = excluded.ends_at, recurrence = excluded.recurrence,
      created_by = excluded.created_by
  `);

  const upsertParticipationStmt = db.prepare(`
    INSERT INTO event_participation (user_id, event_id, started_at, ends_at, rungs_claimed, last_progress_at, opted_out)
    VALUES (@user_id, @event_id, @started_at, @ends_at, @rungs_claimed, @last_progress_at, @opted_out)
    ON CONFLICT(user_id, event_id) DO UPDATE SET
      started_at = excluded.started_at, ends_at = excluded.ends_at,
      rungs_claimed = excluded.rungs_claimed, last_progress_at = excluded.last_progress_at,
      opted_out = excluded.opted_out
  `);

  const updateParticipationProgressStmt = db.prepare(`
    UPDATE event_participation SET rungs_claimed = ?, last_progress_at = ?
    WHERE user_id = ? AND event_id = ?
  `);

  const seedEventStmt = db.prepare(`
    INSERT OR IGNORE INTO live_events (id, name, description, theme, modifiers, ladder, status, starts_at, ends_at, recurrence, created_at, created_by)
    VALUES (@id, @name, @description, @theme, @modifiers, @ladder, 'draft', NULL, NULL, @recurrence, @created_at, NULL)
  `);

  const driver = {
    __backend: 'sqlite',
    __raw: db,

    async upsertUser({ provider, providerId, username, avatarUrl }) {
      // Resolution goes through identities now, not a direct lookup by
      // users.id - a later release attaching a second login method to the
      // same account will only add a row here, never touch users.id.
      const identity = db.prepare(
        'SELECT * FROM identities WHERE provider = ? AND provider_id = ?',
      ).get(provider, providerId);

      if (identity) {
        const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(identity.user_id);
        db.prepare(
          'UPDATE identities SET last_login_at = ? WHERE provider = ? AND provider_id = ?',
        ).run(Date.now(), provider, providerId);

        // A user who has set a custom username keeps it on re-login; only the
        // avatar (which the user doesn't control) is refreshed from the profile.
        const desiredUsername = existing.custom_username ? existing.username : username;
        let nextUsername = desiredUsername;
        try {
          db.prepare('UPDATE users SET username = ?, avatar_url = ? WHERE id = ?')
            .run(nextUsername, avatarUrl, existing.id);
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
          nextUsername = await findAvailableUsername(
            desiredUsername,
            (name) => isUsernameTakenByOtherUser(name, existing.id),
          );
          db.prepare('UPDATE users SET username = ?, avatar_url = ? WHERE id = ?')
            .run(nextUsername, avatarUrl, existing.id);
        }
        return { ...existing, username: nextUsername, avatar_url: avatarUrl };
      }

      const id = `${provider}:${providerId}`;
      const now = Date.now();
      const user = {
        id, username, avatar_url: avatarUrl, created_at: now,
      };
      const identityRow = {
        provider, provider_id: providerId, user_id: id, created_at: now, last_login_at: now,
      };
      try {
        insertUserAndIdentity(user, identityRow);
      } catch (e) {
        // Two different brand-new OAuth accounts can independently supply the
        // same (or case-variant) username - the COLLATE NOCASE unique index
        // rejects the second insert with SQLITE_CONSTRAINT_UNIQUE. Without this
        // catch, that error would propagate to a 500 and - since upsertUser
        // runs on every login, not just the first - permanently block that
        // account from ever logging in. Pick a free variant using the same
        // suffixing convention as dedupeUsernames and retry once.
        if (e.code !== 'SQLITE_CONSTRAINT_UNIQUE' && e.code !== 'SQLITE_CONSTRAINT') throw e;
        user.username = await findAvailableUsername(username, isUsernameTakenInDb);
        insertUserAndIdentity(user, identityRow);
      }
      return user;
    },

    async getUserById(id) {
      return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    },

    /**
     * `provider` is the user's PRIMARY identity - earliest created_at, ties
     * broken by provider name - not necessarily their only one. Since no
     * user has more than one identity yet, this is identical to the
     * pre-split `users.provider` column for every existing row.
     */
    async getAllUsersWithSaves() {
      return db.prepare(`
        SELECT u.id, u.username, u.avatar_url, u.created_at,
               u.leaderboard_opt_out,
               s.data, s.last_save,
               (SELECT i.provider FROM identities i
                 WHERE i.user_id = u.id
                 ORDER BY i.created_at ASC, i.provider ASC, i.provider_id ASC
                 LIMIT 1) AS provider
        FROM users u
        LEFT JOIN saves s ON s.user_id = u.id
        ORDER BY u.created_at DESC, u.id ASC
      `).all();
    },

    /**
     * Every login method attached to `userId`, earliest first. Not yet
     * consumed anywhere in this codebase - a thin read added ahead of v1.8,
     * which will use it to let a player see (and eventually link) every
     * provider they've logged in with.
     */
    async listIdentities(userId) {
      return db.prepare('SELECT * FROM identities WHERE user_id = ? ORDER BY created_at ASC').all(userId);
    },

    async getSave(userId) {
      return db.prepare('SELECT * FROM saves WHERE user_id = ?').get(userId);
    },

    async putSave(userId, data, lastSave) {
      db.prepare(`
        INSERT INTO saves (user_id, data, last_save) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, last_save = excluded.last_save
      `).run(userId, JSON.stringify(data), lastSave);
    },

    async deleteSave(userId) {
      db.prepare('DELETE FROM saves WHERE user_id = ?').run(userId);
    },

    /**
     * Roles are stored as a JSON array string in users.roles (default '[]').
     * Membership in the array is the only thing that matters - ordering and
     * duplicates are not deduped here; callers (server/auth.js, Task 8) treat
     * this as a plain set.
     */
    async getRoles(userId) {
      const row = db.prepare('SELECT roles FROM users WHERE id = ?').get(userId);
      if (!row || !row.roles) return [];
      try {
        return JSON.parse(row.roles);
      } catch (e) {
        return [];
      }
    },

    async setRoles(userId, roles) {
      db.prepare('UPDATE users SET roles = ? WHERE id = ?').run(JSON.stringify(roles), userId);
    },

    /**
     * Completed guided tours, stored as a JSON array string in
     * users.tours_completed (default '[]') - the same shape and defensive-read
     * contract as users.roles above. Callers treat it as a plain set; the route
     * layer owns validation against shared/tours.js.
     */
    async getToursCompleted(userId) {
      const row = db.prepare('SELECT tours_completed FROM users WHERE id = ?').get(userId);
      if (!row || !row.tours_completed) return [];
      try {
        const parsed = JSON.parse(row.tours_completed);
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
      } catch (e) {
        return [];
      }
    },

    async setToursCompleted(userId, ids) {
      db.prepare('UPDATE users SET tours_completed = ? WHERE id = ?').run(JSON.stringify(ids), userId);
    },

    /**
     * Sets a user's username, format-agnostic (the route layer owns the regex).
     * Performs its own case-insensitive availability check excluding the user
     * themself, and marks the username as user-chosen so upsertUser stops
     * overwriting it from the OAuth profile on future logins.
     */
    async setUsername(userId, name) {
      const collision = db.prepare(
        'SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?',
      ).get(name, userId);
      if (collision) return { ok: false, error: 'taken' };
      db.prepare('UPDATE users SET username = ?, custom_username = 1 WHERE id = ?').run(name, userId);
      return { ok: true };
    },

    async dedupeUsernames() {
      return await dedupeUsernamesSchema(db);
    },

    async createMinigameSession(userId, game) {
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
    },

    async getMinigameSession(id) {
      return db.prepare('SELECT * FROM minigame_sessions WHERE id = ?').get(id);
    },

    /**
     * Finds the most recent still-open (unfinished, not yet expired) session
     * for `userId`+`game`, if any. "Not yet expired" is caller-supplied as
     * `minStartedAt` (a session's `started_at` must be >= this to count) since
     * the expiry window depends on `config.minigames[game].durationSec`, which
     * this module doesn't have access to - the route layer computes it.
     * Used to block a burst of concurrently-open sessions for the same game
     * (each of which would otherwise dodge the win cooldown independently).
     */
    async getOpenMinigameSession(userId, game, minStartedAt) {
      return db.prepare(`
        SELECT * FROM minigame_sessions
        WHERE user_id = ? AND game = ? AND finished_at IS NULL AND started_at >= ?
        ORDER BY started_at DESC LIMIT 1
      `).get(userId, game, minStartedAt);
    },

    async finishMinigameSession(id, score) {
      db.prepare('UPDATE minigame_sessions SET finished_at = ?, score = ? WHERE id = ?').run(Date.now(), score, id);
    },

    /**
     * Returns the singleton config row (id=1): { id, version, data, updated_at,
     * updated_by }, or undefined if no config has been seeded yet. `data` is
     * returned as the raw JSON text exactly as stored - mirroring getSave's
     * convention, callers JSON.parse it themselves.
     */
    async getConfigRow() {
      return db.prepare('SELECT * FROM config WHERE id = 1').get();
    },

    /**
     * Upserts the singleton config row (id=1) to `{ version, data, userId }`
     * and appends a matching row to config_history for audit/rollback. `data`
     * is a plain JS object; it is JSON.stringify'd here (the same convention
     * putSave uses) - callers never pass pre-stringified JSON.
     */
    async putConfigRow(version, data, userId) {
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
    },

    async getConfigHistory() {
      return db.prepare('SELECT * FROM config_history ORDER BY rowid DESC').all();
    },

    async listEvents() {
      // `, id ASC` matches driver.pg.js's ordering exactly. seedSeasonalEvents
      // inserts all four seasonal events with the same `now`, so ties are
      // guaranteed rather than hypothetical, and without a tiebreak the admin
      // Events list comes back in a different order on each backend.
      return db.prepare('SELECT * FROM live_events ORDER BY created_at ASC, id ASC').all().map(parseEventRow);
    },

    async getEvent(id) {
      return parseEventRow(db.prepare('SELECT * FROM live_events WHERE id = ?').get(id));
    },

    /**
     * Returns the single event currently in status 'active', or undefined if
     * none is. Keeping at most one event active is an application-level
     * invariant enforced by the lifecycle/scheduler (Task 4), not a DB
     * constraint - this just reads the first match.
     */
    async getActiveEvent() {
      return parseEventRow(db.prepare("SELECT * FROM live_events WHERE status = 'active' LIMIT 1").get());
    },

    /**
     * Insert-or-replace for a single event, keyed on `event.id`. On conflict,
     * `created_at` is intentionally left untouched (it's the original
     * creation time, not a "last written" timestamp) - everything else is
     * fully replaced.
     */
    async putEvent(event) {
      const row = normalizeEventRow(event);
      putEventStmt.run(row);
      // Reference the sibling method via the `driver` closure variable, not
      // `this` - the facade (server/db/index.js) destructures these methods
      // off the driver object and exports them as free functions, so a call
      // site like `putEvent(...)` (no receiver) would leave `this` undefined.
      return driver.getEvent(row.id);
    },

    /**
     * Updates only `status`, plus `starts_at`/`ends_at` when explicitly passed
     * in the options object (a key present but `null` clears that column; a key
     * simply absent leaves the existing value untouched). This lets the
     * scheduler flip status alone (e.g. active -> ended) without needing to
     * re-supply - or accidentally wipe - the event's window.
     */
    async setEventStatus(id, status, { startsAt, endsAt } = {}) {
      const sets = ['status = @status'];
      const params = { id, status };
      if (startsAt !== undefined) { sets.push('starts_at = @starts_at'); params.starts_at = startsAt; }
      if (endsAt !== undefined) { sets.push('ends_at = @ends_at'); params.ends_at = endsAt; }
      db.prepare(`UPDATE live_events SET ${sets.join(', ')} WHERE id = @id`).run(params);
    },

    /**
     * Deletes an event row outright. This module does not enforce "drafts
     * only" - the route layer (Task 6) is responsible for rejecting deletes of
     * scheduled/active/ended events before calling this.
     */
    async deleteEvent(id) {
      db.prepare('DELETE FROM live_events WHERE id = ?').run(id);
    },

    /**
     * Insert-or-replace for one user's participation row in one event, keyed on
     * (user_id, event_id).
     */
    async upsertParticipation(row) {
      const params = normalizeParticipationRow(row);
      upsertParticipationStmt.run(params);
      return driver.getParticipation(params.user_id, params.event_id);
    },

    async getParticipation(userId, eventId) {
      return db.prepare('SELECT * FROM event_participation WHERE user_id = ? AND event_id = ?').get(userId, eventId);
    },

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
    async updateParticipationProgress(userId, eventId, rungsClaimed, lastProgressAt) {
      updateParticipationProgressStmt.run(rungsClaimed, lastProgressAt, userId, eventId);
    },

    /**
     * All participants in an event, ranked for the coordinator view / leaderboard:
     * most rungs claimed first, ties broken by whoever reached their current
     * progress earliest.
     */
    async listParticipation(eventId) {
      return db.prepare(
        'SELECT * FROM event_participation WHERE event_id = ? ORDER BY rungs_claimed DESC, last_progress_at ASC',
      ).all(eventId);
    },

    async setLeaderboardOptOut(userId, optOut) {
      db.prepare('UPDATE users SET leaderboard_opt_out = ? WHERE id = ?').run(optOut ? 1 : 0, userId);
    },

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
    async listLeaderboard(eventId, limit = 50) {
      return db.prepare(`
        SELECT ep.user_id AS userId, u.username AS username,
               ep.rungs_claimed AS rungsClaimed, ep.last_progress_at AS lastProgressAt
        FROM event_participation ep
        LEFT JOIN users u ON u.id = ep.user_id
        WHERE ep.event_id = ? AND COALESCE(u.leaderboard_opt_out, 0) = 0
        ORDER BY ep.rungs_claimed DESC, ep.last_progress_at ASC
        LIMIT ?
      `).all(eventId, limit);
    },

    /**
     * The most recently-STARTED event that has actually run (any status except
     * 'draft', which by definition has no window). Backs the v1.5 leaderboard's
     * latest-event board. Returns null when no event has ever been scheduled.
     */
    async getLatestEventId() {
      const row = db.prepare(
        "SELECT id FROM live_events WHERE status != 'draft' AND starts_at IS NOT NULL ORDER BY starts_at DESC LIMIT 1",
      ).get();
      return row ? row.id : null;
    },

    /**
     * Inserts each SEASONAL_EVENTS entry as status 'draft' with no window, but
     * only when that id isn't already present - INSERT OR IGNORE makes this
     * safe to call on every boot (idempotent) without ever clobbering an
     * admin-edited copy of a seeded event (e.g. a coordinator tweaked
     * summer-surge's modifiers or already scheduled it). Called from
     * ensureConfig-adjacent boot code (Task 4).
     */
    async seedSeasonalEvents() {
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
    },
  };

  return driver;
}
