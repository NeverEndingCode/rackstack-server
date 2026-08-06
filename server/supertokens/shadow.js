// Shadow mode: the gate that has to read 100% before anyone cuts over.
//
// The whole release rests on one equality - that SuperTokens' `thirdPartyUserId`
// is the same string passport stored as `provider_id`. Task 3's implementation
// notes record that this has now been verified at the SOURCE level for both
// providers at their pinned versions, which is a real improvement on "assumed".
// It is still not sufficient, and this module exists because of the gap:
//
//   Reading the libraries tells you what they will write TOMORROW.
//   The rows in `identities` were written by whatever versions were installed
//   on the day each player first logged in, going back to v1.0.
//
// So the only evidence that actually settles it is the owner's production
// `identities` table. This module compares a real SuperTokens login against
// those real rows and reports what it finds.
//
// The failure this prevents is specific and unrecoverable: a mismatched id
// means a returning player is treated as brand new, silently lands on an empty
// save, and - if they play on it before anyone notices - cannot be given their
// old one back without a restore. There is no error and no log line at the
// moment it happens. Hence a gate, run before the switch, rather than
// monitoring afterwards.
//
// SAFETY: nothing in this file writes. It is designed to be run against
// production while players are logged in and playing, so it does not touch the
// caller's session, does not create users, and issues no statement other than
// the SELECT inside `getIdentity`. tests/supertokens.shadow.test.js asserts
// that by snapshotting the whole identities table around a run.

import {
  getIdentity as dbGetIdentity,
  getAllUsersWithSaves as dbGetAllUsersWithSaves,
  listIdentities as dbListIdentities,
} from '../db/index.js';

const defaultDb = {
  getIdentity: dbGetIdentity,
  getAllUsersWithSaves: dbGetAllUsersWithSaves,
  listIdentities: dbListIdentities,
};

/** The three things a comparison can conclude. */
export const SHADOW_MATCH = 'match';
export const SHADOW_MISMATCH = 'mismatch';
export const SHADOW_NO_IDENTITY = 'no-identity';

/**
 * Compares one completed SuperTokens third-party login against `identities`.
 *
 * Returns a plain result object; it never throws for a mismatch, because a
 * mismatch is a finding to be reported rather than an error to be handled.
 *
 * `no-identity` is NOT a failure. It is what a genuinely new player looks
 * like, and also what a player who has simply never logged in through this
 * provider looks like. Conflating it with `mismatch` would make the gate
 * unreadable on any server that has ever had a new signup - which is why the
 * summary below counts the three outcomes separately.
 */
