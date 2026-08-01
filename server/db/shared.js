// Dialect-free helpers shared by every driver (SQLite, Postgres, ...). None of
// this file touches SQL - it's pure JS logic that must behave identically
// regardless of which driver calls it, so it lives here once instead of
// being duplicated (and risking drift) per driver.

/**
 * Returns a username derived from `desiredName` that `isTaken` reports as
 * free, suffixing `-2`, `-3`, ... until one is. `desiredName` itself is
 * returned unchanged if it's already free. Shared by dedupeUsernames (bulk
 * cleanup, checks an in-memory Set) and upsertUser (per-insert retry,
 * checks the DB) so both use the same suffixing convention against the
 * same COLLATE NOCASE uniqueness rule.
 *
 * `isTaken` may be sync (SQLite, backed by a synchronous better-sqlite3
 * call or an in-memory Set) or async (Postgres, backed by a query) - it is
 * always awaited here, which is harmless when the value isn't a promise, so
 * one implementation serves both drivers.
 */
export async function findAvailableUsername(desiredName, isTaken) {
  if (!(await isTaken(desiredName))) return desiredName;
  let n = 2;
  let candidate = `${desiredName}-${n}`;
  while (await isTaken(candidate)) {
    n += 1;
    candidate = `${desiredName}-${n}`;
  }
  return candidate;
}

/**
 * The bulk-cleanup half of dedupeUsernames, factored out so both drivers
 * share one implementation of the suffixing walk instead of each carrying
 * its own copy that has to be kept in lockstep by hand. Takes `rows` (every
 * user with a non-null username, already ordered earliest-created first -
 * `ORDER BY created_at ASC, id ASC` on both backends, so the earliest holder
 * of a name is never the one renamed) and returns the subset that need to
 * change: `[{ id, username }]`, each `username` already run through
 * findAvailableUsername against an in-memory Set of names claimed so far.
 * Callers write these back (an UPDATE per entry) and leave every other row
 * untouched; the read (SELECT ... ORDER BY) and the writes stay
 * driver-specific since they're plain SQL, not dialect-free logic.
 */
export async function dedupeUsernameRows(rows) {
  const taken = new Set();
  const renames = [];
  for (const row of rows) {
    const lower = row.username.toLowerCase();
    if (!taken.has(lower)) {
      taken.add(lower);
      continue;
    }
    const candidate = await findAvailableUsername(row.username, (name) => taken.has(name.toLowerCase()));
    renames.push({ id: row.id, username: candidate });
    taken.add(candidate.toLowerCase());
  }
  return renames;
}

// --- Live Events (v1.4) -----------------------------------------------
//
// Unlike getSave/getConfigRow (which hand back their JSON columns as raw
// text and let the caller JSON.parse), the event getters parse `theme`,
// `modifiers`, `ladder`, and `recurrence` before returning. That's a
// deliberate departure from the rest of this module's convention: every
// caller of these getters (route layer, scheduler, reducer-side effective
// config merge) needs the structured value, never the raw text, so parsing
// once here avoids repeating (and re-risking) JSON.parse at every call site.

export function parseEventRow(row) {
  if (!row) return row;
  return {
    ...row,
    theme: JSON.parse(row.theme ?? 'null'),
    modifiers: JSON.parse(row.modifiers),
    ladder: JSON.parse(row.ladder),
    recurrence: JSON.parse(row.recurrence ?? 'null'),
  };
}

/**
 * Normalizes a putEvent() argument into the flat, snake_case, JSON-stringified
 * row shape every driver writes to storage. Accepts either camelCase
 * (startsAt/createdAt/createdBy) or snake_case (starts_at/created_at/
 * created_by) keys for the non-JSON fields, since callers may pass back a row
 * previously read via getEvent (snake_case) or freshly authored data
 * (camelCase). On conflict, `created_at` is intentionally left to the
 * caller-supplied value (or "now" if absent) - drivers decide whether to
 * honor or ignore it on update.
 */
export function normalizeEventRow(event) {
  return {
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
}

/**
 * Normalizes an upsertParticipation() argument into the flat, snake_case row
 * shape every driver writes to storage. Accepts camelCase or snake_case
 * keys, same rationale as normalizeEventRow.
 */
export function normalizeParticipationRow(row) {
  return {
    user_id: row.userId ?? row.user_id,
    event_id: row.eventId ?? row.event_id,
    started_at: row.startedAt ?? row.started_at,
    ends_at: row.endsAt ?? row.ends_at,
    rungs_claimed: row.rungsClaimed ?? row.rungs_claimed ?? 0,
    last_progress_at: row.lastProgressAt ?? row.last_progress_at ?? null,
    opted_out: (row.optedOut ?? row.opted_out) ? 1 : 0,
  };
}
