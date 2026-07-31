import { DEFAULT_CONFIG, validateConfig, upgradeConfig } from '../shared/configSchema.js';
import { mergeEventModifiers } from '../shared/events.js';
import { getConfigRow, putConfigRow, getConfigHistory, getActiveEvent } from './db.js';

// In-process cache of the active { version, data }. Invalidated (set to
// null) whenever we write a new version, and lazily rebuilt from the DB on
// next read - see getConfig().
let cache = null;

// Separate cache for getEffectiveConfig() below - deliberately NOT the same
// `cache` as above. `cache`/getConfig() must always hand back the admin-
// authored baseline untouched (that's what the Balancing tab reads and
// writes); the effective (event-overlaid) view is a read-time derivative
// that must never be persisted or allowed to leak back into `cache`. Keyed
// on (version, eventId) so a config write OR an event
// activation/deactivation (either bumps one half of the key) transparently
// invalidates it - invalidateEffectiveConfig() below is an additional,
// explicit invalidation hook for eventService.js to call at those moments,
// per the Task 4 interface contract.
let effectiveCache = null;

/**
 * Boot-seed / self-heal the singleton config row.
 *  - No row yet: seed it from DEFAULT_CONFIG at version 1.
 *  - Row exists: run it through upgradeConfig (fills in any tunables added
 *    to the schema since this row was written) and validateConfig. Per the
 *    Task 2 review finding, upgradeConfig does NOT range-check preserved
 *    values, so a stored value that's since become out-of-range would
 *    otherwise slip through - we validate the upgraded doc and fall back to
 *    DEFAULT_CONFIG entirely (logging a warning) if it still fails.
 *  - If the upgrade/fallback produced a document different from what's
 *    stored, persist it as a new version (audit trail via config_history)
 *    so the drift is visible, not silent.
 */
export function ensureConfig() {
  const row = getConfigRow();

  if (!row) {
    putConfigRow(1, DEFAULT_CONFIG, null);
    cache = { version: 1, data: structuredClone(DEFAULT_CONFIG) };
    return cache;
  }

  let raw = null;
  try {
    raw = JSON.parse(row.data);
  } catch (e) {
    raw = null;
  }

  let data = upgradeConfig(raw);
  const check = validateConfig(data);
  if (!check.ok) {
    console.warn(
      '[configService] stored config failed validation after upgrade; reverting to defaults:',
      check.errors,
    );
    data = structuredClone(DEFAULT_CONFIG);
  }

  const changed = JSON.stringify(data) !== JSON.stringify(raw);
  if (changed) {
    const nextVersion = row.version + 1;
    putConfigRow(nextVersion, data, row.updated_by || null);
    cache = { version: nextVersion, data };
  } else {
    cache = { version: row.version, data };
  }
  return cache;
}

/** Cached { version, data }. Lazily calls ensureConfig() on first access. */
export function getConfig() {
  if (!cache) return ensureConfig();
  return cache;
}

/**
 * Explicitly drops the getEffectiveConfig() cache. eventService.js calls
 * this on activateEvent/endEvent so the next read picks up the new active
 * event immediately, without waiting on the (version, eventId) key to
 * naturally diverge. Safe to call at any time - getEffectiveConfig()
 * rebuilds lazily.
 */
export function invalidateEffectiveConfig() {
  effectiveCache = null;
}

/**
 * Read-time overlay: the admin-authored baseline (getConfig()) with the
 * currently active live event's `modifiers` merged on top, per spec §5.1/
 * §5.2. Returns `{ version, data, eventId }` - `eventId` is null when
 * nothing is active, in which case `data` IS `getConfig().data` (same
 * object, not cloned - no event means no overlay to apply).
 *
 * mergeEventModifiers (shared/events.js) structuredClone()s the base config
 * before touching anything, so the admin baseline held in `cache` above -
 * and the row in the `config` table - are never mutated by this function,
 * no matter what an event's modifiers contain. This is load-bearing: Task 9's
 * e2e asserts GET /api/config still reflects the un-overlaid baseline while
 * an event is active.
 *
 * When an event is active, the merged document also gets a non-tunable
 * `__activeEvent = { id, ladder, endsAt }` runtime field attached (Task 5's
 * claimEventRung reducer action reads it off `config.__activeEvent` to find
 * the ladder, since the ladder itself lives in the DB, not in state).
 * `__activeEvent` is attached to the CLONE returned here, after
 * mergeEventModifiers has already run - validateConfig() never sees it, and
 * it must never be written back to the config table.
 */
export function getEffectiveConfig() {
  const { version, data } = getConfig();
  const activeEvent = getActiveEvent();
  const eventId = activeEvent ? activeEvent.id : null;

  if (effectiveCache && effectiveCache.version === version && effectiveCache.eventId === eventId) {
    return effectiveCache;
  }

  let effectiveData = data;
  if (activeEvent) {
    effectiveData = mergeEventModifiers(data, activeEvent.modifiers);
    effectiveData.__activeEvent = { id: activeEvent.id, ladder: activeEvent.ladder, endsAt: activeEvent.ends_at };
  }

  effectiveCache = { version, eventId, data: effectiveData };
  return effectiveCache;
}

/**
 * Validates and stores a brand-new config document as the next version.
 * Returns { ok: true, version } or { ok: false, errors }.
 */
export function updateConfig(data, userId) {
  const check = validateConfig(data);
  if (!check.ok) return { ok: false, errors: check.errors };

  const current = getConfig();
  const nextVersion = current.version + 1;
  putConfigRow(nextVersion, data, userId ?? null);
  cache = { version: nextVersion, data: structuredClone(data) };
  return { ok: true, version: nextVersion };
}

/**
 * Re-applies a prior version's document as the newest version (rollback is
 * itself forward motion in the version counter, never a version rewind -
 * keeps config_history a true append-only audit log).
 */
export function rollbackConfig(version, userId) {
  const history = getConfigHistory();
  const found = history.find((h) => h.version === version);
  if (!found) return { ok: false, error: 'not_found' };

  let data;
  try {
    data = JSON.parse(found.data);
  } catch (e) {
    return { ok: false, error: 'corrupt' };
  }

  const check = validateConfig(data);
  if (!check.ok) return { ok: false, errors: check.errors };

  const current = getConfig();
  const nextVersion = current.version + 1;
  putConfigRow(nextVersion, data, userId ?? null);
  cache = { version: nextVersion, data: structuredClone(data) };
  return { ok: true, version: nextVersion };
}

export function getHistory() {
  return getConfigHistory().map((h) => ({
    version: h.version,
    data: JSON.parse(h.data),
    updatedAt: h.updated_at,
    updatedBy: h.updated_by,
  }));
}
