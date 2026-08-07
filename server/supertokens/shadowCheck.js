#!/usr/bin/env node
// Operator entry point for the shadow-mode gate: `npm run shadow:check`.
//
// Audits every identity row in whichever database the usual environment
// variables point at (DATABASE_URL for Postgres, DB_PATH for SQLite) and prints
// the report the cutover decision is made from.
//
// READ-ONLY, AND STRUCTURALLY SO. This file deliberately does NOT import
// `server/db/index.js`, and must never be changed to. That facade resolves a
// driver at module-evaluation time, and both drivers run `applySchema` before
// returning - which on SQLite sets `journal_mode = WAL`, runs `dedupeUsernames`
// (an `UPDATE users SET username`, renaming case-colliding accounts) and
// `migrateIdentities` (a full `users` table rebuild with foreign keys off).
//
// So the previous version of this script, whose banner promised it issued
// "nothing but SELECTs", silently migrated and rewrote any database it was
// pointed at - and the damage landed hardest in the documented primary use,
// auditing a restored pre-v1.7 export, because a healthy v1.8 database mostly
// no-ops. Found by the v1.8 final review, which ran it against an export and
// watched a user get renamed before it printed GATE: PASS.
//
// Hence: our own connection, opened read-only, one SELECT, no schema code on
// the path at all. The same reason the audit takes its reader by injection -
// `shadow.js` cannot reach a migrating connection even by accident.
//
// Exit code is the machine-readable gate: 0 only on a clean pass. Non-zero on
// "nothing comparable was found" is deliberate - an empty run is not a pass,
// and a script that exited 0 on it would quietly bless a cutover against a
// database it never read.

import { auditStoredIdentities, summarise, formatSummary } from './shadow.js';
import { resolveSqlitePath } from '../db/shared.js';

// One statement, valid on both dialects. The LEFT JOIN is what surfaces an
// identity row whose user_id points at nothing: enumerating users and asking
// for each one's identities - the pre-review approach - could not see such a
// row at all, because it is unreachable from `users`.
const AUDIT_SQL = `
  SELECT i.provider, i.provider_id, i.user_id,
         CASE WHEN u.id IS NULL THEN 0 ELSE 1 END AS user_exists
    FROM identities i
    LEFT JOIN users u ON u.id = i.user_id
   ORDER BY i.provider, i.provider_id
`;

/**
 * Opens a read-only Postgres reader.
 *
 * The connection is put in an explicitly READ ONLY transaction rather than
 * merely being trusted to issue a SELECT: it makes the guarantee the database
 * enforces rather than something a future edit could quietly break.
 */
// A database with no `identities` table predates the v1.7 split, so there is
// nothing for this gate to audit. Worth its own message: the runbook sends
// operators here with "a restored export", and restoring the WRONG (pre-v1.7)
// export is an easy mistake whose natural symptom would otherwise be a raw
// "no such table" from deep inside a SELECT.
const NO_IDENTITIES_TABLE = new Error(
  'This database has no `identities` table, so it predates the v1.7 auth split and there '
  + 'is nothing to audit. Point DB_PATH / DATABASE_URL at a v1.7-or-later database - if this '
  + 'is a production export, migrate it to v1.7 first (see docs/postgres-migration-runbook.md).',
);

async function pgReader(url) {
  const pg = (await import('pg')).default;
  // Registers the BIGINT->Number parser, so counts and timestamps read back as
  // numbers exactly as they do through the normal driver.
  await import('../db/pgTypes.js');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return {
    async readAllIdentities() {
      await client.query('BEGIN TRANSACTION READ ONLY');
      try {
        const present = await client.query(
          "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'identities'",
        );
        if (present.rowCount === 0) throw NO_IDENTITIES_TABLE;
        return (await client.query(AUDIT_SQL)).rows;
      } finally {
        await client.query('COMMIT');
      }
    },
    async close() { await client.end(); },
  };
}

/**
 * Opens a read-only SQLite reader.
 *
 * `readonly: true` means better-sqlite3 will refuse a write at the driver
 * level, and - just as importantly - opening this way does not create the file,
 * so a typo'd DB_PATH reports a missing database instead of silently auditing a
 * brand-new empty one and reporting NOT RUN.
 */
async function sqliteReader(path) {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(path, { readonly: true, fileMustExist: true });
  return {
    async readAllIdentities() {
      const present = db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'identities'",
      ).get();
      if (!present) throw NO_IDENTITIES_TABLE;
      return db.prepare(AUDIT_SQL).all();
    },
    async close() { db.close(); },
  };
}

export async function openReader(env = process.env) {
  return env.DATABASE_URL
    ? pgReader(env.DATABASE_URL)
    : sqliteReader(resolveSqlitePath(env));
}

async function main() {
  const reader = await openReader();
  let summary;
  try {
    const results = await auditStoredIdentities({
      readAllIdentities: reader.readAllIdentities,
      log: (line) => console.log(line),
    });
    summary = summarise(results);
    console.log('');
    console.log(formatSummary(summary));
  } finally {
    await reader.close();
  }

  // exitCode rather than process.exit(): Node's stdout is asynchronous when
  // piped, so exiting immediately after console.log can truncate the report -
  // and the tail is where the mismatch and orphan lists are, i.e. exactly what
  // an operator runs `| tee gate.log` to keep.
  process.exitCode = summary.passed ? 0 : 1;
}

// Only run when invoked as a script, so tests can import openReader.
if (process.argv[1] && process.argv[1].endsWith('shadowCheck.js')) {
  main().catch((e) => {
    console.error('[shadow] the audit failed to run:', e);
    process.exitCode = 2;
  });
}
