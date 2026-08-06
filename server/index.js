import 'dotenv/config';
import { maybeAutoMigrate, describeFatalMigrationError } from './db/migrate.js';

/**
 * Prints the one line an operator gets when boot refuses, then exits.
 *
 * The explicit stderr flush is not ceremony: writes to a *pipe* - which is
 * what Docker's log driver hands the container - are asynchronous in Node,
 * and process.exit() discards whatever has not drained yet. Exiting straight
 * after console.error can therefore produce a container that dies silently,
 * which is the worst possible outcome for the only diagnostic there is.
 * Passing a callback to write() defers the exit until the queued output has
 * actually gone out.
 */
async function fatal(reason) {
  console.error('[migrate] FATAL - refusing to start:', reason);
  await new Promise((resolve) => { process.stderr.write('', resolve); });
  process.exit(1);
}

try {
  const result = await maybeAutoMigrate();
  if (result.migrated) {
    console.log(`[migrate] migration complete: ${JSON.stringify(result.counts)}`);
  } else {
    console.log(`[migrate] skipped - ${result.reason}`);
  }
} catch (e) {
  // Deliberately fatal. Serving an empty game to real players is worse than
  // being down: a stopped container gets investigated, an empty leaderboard
  // might not be noticed until saves have been overwritten on top of it.
  // describeFatalMigrationError (not e.message directly): a connection-
  // refused Postgres surfaces as Node's own AggregateError, whose .message
  // is always '' - logging that verbatim would print this line with
  // nothing after the colon, defeating the point of it being the operator's
  // only signal for why boot refused.
  await fatal(describeFatalMigrationError(e));
}

// Dynamic imports: server/db/index.js (imported transitively by db.js,
// configService.js, eventService.js and app.js) resolves its driver at
// module-evaluation time via a top-level await, so a static import here
// would open the pool - and start serving the un-migrated (or, for a fresh
// Postgres target, empty) database - before maybeAutoMigrate() above ever
// got a chance to run.
//
// Wrapped in the same fatal handler as the migration itself. These imports
// are where the driver actually connects, and maybeAutoMigrate returns
// without touching Postgres whenever there is no SQLite file to migrate - so
// an unreachable or misconfigured Postgres on a fresh install surfaces HERE,
// not above. Unwrapped, that arrives as a raw ERR_UNHANDLED_REJECTION stack
// with no mention of the database, for the single most likely first-run
// misconfiguration there is.
let ensureConfig;
let seedSeasonalEvents;
let runScheduler;
let buildApp;
try {
  ({ ensureConfig } = await import('./configService.js'));
  ({ seedSeasonalEvents } = await import('./db.js'));
  ({ runScheduler } = await import('./eventService.js'));
  ({ buildApp } = await import('./app.js'));
} catch (e) {
  await fatal(describeFatalMigrationError(e));
}

await ensureConfig();
await seedSeasonalEvents();

// Live Events (v1.4) scheduler: run once at boot to catch anything that
// should already be active/ended/materialized while the server was down,
// then hourly per spec §5.2. unref() so this interval alone never keeps the
// process alive (matters for tests/tools that import this module and want
// a clean exit; it's harmless in production where the HTTP server's own
// listening socket already keeps the event loop open).
await runScheduler(Date.now());
// The .catch is required: an async runScheduler rejecting inside
// setInterval is an unhandled rejection that crashes Node 20 by default.
setInterval(() => { runScheduler(Date.now()).catch((e) => console.error('[scheduler]', e)); }, 3600_000).unref();

const app = buildApp();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RACKSTACK server listening on :${PORT}`);
});
