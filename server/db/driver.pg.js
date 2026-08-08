import pg from 'pg';
import { randomUUID } from 'node:crypto';
import './pgTypes.js'; // side effect: registers the BIGINT->Number type parser
import { applySchema } from './schema.pg.js';
import { SEASONAL_EVENTS } from '../data/seasonalEvents.js';
import {
  findAvailableUsername, parseEventRow, normalizeEventRow, normalizeParticipationRow, dedupeUsernameRows,
} from './shared.js';

export async function createPgDriver({ url }) {
  const pool = new pg.Pool({ connectionString: url });
  // pg's Pool emits 'error' for problems on idle clients in the background
  // (e.g. the network connection resetting, or - in tests - the database
  // being force-dropped out from under an open pool). An unhandled 'error'
  // event is fatal to the whole Node process, not just this pool, so a
  // listener is required even though there's nothing driver-level to do
  // about it beyond not crashing.
  pool.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('Unexpected error on idle Postgres client', err);
  });
  await applySchema(pool);

  const one = async (sql, params = []) => (await pool.query(sql, params)).rows[0];
  const all = async (sql, params = []) => (await pool.query(sql, params)).rows;
  const run = async (sql, params = []) => { await pool.query(sql, params); };

  function isUsernameTakenInDb(name) {
    return one('SELECT id FROM users WHERE lower(username) = lower($1)', [name]).then(Boolean);
  }

  // Same check as isUsernameTakenInDb, but excludes the given user's own row -
  // used by upsertUser's UPDATE (returning-user) path, where the row being
  // updated already "has" the old username and must not be treated as its own
  // collision.
  function isUsernameTakenByOtherUser(name, excludeId) {
    return one(
      'SELECT id FROM users WHERE lower(username) = lower($1) AND id != $2', [name, excludeId],
    ).then(Boolean);
  }

  // A brand-new login writes both `users` and `identities`. Run on a single
  // checked-out client wrapped in BEGIN/COMMIT so a failure on the second
  // write rolls back the first - without this, a users row with no
  // matching identity is invisible to the identity lookup at the top of
  // upsertUser, so the very next login attempt would retry INSERT INTO
  // users with the same primary key, raising SQLSTATE 23505 (the same code
  // a username collision raises) and misdiagnosing it as one, burning a
  // findAvailableUsername retry that still fails and permanently locking
  // the account out.
  async function insertUserAndIdentity(user, identityRow) {
    const client = await pool.connect();
    // Set once the client is known to be in a clean state; on any other exit
    // the client is destroyed rather than returned to the pool. Releasing a
    // client that might still hold an open transaction would hand the next
    // caller a connection mid-transaction.
    let releasable = false;
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO users (id, username, avatar_url, created_at) VALUES ($1, $2, $3, $4)',
        [user.id, user.username, user.avatar_url, user.created_at],
      );
      await client.query(
        `INSERT INTO identities (provider, provider_id, user_id, created_at, last_login_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          identityRow.provider, identityRow.provider_id, identityRow.user_id,
          identityRow.created_at, identityRow.last_login_at,
        ],
      );
      await client.query('COMMIT');
      releasable = true;
    } catch (e) {
      // The ROLLBACK is best-effort: if it throws (the connection died
      // mid-transaction, say), letting that error propagate would REPLACE
      // `e` - and `e` is load-bearing here. upsertUser's caller inspects it
      // for SQLSTATE 23505 to drive the username-collision retry; swapping
      // in a rollback error turns a recoverable collision into a 500.
      try {
        await client.query('ROLLBACK');
        releasable = true;
      } catch (rollbackError) {
        console.error('[db] ROLLBACK failed after a failed user insert; discarding the connection', rollbackError);
      }
      throw e;
    } finally {
      // release(err) destroys the client instead of returning it to the pool.
      client.release(releasable ? undefined : new Error('connection left in an unknown transaction state'));
    }
  }

  const driver = {
    __backend: 'pg',
    __raw: pool,

    async upsertUser({ provider, providerId, username, avatarUrl }) {
      // Resolution goes through identities now, not a direct lookup by
      // users.id - a later release attaching a second login method to the
      // same account will only add a row here, never touch users.id.
      const identity = await one(
        'SELECT * FROM identities WHERE provider = $1 AND provider_id = $2', [provider, providerId],
      );

      if (identity) {
        const existing = await one('SELECT * FROM users WHERE id = $1', [identity.user_id]);
        await run(
          'UPDATE identities SET last_login_at = $1 WHERE provider = $2 AND provider_id = $3',
          [Date.now(), provider, providerId],
        );

        // A user who has set a custom username keeps it on re-login; only the
        // avatar (which the user doesn't control) is refreshed from the profile.
        const desiredUsername = existing.custom_username ? existing.username : username;
        let nextUsername = desiredUsername;
        try {
          await run('UPDATE users SET username = $1, avatar_url = $2 WHERE id = $3', [nextUsername, avatarUrl, existing.id]);
        } catch (e) {
          // The provider-supplied name can change between logins (e.g. the user
          // renamed their display name on the OAuth provider) and collide
          // case-insensitively with a DIFFERENT user's username. Without this
          // catch, that error would propagate to a 500 and - since upsertUser
          // runs on every login - permanently lock the account out until the
          // provider-side name changed back. Same suffixing convention/helper as
          // the INSERT path, excluding this user's own row from the collision
          // check (their old value isn't a collision against their new one).
          if (e.code !== '23505') throw e; // unique_violation
          nextUsername = await findAvailableUsername(
            desiredUsername,
            (name) => isUsernameTakenByOtherUser(name, existing.id),
          );
          await run('UPDATE users SET username = $1, avatar_url = $2 WHERE id = $3', [nextUsername, avatarUrl, existing.id]);
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
        await insertUserAndIdentity(user, identityRow);
      } catch (e) {
        // Two different brand-new OAuth accounts can independently supply the
        // same (or case-variant) username - the unique functional index on
        // lower(username) rejects the second insert with SQLSTATE 23505.
        // Without this catch, that error would propagate to a 500 and - since
        // upsertUser runs on every login, not just the first - permanently
        // block that account from ever logging in. Pick a free variant using
        // the same suffixing convention as dedupeUsernames and retry once.
        if (e.code !== '23505') throw e; // unique_violation

        // Not every 23505 here is a username collision, and treating them all
        // as one is how a race turned into a failed login. Two simultaneous
        // FIRST logins for the same player both see no identity and both
        // insert; the loser violates `users_pkey`, not the username index.
        // Renaming and retrying then re-inserts the SAME primary key, fails
        // again, and this time propagates - so the player's very first login
        // errors out. (SQLite avoids this by accident: nothing awaits between
        // its identity read and its insert. Dialect drift, found by the v1.8
        // final review against a real Postgres container.)
        //
        // The winner's row is correct and complete, so the right recovery is
        // simply to adopt it.
        if (e.constraint === 'users_pkey') {
          const winner = await one('SELECT * FROM users WHERE id = $1', [id]);
          if (winner) {
            // Adopting the winner's users row is only correct if the identity
            // row exists too. In the race it does - insertUserAndIdentity is
            // one transaction, so the winner wrote both. But a `users` row
            // WITHOUT its identity can exist from outside that path (a partial
            // restore, a manual insert), and there the pre-fix code raised
            // 23505 on every login - loud, and diagnosable. Returning the user
            // without repairing the identity would convert that into permanent
            // silence: the login "succeeds" forever, getIdentity stays null,
            // setSupertokensUserId no-ops forever, and the shadow gate cannot
            // see the row at all because its audit walks identities -> users.
            // That is the mirror image of the ORPHAN blind spot fixed in the
            // same release. Found by the fix-verification review.
            await run(
              `INSERT INTO identities (provider, provider_id, user_id, created_at, last_login_at)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (provider, provider_id) DO NOTHING`,
              [
                identityRow.provider, identityRow.provider_id, identityRow.user_id,
                identityRow.created_at, identityRow.last_login_at,
              ],
            );
            return winner;
          }
          throw e;
        }

        user.username = await findAvailableUsername(username, isUsernameTakenInDb);
        await insertUserAndIdentity(user, identityRow);
      }
      return user;
    },

    async getUserById(id) {
      return one('SELECT * FROM users WHERE id = $1', [id]);
    },

    /**
     * `provider` is the user's PRIMARY identity - earliest created_at, ties
     * broken by provider name - not necessarily their only one. Since no
     * user has more than one identity yet, this is identical to the
     * pre-split `users.provider` column for every existing row.
     */
    async getAllUsersWithSaves() {
      return all(`
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
      `);
    },

    /**
     * Every login method attached to `userId`, earliest first. Not yet
     * consumed anywhere in this codebase - a thin read added ahead of v1.8,
     * which will use it to let a player see (and eventually link) every
     * provider they've logged in with.
     */
    async listIdentities(userId) {
      return all('SELECT * FROM identities WHERE user_id = $1 ORDER BY created_at ASC', [userId]);
    },

    /**
     * One login method by its (provider, provider_id) pair - the primary key -
     * or `undefined` when that pair has never logged in.
     *
     * This is the read SuperTokens' signInUp override keys off (v1.8): it maps
     * `thirdPartyId`/`thirdPartyUserId` onto exactly this pair, and the
     * `user_id` it returns is what gets registered as the external user id.
     * Deliberately separate from upsertUser's internal lookup, because the
     * override must be able to ask "does this player already exist?" WITHOUT
     * the side effect of creating them.
     */
    async getIdentity(provider, providerId) {
      return one('SELECT * FROM identities WHERE provider = $1 AND provider_id = $2', [provider, providerId]);
    },

    /**
     * Records the SuperTokens-internal user id that has been mapped onto this
     * identity. Bookkeeping on our side only - the mapping that actually
     * governs what `session.getUserId()` returns lives in the SuperTokens
     * core, created by `createUserIdMapping`.
     *
     * Safe to call on every login. The column is UNIQUE, but re-writing a row's
     * own existing value is not a conflict with itself, so the re-login path
     * needs no guard. A conflict here means two identities were handed the same
     * SuperTokens id, which is real corruption and must surface, so it is
     * deliberately NOT swallowed.
     *
     * A missing identity row is a silent no-op, matching setRoles /
     * setToursCompleted. Throwing instead would be actively dangerous in the
     * one place this is called from: it runs immediately AFTER
     * createUserIdMapping, so a throw would fail the login while leaving the
     * core-side mapping in place - and the retry would then fail on the
     * already-exists mapping instead, locking the account out permanently.
     * Callers reach here having just resolved or created the identity, so a
     * miss cannot happen without a caller-side bug.
     */
    async setSupertokensUserId(provider, providerId, supertokensUserId) {
      await run(
        'UPDATE identities SET supertokens_user_id = $1 WHERE provider = $2 AND provider_id = $3',
        [supertokensUserId, provider, providerId],
      );
    },

    async getSave(userId) {
      return one('SELECT * FROM saves WHERE user_id = $1', [userId]);
    },

    async putSave(userId, data, lastSave) {
      await run(`
        INSERT INTO saves (user_id, data, last_save) VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, last_save = excluded.last_save
      `, [userId, JSON.stringify(data), lastSave]);
    },

    async deleteSave(userId) {
      await run('DELETE FROM saves WHERE user_id = $1', [userId]);
    },

    /**
     * Roles are stored as a JSON array string in users.roles (default '[]').
     * Membership in the array is the only thing that matters - ordering and
     * duplicates are not deduped here; callers (server/auth.js, Task 8) treat
     * this as a plain set.
     */
    async getRoles(userId) {
      const row = await one('SELECT roles FROM users WHERE id = $1', [userId]);
      if (!row || !row.roles) return [];
      try {
        return JSON.parse(row.roles);
      } catch (e) {
        return [];
      }
    },

    async setRoles(userId, roles) {
      await run('UPDATE users SET roles = $1 WHERE id = $2', [JSON.stringify(roles), userId]);
    },

    /**
     * Completed guided tours, stored as a JSON array string in
     * users.tours_completed (default '[]') - the same shape and defensive-read
     * contract as users.roles above. Callers treat it as a plain set; the route
     * layer owns validation against shared/tours.js.
     */
    async getToursCompleted(userId) {
      const row = await one('SELECT tours_completed FROM users WHERE id = $1', [userId]);
      if (!row || !row.tours_completed) return [];
      try {
        const parsed = JSON.parse(row.tours_completed);
        return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
      } catch (e) {
        return [];
      }
    },

    async setToursCompleted(userId, ids) {
      await run('UPDATE users SET tours_completed = $1 WHERE id = $2', [JSON.stringify(ids), userId]);
    },

    /**
     * Sets a user's username, format-agnostic (the route layer owns the regex).
     * Performs its own case-insensitive availability check excluding the user
     * themself, and marks the username as user-chosen so upsertUser stops
     * overwriting it from the OAuth profile on future logins.
     */
    async setUsername(userId, name) {
      const collision = await one(
        'SELECT id FROM users WHERE lower(username) = lower($1) AND id != $2', [name, userId],
      );
      if (collision) return { ok: false, error: 'taken' };
      await run('UPDATE users SET username = $1, custom_username = 1 WHERE id = $2', [name, userId]);
      return { ok: true };
    },

    /**
     * Duplicate usernames (case-insensitively) can exist from before the
     * unique index was introduced. Unlike the SQLite driver, schema.pg.js's
     * applySchema does NOT call this on every boot - a fresh Postgres
     * deployment has no pre-index history to clean up, since every write
     * path into `users` already goes through this driver's own
     * collision-checked upsertUser/setUsername. Kept as an interface method
     * so callers (and a future bulk migrator, which would need to dedupe
     * in-memory before inserting rather than relying on this) have the same
     * on-demand cleanup path available on the SQLite driver. The suffixing
     * walk itself lives in shared.js's dedupeUsernameRows so the two drivers
     * can't drift on the -2/-3 convention; this method only owns the read
     * and writes.
     */
    async dedupeUsernames() {
      const rows = await all(
        'SELECT id, username, created_at FROM users WHERE username IS NOT NULL ORDER BY created_at ASC, id ASC',
      );
      const renames = await dedupeUsernameRows(rows);
      for (const { id, username } of renames) {
        // eslint-disable-next-line no-await-in-loop
        await run('UPDATE users SET username = $1 WHERE id = $2', [username, id]);
      }
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
      await run(`
        INSERT INTO minigame_sessions (id, user_id, game, started_at, finished_at, score)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [session.id, session.user_id, session.game, session.started_at, session.finished_at, session.score]);
      return session;
    },

    async getMinigameSession(id) {
      return one('SELECT * FROM minigame_sessions WHERE id = $1', [id]);
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
      return one(`
        SELECT * FROM minigame_sessions
        WHERE user_id = $1 AND game = $2 AND finished_at IS NULL AND started_at >= $3
        ORDER BY started_at DESC LIMIT 1
      `, [userId, game, minStartedAt]);
    },

    async finishMinigameSession(id, score) {
      await run('UPDATE minigame_sessions SET finished_at = $1, score = $2 WHERE id = $3', [Date.now(), score, id]);
    },

    /**
     * Best finished score per game for one player. Derived from the session
     * rows rather than stored on the save, so it is already populated with
     * every score the player has ever set.
     */
    async getMinigameBests(userId) {
      // MAX() returns numeric; coerce so both drivers return JS numbers.
      const rows = await all(`
        SELECT game, MAX(score) AS best
        FROM minigame_sessions
        WHERE user_id = $1 AND finished_at IS NOT NULL AND score IS NOT NULL
        GROUP BY game
      `, [userId]);
      return rows.map((r) => ({ game: r.game, best: Number(r.best) }));
    },

    /**
     * Returns the singleton config row (id=1): { id, version, data, updated_at,
     * updated_by }, or undefined if no config has been seeded yet. `data` is
     * returned as the raw JSON text exactly as stored - mirroring getSave's
     * convention, callers JSON.parse it themselves.
     */
    async getConfigRow() {
      return one('SELECT * FROM config WHERE id = 1');
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
      await run(`
        INSERT INTO config (id, version, data, updated_at, updated_by) VALUES (1, $1, $2, $3, $4)
        ON CONFLICT (id) DO UPDATE SET version = excluded.version, data = excluded.data,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by
      `, [version, text, now, userId]);
      await run(
        'INSERT INTO config_history (version, data, updated_at, updated_by) VALUES ($1, $2, $3, $4)',
        [version, text, now, userId],
      );
    },

    async getConfigHistory() {
      return all('SELECT * FROM config_history ORDER BY id DESC');
    },

    async listEvents() {
      return (await all('SELECT * FROM live_events ORDER BY created_at ASC, id ASC')).map(parseEventRow);
    },

    async getEvent(id) {
      return parseEventRow(await one('SELECT * FROM live_events WHERE id = $1', [id]));
    },

    /**
     * Returns the single event currently in status 'active', or undefined if
     * none is. Keeping at most one event active is an application-level
     * invariant enforced by the lifecycle/scheduler, not a DB constraint -
     * this just reads the first match.
     */
    async getActiveEvent() {
      return parseEventRow(await one("SELECT * FROM live_events WHERE status = 'active' LIMIT 1"));
    },

    /**
     * Insert-or-replace for a single event, keyed on `event.id`. On conflict,
     * `created_at` is intentionally left untouched (it's the original
     * creation time, not a "last written" timestamp) - everything else is
     * fully replaced.
     */
    async putEvent(event) {
      const row = normalizeEventRow(event);
      await run(`
        INSERT INTO live_events (id, name, description, theme, modifiers, ladder, status, starts_at, ends_at, recurrence, created_at, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name, description = excluded.description, theme = excluded.theme,
          modifiers = excluded.modifiers, ladder = excluded.ladder, status = excluded.status,
          starts_at = excluded.starts_at, ends_at = excluded.ends_at, recurrence = excluded.recurrence,
          created_by = excluded.created_by
      `, [
        row.id, row.name, row.description, row.theme, row.modifiers, row.ladder, row.status,
        row.starts_at, row.ends_at, row.recurrence, row.created_at, row.created_by,
      ]);
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
      const sets = ['status = $1'];
      const params = [status];
      if (startsAt !== undefined) { params.push(startsAt); sets.push(`starts_at = $${params.length}`); }
      if (endsAt !== undefined) { params.push(endsAt); sets.push(`ends_at = $${params.length}`); }
      params.push(id);
      await run(`UPDATE live_events SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    },

    /**
     * Deletes an event row outright. This module does not enforce "drafts
     * only" - the route layer is responsible for rejecting deletes of
     * scheduled/active/ended events before calling this.
     */
    async deleteEvent(id) {
      await run('DELETE FROM live_events WHERE id = $1', [id]);
    },

    /**
     * Insert-or-replace for one user's participation row in one event, keyed on
     * (user_id, event_id).
     */
    async upsertParticipation(row) {
      const params = normalizeParticipationRow(row);
      await run(`
        INSERT INTO event_participation (user_id, event_id, started_at, ends_at, rungs_claimed, last_progress_at, opted_out)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id, event_id) DO UPDATE SET
          started_at = excluded.started_at, ends_at = excluded.ends_at,
          rungs_claimed = excluded.rungs_claimed, last_progress_at = excluded.last_progress_at,
          opted_out = excluded.opted_out
      `, [
        params.user_id, params.event_id, params.started_at, params.ends_at,
        params.rungs_claimed, params.last_progress_at, params.opted_out,
      ]);
      return driver.getParticipation(params.user_id, params.event_id);
    },

    async getParticipation(userId, eventId) {
      return one('SELECT * FROM event_participation WHERE user_id = $1 AND event_id = $2', [userId, eventId]);
    },

    /**
     * Narrow, idempotent progress sync used by stateService.applyActions after a
     * successful claimEventRung. Deliberately NOT a call to upsertParticipation:
     * that function's ON CONFLICT clause overwrites every column, including
     * `opted_out` and `started_at`/`ends_at` - a caller here that doesn't have
     * (or doesn't want to re-fetch) the user's current opt-out flag would
     * silently un-opt-out them on every claim. A plain UPDATE touching only
     * `rungs_claimed`/`last_progress_at` leaves every other column alone, and is
     * a harmless no-op (0 rows affected, no throw) if the participation row
     * doesn't exist for some reason (e.g. the event was deleted out from under
     * an in-flight claim).
     */
    async updateParticipationProgress(userId, eventId, rungsClaimed, lastProgressAt) {
      await run(
        'UPDATE event_participation SET rungs_claimed = $1, last_progress_at = $2 WHERE user_id = $3 AND event_id = $4',
        [rungsClaimed, lastProgressAt, userId, eventId],
      );
    },

    /**
     * All participants in an event, ranked for the coordinator view / leaderboard:
     * most rungs claimed first, ties broken by whoever reached their current
     * progress earliest.
     */
    async listParticipation(eventId) {
      return all(
        'SELECT * FROM event_participation WHERE event_id = $1 ORDER BY rungs_claimed DESC, last_progress_at ASC',
        [eventId],
      );
    },

    async setLeaderboardOptOut(userId, optOut) {
      await run('UPDATE users SET leaderboard_opt_out = $1 WHERE id = $2', [optOut ? 1 : 0, userId]);
    },

    /**
     * Leaderboard rows for `eventId`, same ranking as listParticipation (most
     * rungs claimed first, ties broken by earliest last_progress_at), but -
     * unlike listParticipation - LEFT JOINed against `users` and filtered on
     * the LIVE `users.leaderboard_opt_out`, not the value snapshotted into
     * `event_participation.opted_out` at join time. That snapshot is written
     * once by joinEventIfEligible and never updated again, so a user who opts
     * out AFTER joining would otherwise keep appearing here.
     * PUT /api/me/leaderboard-opt-out writes straight to
     * `users.leaderboard_opt_out`, so this query picks up that change
     * immediately on the very next read - no re-sync step needed.
     * Capped at `limit` rows (default 50, per the route's leaderboard contract).
     *
     * Every camelCase alias MUST be double-quoted: Postgres folds unquoted
     * identifiers to lowercase, which would hand the client `userid` and
     * `rungsClaimed` would arrive as undefined.
     */
    async listLeaderboard(eventId, limit = 50) {
      return all(`
        SELECT ep.user_id AS "userId", u.username AS "username",
               ep.rungs_claimed AS "rungsClaimed", ep.last_progress_at AS "lastProgressAt"
        FROM event_participation ep
        LEFT JOIN users u ON u.id = ep.user_id
        WHERE ep.event_id = $1 AND COALESCE(u.leaderboard_opt_out, 0) = 0
        ORDER BY ep.rungs_claimed DESC, ep.last_progress_at ASC
        LIMIT $2
      `, [eventId, limit]);
    },

    /**
     * The most recently-STARTED event that has actually run (any status except
     * 'draft', which by definition has no window). Backs the v1.5 leaderboard's
     * latest-event board. Returns null when no event has ever been scheduled.
     */
    async getLatestEventId() {
      const row = await one(
        "SELECT id FROM live_events WHERE status != 'draft' AND starts_at IS NOT NULL ORDER BY starts_at DESC LIMIT 1",
      );
      return row ? row.id : null;
    },

    /**
     * Inserts each SEASONAL_EVENTS entry as status 'draft' with no window, but
     * only when that id isn't already present - ON CONFLICT DO NOTHING makes
     * this safe to call on every boot (idempotent) without ever clobbering an
     * admin-edited copy of a seeded event (e.g. a coordinator tweaked
     * summer-surge's modifiers or already scheduled it).
     */
    async seedSeasonalEvents() {
      const now = Date.now();
      for (const evt of SEASONAL_EVENTS) {
        await run(`
          INSERT INTO live_events (id, name, description, theme, modifiers, ladder, status,
                                   starts_at, ends_at, recurrence, created_at, created_by)
          VALUES ($1, $2, $3, $4, $5, $6, 'draft', NULL, NULL, $7, $8, NULL)
          ON CONFLICT (id) DO NOTHING
        `, [
          evt.id, evt.name, evt.description ?? null, JSON.stringify(evt.theme ?? null),
          JSON.stringify(evt.modifiers ?? []), JSON.stringify(evt.ladder ?? []),
          JSON.stringify(evt.recurrence ?? null), now,
        ]);
      }
    },
  };

  return driver;
}
