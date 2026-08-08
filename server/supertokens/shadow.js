// Shadow mode: the gate that has to read 100% before anyone cuts over.
//
// The whole release rests on one equality - that SuperTokens' `thirdPartyUserId`
// is the same string passport stored as `provider_id`. That has two halves, and
// only one can be checked by reading code:
//
//   1. What SuperTokens WILL compute. Verified at the source level for both
//      providers at their pinned versions (design section 5.3).
//   2. What is ALREADY STORED in `identities`. Those rows were written by
//      whatever library versions were installed the day each player first
//      logged in, going back to v1.0. No amount of reading today's libraries
//      settles it.
//
// This module reads half 2.
//
// The failure it prevents is specific and unrecoverable: a mismatched id means
// a returning player is treated as brand new, silently lands on an empty save,
// and - if they play on it before anyone notices - cannot be given their old
// one back without a restore. There is no error and no log line at the moment
// it happens. Hence a gate, run before the switch, rather than monitoring
// afterwards.
//
// SAFETY: nothing here writes, and - since the v1.8 final review - nothing here
// can write. The audit no longer goes through `server/db/index.js`, because
// importing that facade builds a driver, and building a driver runs
// `applySchema`, which on SQLite renames colliding usernames and rebuilds the
// `users` table. The tool advertised as safe to point at production was
// migrating it. See the read-only reader contract below and
// `server/supertokens/shadowCheck.js`, which supplies it.

/** The outcomes a comparison can reach. */
export const SHADOW_MATCH = 'match';
export const SHADOW_MISMATCH = 'mismatch';
export const SHADOW_NO_IDENTITY = 'no-identity';
export const SHADOW_ORPHAN = 'orphan';

/**
 * Compares one completed SuperTokens third-party login against a stored
 * identity, for the LIVE per-login check (createShadowRun, runbook part C4).
 *
 * Returns a plain result object; a mismatch is a finding to be reported, not an
 * error to be thrown.
 *
 * `no-identity` is NOT a failure. It is what a genuinely new player looks like.
 * Conflating it with `mismatch` would make the gate unreadable on any server
 * that has ever had a signup - which is why every outcome is counted
 * separately, and why `summarise` excludes it from the rate entirely.
 */
export async function compareIdentity({ thirdPartyId, thirdPartyUserId }, db) {
  const expectedUserId = `${thirdPartyId}:${thirdPartyUserId}`;
  const identity = await db.getIdentity(thirdPartyId, thirdPartyUserId);

  if (!identity) {
    return {
      outcome: SHADOW_NO_IDENTITY,
      thirdPartyId,
      thirdPartyUserId,
      expectedUserId,
      actualUserId: null,
    };
  }

  return {
    outcome: identity.user_id === expectedUserId ? SHADOW_MATCH : SHADOW_MISMATCH,
    thirdPartyId,
    thirdPartyUserId,
    expectedUserId,
    actualUserId: identity.user_id,
  };
}

/** Classifies one stored identity row. Pure; shared by both entry points. */
export function classifyIdentityRow({ provider, provider_id: providerId, user_id: userId, user_exists: userExists }) {
  const expectedUserId = `${provider}:${providerId}`;
  let outcome;
  if (!userExists) {
    // A login method pointing at an account that does not exist. The player can
    // never log in: resolveExternalUserId hands back a users.id with no row,
    // and requireAuth then refuses the session. Precisely the corruption class
    // this gate exists to surface, and it was invisible to the audit until the
    // final review - the old enumeration walked users -> identities, so a row
    // unreachable from `users` could not be visited at all.
    outcome = SHADOW_ORPHAN;
  } else if (userId === expectedUserId) {
    outcome = SHADOW_MATCH;
  } else {
    outcome = SHADOW_MISMATCH;
  }
  return {
    outcome, thirdPartyId: provider, thirdPartyUserId: providerId, expectedUserId, actualUserId: userId,
  };
}

/**
 * Audits every identity row already stored, without any login happening.
 *
 * This is the form of the gate that can actually be run BEFORE cutover, and the
 * one the runbook tells the operator to use. The live per-login form below
 * needs the SuperTokens stack reachable and someone to log in through it -
 * which is most of what the gate is meant to clear, i.e. a gate you can only
 * open after walking through the door.
 *
 * `readAllIdentities` is injected rather than imported, and that is a safety
 * boundary rather than a testing convenience: this module must not be able to
 * reach a connection that runs migrations. The caller supplies a read-only
 * reader returning rows of
 * `{ provider, provider_id, user_id, user_exists }` - see shadowCheck.js.
 */
export async function auditStoredIdentities({ readAllIdentities, log = () => {} }) {
  const rows = await readAllIdentities();
  const results = rows.map(classifyIdentityRow);
  for (const result of results) log(formatResult(result));
  return results;
}

