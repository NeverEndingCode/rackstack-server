import { DEFAULT_CONFIG, validateConfig, upgradeConfig } from '../shared/configSchema.js';
import { getConfigRow, putConfigRow, getConfigHistory } from './db.js';

// In-process cache of the active { version, data }. Invalidated (set to
// null) whenever we write a new version, and lazily rebuilt from the DB on
// next read - see getConfig().
let cache = null;

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
