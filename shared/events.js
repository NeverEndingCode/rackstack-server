// Shared, pure event model for Live Events (v1.4).
//
// Zero runtime dependencies outside shared/ — consumed identically by the
// server (authoritative validation) and the client (progress rendering).

import { DEFAULT_CONFIG, TUNABLES, setAtPath, validateConfig } from './configSchema.js';

// EVENT_METRICS is built with Object.create(null) (no Object.prototype in its
// chain) and every lookup is additionally guarded with hasOwnProperty. This
// mirrors the hardening applied to shared/reducer.js's HANDLERS table, which
// closed a prototype-pollution-via-property-lookup bug: a user-supplied key
// like '__proto__' or 'toString' must never resolve to an inherited value.
export const EVENT_METRICS = Object.assign(Object.create(null), {
  flopsEarned: (meta) => meta.stats.lifetimeFlopsAllTime,
  minigamesWon: (meta) => meta.stats.minigamesWon,
  blocksClaimed: (meta) => meta.stats.blocksClaimedLifetime,
  tapesEarned: (meta) => meta.stats.tapesEarnedLifetime,
  wafersEarned: (meta) => meta.stats.totalWafersEarned,
});

export const EVENT_METRIC_IDS = Object.keys(EVENT_METRICS);

export function eventMetricValue(metricId, meta) {
  if (typeof metricId !== 'string' || metricId === '') return null;
  if (!Object.prototype.hasOwnProperty.call(EVENT_METRICS, metricId)) return null;
  const extractor = EVENT_METRICS[metricId];
  if (typeof extractor !== 'function') return null;
  try {
    const v = extractor(meta);
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

// Known-safe leaf paths a modifier is allowed to touch. Computed once at
// module scope so both mergeEventModifiers and validateModifiers share the
// exact same allowlist.
const TUNABLE_PATHS = new Set(TUNABLES.map((t) => t.path));

// mergeEventModifiers MUST be safe to call with untrusted/unvalidated
// modifiers on its own — do not rely on "callers already ran
// validateModifiers first". This function sits on a hot per-request read
// path (getEffectiveConfig, Task 4), so it skips bad entries rather than
// throwing; validateModifiers is the place authoring errors surface loudly,
// at write time.
//
// The `TUNABLE_PATHS.has(mod.path)` check below is not optional: setAtPath
// (configSchema.js) walks path.split('.') and assigns via `cur[k] = ...`
// with no own-key guard, so an unvalidated path like '__proto__.polluted'
// or 'constructor.prototype.polluted' reaches Object.prototype and corrupts
// it for the entire running process — not just the merged config, every
// request the server handles afterward. Do not "simplify" this guard away;
// see the regression tests in tests/events.test.js.
export function mergeEventModifiers(baseConfig, modifiers) {
  const out = structuredClone(baseConfig);
  if (!Array.isArray(modifiers)) return out;
  for (const mod of modifiers) {
    if (!mod || typeof mod.path !== 'string') continue;
    if (!TUNABLE_PATHS.has(mod.path)) continue;
    setAtPath(out, mod.path, mod.value);
  }
  return out;
}

export function validateModifiers(modifiers) {
  const errors = [];
  if (!Array.isArray(modifiers)) return { ok: false, errors: ['modifiers must be an array'] };
  for (const mod of modifiers) {
    if (!mod || typeof mod !== 'object') { errors.push('modifier must be an object'); continue; }
    const { path, value } = mod;
    if (typeof path !== 'string' || !TUNABLE_PATHS.has(path)) {
      errors.push(`unknown modifier path: ${path}`);
      continue;
    }
    if (typeof value !== 'number' || Number.isNaN(value)) {
      errors.push(`${path}: value must be a number`);
    }
  }
  if (errors.length) return { ok: false, errors };

  const merged = mergeEventModifiers(DEFAULT_CONFIG, modifiers);
  const result = validateConfig(merged);
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true };
}

const MAX_LADDER_RUNGS = 20;
const REWARD_KEYS = ['wafers', 'tapes', 'flops'];

export function validateLadder(ladder) {
  const errors = [];
  if (!Array.isArray(ladder) || ladder.length < 1 || ladder.length > MAX_LADDER_RUNGS) {
    return { ok: false, errors: [`ladder must have 1-${MAX_LADDER_RUNGS} rungs`] };
  }

  const lastTargetByMetric = Object.create(null);

  ladder.forEach((rung, i) => {
    if (!rung || typeof rung !== 'object') { errors.push(`rung ${i}: not an object`); return; }
    const { metric, target, reward } = rung;

    if (typeof metric !== 'string' || !Object.prototype.hasOwnProperty.call(EVENT_METRICS, metric)) {
      errors.push(`rung ${i}: unknown metric ${metric}`);
    }
    if (typeof target !== 'number' || !Number.isFinite(target) || target <= 0) {
      errors.push(`rung ${i}: target must be a positive finite number`);
    }
    if (!reward || typeof reward !== 'object') {
      errors.push(`rung ${i}: reward must be an object`);
    } else {
      const presentKeys = REWARD_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(reward, k));
      if (presentKeys.length === 0) errors.push(`rung ${i}: reward must have at least one of ${REWARD_KEYS.join(', ')}`);
      for (const k of presentKeys) {
        const v = reward[k];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
          errors.push(`rung ${i}: reward.${k} must be a non-negative finite number`);
        }
      }
    }

    if (typeof metric === 'string' && Object.prototype.hasOwnProperty.call(EVENT_METRICS, metric)
        && typeof target === 'number' && Number.isFinite(target)) {
      const prev = Object.prototype.hasOwnProperty.call(lastTargetByMetric, metric) ? lastTargetByMetric[metric] : -Infinity;
      if (target <= prev) errors.push(`rung ${i}: target must strictly increase within metric ${metric}`);
      lastTargetByMetric[metric] = target;
    }
  });

  return errors.length ? { ok: false, errors } : { ok: true };
}

export function rungProgress(rung, meta, baseline) {
  const value = eventMetricValue(rung.metric, meta) ?? 0;
  const hasBaseline = baseline && typeof rung.metric === 'string'
    && Object.prototype.hasOwnProperty.call(baseline, rung.metric);
  const base = hasBaseline ? baseline[rung.metric] : 0;
  const current = Math.max(0, value - (typeof base === 'number' ? base : 0));
  return { current, target: rung.target, met: current >= rung.target };
}