/** One line per row/login, so tailing the log during a run is readable. */
export function formatResult(result) {
  const who = `${result.thirdPartyId}:${result.thirdPartyUserId}`;
  switch (result.outcome) {
    case SHADOW_MATCH:
      return `[shadow] MATCH ${who} -> ${result.actualUserId}`;
    case SHADOW_MISMATCH:
      return `[shadow] MISMATCH ${who} - SuperTokens implies '${result.expectedUserId}' `
        + `but identities has '${result.actualUserId}'. This player would land on the WRONG save.`;
    case SHADOW_ORPHAN:
      return `[shadow] ORPHAN ${who} - points at user '${result.actualUserId}', which does not exist. `
        + 'This player cannot log in at all.';
    default:
      return `[shadow] NO-IDENTITY ${who} - no such row; this is a new player, not a failure.`;
  }
}

/**
 * Rolls results into the number the cutover decision is made on.
 *
 * `passed` requires at least one COMPARABLE result and no failures. "Comparable"
 * excludes `no-identity`, and that distinction is the whole point: gating on the
 * total instead let a run of nothing but new players report
 * "100% of comparable logins matched" having compared none of them - the exact
 * vacuous pass this function's own contract exists to prevent, found by the
 * v1.8 final review.
 *
 * Orphans count as failures, not curiosities. A player who cannot log in is not
 * a passing state.
 */
export function summarise(results) {
  const matched = results.filter((r) => r.outcome === SHADOW_MATCH);
  const mismatched = results.filter((r) => r.outcome === SHADOW_MISMATCH);
  const orphaned = results.filter((r) => r.outcome === SHADOW_ORPHAN);
  const missing = results.filter((r) => r.outcome === SHADOW_NO_IDENTITY);

  const comparable = matched.length + mismatched.length + orphaned.length;

  return {
    total: results.length,
    matched: matched.length,
    mismatched: mismatched.length,
    orphaned: orphaned.length,
    noIdentity: missing.length,
    comparable,
    matchRate: comparable === 0 ? null : matched.length / comparable,
    mismatches: mismatched.map(pickPair),
    orphans: orphaned.map(pickPair),
    passed: comparable > 0 && mismatched.length === 0 && orphaned.length === 0,
  };
}

function pickPair(r) {
  return {
    thirdPartyId: r.thirdPartyId,
    thirdPartyUserId: r.thirdPartyUserId,
    expectedUserId: r.expectedUserId,
    actualUserId: r.actualUserId,
  };
}

/**
 * The report an operator reads before deciding to cut over.
 *
 * Deliberately blunt. Anything other than a clean pass says so on its own line,
 * in words, with every offending pair named - a gate whose failure has to be
 * inferred from a percentage is a gate people talk themselves past at the end
 * of a long maintenance window.
 */
export function formatSummary(summary) {
  const lines = [
    '=== SuperTokens shadow-mode report ===',
    `identities compared:  ${summary.comparable}`,
    `matched:              ${summary.matched}`,
    `mismatched:           ${summary.mismatched}`,
    `orphaned:             ${summary.orphaned} (identity points at a missing user)`,
    `no existing identity: ${summary.noIdentity} (new players - not failures, not compared)`,
  ];

  if (summary.matchRate !== null) {
    lines.push(`match rate:           ${(summary.matchRate * 100).toFixed(2)}%`);
  }

  if (summary.mismatches.length > 0) {
    lines.push('', 'MISMATCHES - these players would land on the wrong save:');
    for (const m of summary.mismatches) {
      lines.push(
        `  ${m.thirdPartyId}:${m.thirdPartyUserId} - SuperTokens implies `
        + `'${m.expectedUserId}', identities has '${m.actualUserId}'`,
      );
    }
  }

  if (summary.orphans.length > 0) {
    lines.push('', 'ORPHANS - these players cannot log in at all:');
    for (const o of summary.orphans) {
      lines.push(`  ${o.thirdPartyId}:${o.thirdPartyUserId} - points at missing user '${o.actualUserId}'`);
    }
  }

  lines.push('');
  if (summary.passed) {
    lines.push('GATE: PASS - 100% of comparable identities matched. Cutover to AUTH_MODE=dual is cleared.');
  } else if (summary.comparable === 0) {
    lines.push(
      'GATE: NOT RUN - nothing comparable was found. This is not a pass. Check that '
      + 'DATABASE_URL / DB_PATH point at the database you meant to audit.',
    );
  } else {
    const failures = summary.mismatched + summary.orphaned;
    lines.push(
      `GATE: FAIL - ${failures} problem(s). Do NOT cut over. Every one is a player who `
      + 'would land on the wrong save or be unable to log in.',
    );
  }

  return lines.join('\n');
}

/**
 * Collects results for the LIVE per-login check (runbook part C4).
 *
 * Optional belt-and-braces once `dual` is on. It cannot be the gate - it needs
 * the SuperTokens stack reachable and someone logging in through it. The
 * offline audit above is the gate.
 *
 * An explicit collector rather than module state, so two runs cannot
 * contaminate each other.
 */
export function createShadowRun({ db, log = console.log } = {}) {
  const results = [];

  return {
    results,

    /** Compare one login. Read-only; safe to call on a live server. */
    async record(input) {
      const result = await compareIdentity(input, db);
      results.push(result);
      log(formatResult(result));
      return result;
    },

    summary() {
      return summarise(results);
    },

    report() {
      return formatSummary(summarise(results));
    },
  };
}