export async function compareIdentity(
  { thirdPartyId, thirdPartyUserId },
  db = defaultDb,
) {
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

/** One line per login, so a tail of the logs during shadow mode is readable. */
export function formatResult(result) {
  const who = `${result.thirdPartyId}:${result.thirdPartyUserId}`;
  switch (result.outcome) {
    case SHADOW_MATCH:
      return `[shadow] MATCH ${who} -> ${result.actualUserId}`;
    case SHADOW_MISMATCH:
      return `[shadow] MISMATCH ${who} - SuperTokens implies '${result.expectedUserId}' `
        + `but identities has '${result.actualUserId}'. This player would land on the WRONG save.`;
    default:
      return `[shadow] NO-IDENTITY ${who} - no such row; this is a new player, not a failure.`;
  }
}

/**
 * Rolls a set of results into the number an operator makes the cutover
 * decision on.
 *
 * `passed` is true only when there is at least one comparison AND no
 * mismatches. The "at least one" clause is the important half: an empty run
 * has a 100% match rate by vacuous arithmetic, and a gate that reports PASS
 * because it compared nothing is worse than no gate at all - it manufactures
 * exactly the false confidence the gate exists to prevent. A run that compared
 * nothing has not been run.
 */
export function summarise(results) {
  const matched = results.filter((r) => r.outcome === SHADOW_MATCH);
  const mismatched = results.filter((r) => r.outcome === SHADOW_MISMATCH);
  const missing = results.filter((r) => r.outcome === SHADOW_NO_IDENTITY);

  return {
    total: results.length,
    matched: matched.length,
    mismatched: mismatched.length,
    noIdentity: missing.length,
    // Percentage of comparisons that had something to compare against.
    matchRate: matched.length + mismatched.length === 0
      ? null
      : matched.length / (matched.length + mismatched.length),
    mismatches: mismatched.map((r) => ({
      thirdPartyId: r.thirdPartyId,
      thirdPartyUserId: r.thirdPartyUserId,
      expectedUserId: r.expectedUserId,
      actualUserId: r.actualUserId,
    })),
    passed: results.length > 0 && mismatched.length === 0,
  };
}

/**
 * The summary an operator reads before deciding to cut over.
 *
 * Deliberately blunt. Anything other than a clean pass says so on its own
 * line, in words, with every mismatching pair named - a gate whose failure
 * has to be inferred from a percentage is a gate people talk themselves past
 * at the end of a long maintenance window.
 */
export function formatSummary(summary) {
  const lines = [
    '=== SuperTokens shadow-mode report ===',
    `logins compared:      ${summary.total}`,
    `matched:              ${summary.matched}`,
    `mismatched:           ${summary.mismatched}`,
    `no existing identity: ${summary.noIdentity} (new players - not failures)`,
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

  lines.push('');
  if (summary.passed) {
    lines.push('GATE: PASS - 100% of comparable logins matched. Cutover to AUTH_MODE=dual is cleared.');
  } else if (summary.total === 0) {
    lines.push(
      'GATE: NOT RUN - nothing was compared. This is not a pass. Run at least one '
      + 'real login through shadow mode before cutting over.',
    );
  } else {
    lines.push(
      `GATE: FAIL - ${summary.mismatched} mismatch(es). Do NOT cut over. `
      + 'Every mismatch is a player who would silently land on an empty save.',
    );
  }

  return lines.join('\n');
}

/**
 * Audits every identity row already in the database, without any login
 * happening at all.
 *
 * This is the form of the gate that can actually be run BEFORE cutover, and it
 * is the one the runbook tells the operator to use first. The live per-login
 * form below needs the SuperTokens stack to be reachable and someone to log in
 * through it — which is most of the thing the gate is supposed to clear — so on
 * its own it would be a gate you can only open after walking through the door.
 *
 * It works because the residual risk is entirely on one side. The equality this
 * release rests on has two halves:
 *
 *   1. What SuperTokens will compute for `thirdPartyUserId`. Verified at the
 *      source level for both providers at their pinned versions (design §5.3).
 *   2. What is actually stored in `identities.provider_id`, written by whatever
 *      library versions were installed on the day each player first logged in.
 *
 * Only (2) is unverifiable by reading code, and (2) is exactly what this reads.
 * For every row it asks the one question that matters: does `user_id` equal
 * `provider:provider_id`? If that holds for 100% of rows, then any login whose
 * `thirdPartyUserId` matches `provider_id` resolves to the right save.
 *
 * Enumerates through `getAllUsersWithSaves` + `listIdentities` rather than a
 * new "list every identity" interface function, so it needs no schema or
 * interface change and runs against a plain restored export.
 *
 * Read-only, like everything else here.
 */
export async function auditStoredIdentities({ db = defaultDb, log = () => {} } = {}) {
  const users = await db.getAllUsersWithSaves();
  const results = [];

  for (const user of users) {
    // eslint-disable-next-line no-await-in-loop
    const identities = await db.listIdentities(user.id);
    for (const identity of identities) {
      const expectedUserId = `${identity.provider}:${identity.provider_id}`;
      const result = {
        outcome: identity.user_id === expectedUserId ? SHADOW_MATCH : SHADOW_MISMATCH,
        thirdPartyId: identity.provider,
        thirdPartyUserId: identity.provider_id,
        expectedUserId,
        actualUserId: identity.user_id,
      };
      results.push(result);
      log(formatResult(result));
    }
  }

  return results;
}

/**
 * Collects shadow results across a run.
 *
 * Kept as an explicit collector rather than module-level state so two runs
 * cannot contaminate each other, and so a caller can hold one per operator
 * session.
 */
export function createShadowRun({ db = defaultDb, log = console.log } = {}) {
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
