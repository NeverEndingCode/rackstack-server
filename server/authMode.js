// The strangler switch for the v1.8 SuperTokens rollout.
//
// v1.8 introduces a second authentication stack alongside the passport + JWT
// one that ships today. Rather than swap them in one step, AUTH_MODE runs
// them in sequence:
//
//   passport     - exactly today. SuperTokens is not initialised, its
//                  middleware is not mounted, and supertokens-node is never
//                  even imported. This is the default, so upgrading to v1.8
//                  changes nothing about how anyone logs in.
//   dual         - both login paths live; a session from either is accepted.
//                  This is where the rollout actually happens, and where
//                  legacy 90-day JWT cookies keep working untouched.
//   supertokens  - the passport OAuth routes are no longer registered.
//
// Rollback in every direction is setting this back and restarting: legacy JWT
// cookies remain valid for their full 90-day expiry, so in-flight sessions
// survive the round trip and nobody is forced to log in again.
//
// See docs/superpowers/specs/2026-08-01-postgres-supertokens-design.md section 5.2.

export const AUTH_MODES = Object.freeze(['passport', 'dual', 'supertokens']);

export const DEFAULT_AUTH_MODE = 'passport';

/**
 * Resolves AUTH_MODE from an environment object.
 *
 * Unset, or set to nothing but whitespace, means the default - an operator
 * blanking the field in the Unraid UI is choosing the legacy stack, which is
 * the documented rollback, so it must land on `passport` rather than on an
 * error.
 *
 * Anything else that isn't one of the three valid values THROWS, and does so
 * at boot. Falling back to a default here would be worse than useless: a
 * typo'd `AUTH_MODE=supertoken` would quietly serve the legacy stack while
 * the operator believed the rollout had happened, and the first sign of
 * trouble would be discovering weeks later that the migration never took
 * effect. A container that refuses to start gets investigated immediately.
 *
 * Matching is exact and lowercase. `Passport` is rejected rather than
 * silently accepted, because being lenient here means the value in the
 * operator's config and the value in the logs can differ, and that is a
 * miserable thing to debug during a rollout.
 */
export function resolveAuthMode(env = process.env) {
  const raw = env.AUTH_MODE;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return DEFAULT_AUTH_MODE;
  }

  const value = String(raw).trim();
  if (AUTH_MODES.includes(value)) return value;

  const hint = AUTH_MODES.includes(value.toLowerCase())
    ? ` Did you mean '${value.toLowerCase()}'? Values are case-sensitive.`
    : '';
  throw new Error(
    `Invalid AUTH_MODE '${value}'. Valid values are: ${AUTH_MODES.join(', ')}.${hint}`,
  );
}

/** True when this mode initialises SuperTokens and mounts its middleware. */
export function isSuperTokensEnabled(mode) {
  return mode === 'dual' || mode === 'supertokens';
}

/** True when this mode registers the passport OAuth routes. */
export function isPassportEnabled(mode) {
  return mode === 'passport' || mode === 'dual';
}
