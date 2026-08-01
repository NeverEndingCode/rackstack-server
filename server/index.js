import 'dotenv/config';
import { ensureConfig } from './configService.js';
import { seedSeasonalEvents } from './db.js';
import { runScheduler } from './eventService.js';
import { buildApp } from './app.js';

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
