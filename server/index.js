import 'dotenv/config';
import { maybeAutoMigrate } from './db/migrate.js';

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
  console.error('[migrate] FATAL - refusing to start:', e.message);
  process.exit(1);
}

// Dynamic imports: server/db/index.js (imported transitively by db.js,
// configService.js, eventService.js and app.js) resolves its driver at
// module-evaluation time via a top-level await, so a static import here
// would open the pool - and start serving the un-migrated (or, for a fresh
// Postgres target, empty) database - before maybeAutoMigrate() above ever
// got a chance to run.
const { ensureConfig } = await import('./configService.js');
const { seedSeasonalEvents } = await import('./db.js');
const { runScheduler } = await import('./eventService.js');
const { buildApp } = await import('./app.js');

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
