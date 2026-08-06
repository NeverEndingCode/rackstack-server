#!/usr/bin/env node
// Operator entry point for the shadow-mode gate: `npm run shadow:check`.
//
// Audits every identity row in whichever database the usual environment
// variables point at (DATABASE_URL for Postgres, DB_PATH for SQLite - the same
// resolution the server itself uses, so there is no second place to get it
// wrong) and prints the report the cutover decision is made from.
//
// Read-only. Safe to run against production while players are online, and safe
// to run against a restored export on a laptop - which is the intended use,
// since the gate has to clear BEFORE the SuperTokens stack is switched on.
//
// Exit code is the machine-readable form of the gate: 0 only on a clean pass.
// A non-zero exit on "nothing was compared" is deliberate - an empty run is not
// a pass, and a script that exited 0 on it would quietly bless a cutover
// against a database it never actually read.

import { auditStoredIdentities, summarise, formatSummary } from './shadow.js';
import { driver } from '../db/index.js';

async function main() {
  const results = await auditStoredIdentities({ log: (line) => console.log(line) });
  const summary = summarise(results);

  console.log('');
  console.log(formatSummary(summary));

  if (driver.__backend === 'pg') await driver.__raw.end();
  process.exit(summary.passed ? 0 : 1);
}

main().catch((e) => {
  console.error('[shadow] the audit failed to run:', e);
  process.exit(2);
});
