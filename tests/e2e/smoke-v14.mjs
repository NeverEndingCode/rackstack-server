#!/usr/bin/env node
// v1.4 Live Events - player-side + invariant end-to-end smoke suite (Task 9).
//
// tests/e2e/smoke-v14-events.mjs (Task 8) already covers the ADMIN side of
// Live Events end-to-end: a coordinator authoring -> scheduling ->
// activating -> ending an event through the real Events tab UI, a pure
// event_coordinator (non-admin) reaching the admin panel and seeing only the
// Events tab, a second unprivileged user seeing the activated event's
// banner, and rejection of activating an already-past window. This file
// deliberately does NOT re-test any of that. It covers the remaining
// checklist items, all from the PLAYER side (or a pure invariant that has no
// natural home in the admin-panel-driven suite):
//
//   1. Ladder progress reflects post-join deltas only (a pre-existing stat
//      snapshotted as the join baseline, not counted as already-earned).
//   2. Claiming a met rung pays out exactly once and can't be double-claimed;
//      an unmet rung never renders a claim control at all.
//   3. The overlay is live: a production.gridMult modifier measurably
//      changes realized output while the event is active, and GET
//      /api/config still reports the untouched stored baseline throughout.
//   4. One-active-at-a-time: activating a second event 409s with
//      event_active until the first is explicitly ended.
//   5. Opting out (via the real "Hide me" checkbox) removes the user from
//      the event leaderboard immediately.
//   6. A non-coordinator gets 403 on every admin event route AND sees no
//      ADMIN section / Events tab in the client.
//
// Boots a real `node server/index.js` against a scratch SQLite file, seeds
// users/saves directly through server/db.js (same trick smoke-v12/13/
// v14-events.mjs use), mints JWT cookies via server/auth.js, and drives the
// *built* client (client/dist, served by the app itself) with
// Playwright/Chromium for anything that exercises a real client-side wrapper
// (the claim flow, the opt-out checkbox) - per this project's own history of
// shipping bugs that unit tests missed because they bypass those wrappers.
// Numeric/lifecycle invariants (the ladder-delta math, the overlay ratio,
// the one-active-at-a-time 409, the 403 gate) are asserted directly against
// the API instead, matching smoke-v13.mjs's Check E precedent (its admin
// config-edit check is pure apiFetch, no UI click) - Playwright is reused
// there purely as an authenticated-fetch harness (page.evaluate + fetch),
// not because the assertion needs rendered DOM.
//
// Every check prints `PASS <name>` or `FAIL <name>: <reason>` as it runs.
// At the end: `=== ERRORS ===` followed by each failure, or `NONE`. Exits
// non-zero if anything failed. The server child process is always killed on
// the way out (success, failure, or signal).

import { spawn } from 'node:child_process';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Playwright resolution: plain import first, scratchpad fallback second.
// ---------------------------------------------------------------------------

function findScratchpadPlaywright() {
  const found = [];
  const tmp = '/tmp';
  let claudeDirs = [];
  try {
    claudeDirs = readdirSync(tmp).filter((d) => d.startsWith('claude-') || d === 'e2e-verify');
  } catch (e) {
    return found;
  }
  function walk(dir, depth) {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(dir, ent.name);
      if (ent.name === 'playwright' && full.includes('node_modules')) {
        const idx = path.join(full, 'index.mjs');
        if (existsSync(idx)) found.push(idx);
      }
      if (ent.name !== 'playwright') walk(full, depth + 1);
    }
  }
  for (const d of claudeDirs) walk(path.join(tmp, d), 0);
  return found;
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (e) {
    const candidates = findScratchpadPlaywright();
    for (const c of candidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await import(`file://${c}`);
      } catch (e2) {
        // try the next candidate
      }
    }
    console.error(
      '\nCould not load "playwright". Install it with:\n' +
      '  npm i -D playwright && npx playwright install chromium\n' +
      'or ensure a prior scratchpad install is reachable under /tmp/claude-*/**/scratchpad/node_modules/playwright.\n',
    );
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Server env / lifecycle
// ---------------------------------------------------------------------------

const PORT = 3805;
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = '/tmp/e2e-v14.db';
const JWT_SECRET = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80';
const OWNER_ID = 'github:37058311';
const SUPER_ADMIN_IDS = OWNER_ID;

for (const ext of ['', '-wal', '-shm']) {
  try { rmSync(DB_PATH + ext, { force: true }); } catch (e) { /* ignore */ }
}

process.env.JWT_SECRET = JWT_SECRET;
process.env.SUPER_ADMIN_IDS = SUPER_ADMIN_IDS;
process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = 'test';

const { upsertUser, putSave, getSave, setToursCompleted, driver } = await import(path.join(REPO_ROOT, 'server', 'db.js'));
const { TOUR_IDS } = await import(path.join(REPO_ROOT, 'shared', 'tours.js'));
const { issueToken, COOKIE_NAME } = await import(path.join(REPO_ROOT, 'server', 'auth.js'));
const { initialState } = await import(path.join(REPO_ROOT, 'shared', 'state.js'));

// Multiple processes hold this same SQLite file open (this harness for
// seeding, plus the spawned server for real traffic); busy_timeout is a
// SQLite-only pragma (Postgres uses MVCC instead), so only apply it against
// the SQLite driver.
if (driver.__backend === 'sqlite') {
  driver.__raw.pragma('busy_timeout = 5000');
}

let serverProc = null;
let browser = null;

function killServer() {
  if (serverProc && !serverProc.killed) {
    try { serverProc.kill('SIGTERM'); } catch (e) { /* ignore */ }
  }
}
process.on('exit', killServer);
process.on('SIGINT', () => { killServer(); process.exit(130); });
process.on('SIGTERM', () => { killServer(); process.exit(143); });

async function startServer() {
  serverProc = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'index.js')], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  serverProc.stdout.on('data', (d) => { out += d.toString(); });
  serverProc.stderr.on('data', (d) => { out += d.toString(); });
  serverProc.on('exit', (code, signal) => {
    if (code !== null && code !== 0 && !shuttingDown) {
      console.error(`\n[server] exited early (code=${code} signal=${signal}); output so far:\n${out}`);
    }
  });

  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.ok || res.status === 404) break;
    } catch (e) {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`server did not become ready within 15s; output so far:\n${out}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }
}

let shuttingDown = false;

// ---------------------------------------------------------------------------
// Test bookkeeping
// ---------------------------------------------------------------------------

const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}: ${e && e.message ? e.message : e}`);
    failures.push({ name, message: e && e.message ? e.message : String(e) });
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Seeding / fetch helpers
// ---------------------------------------------------------------------------

// v1.6: these suites exercise pre-v1.6 features, so their seeded players
// start with the guided tours already completed - otherwise the onboarding
// tour auto-starts over the built client and its overlay swallows the clicks
// these checks depend on. New-player tour behaviour is covered by smoke-v16.
async function seedUser({ provider, providerId, username }) {
  const user = await upsertUser({ provider, providerId, username, avatarUrl: null });
  await setToursCompleted(user.id, TOUR_IDS);
  return user;
}

function tokenFor(user) {
  return issueToken({ id: user.id, username: user.username, avatar_url: user.avatar_url });
}

function cookieFor(user) {
  return { name: COOKIE_NAME, value: tokenFor(user), url: BASE_URL };
}

async function bootAndGetState(page) {
  const [stateRes] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/state') && r.request().method() === 'GET'),
    page.goto(BASE_URL),
  ]);
  const body = await stateRes.json();
  await page.waitForTimeout(150);
  return body;
}

async function apiFetch(page, urlPath, opts) {
  return page.evaluate(
    async ({ urlPath: p, opts: o }) => {
      const res = await fetch(p, { credentials: 'include', ...o });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch (e) { /* not json */ }
      return { status: res.status, body };
    },
    { urlPath, opts },
  );
}

async function createEvent(page, body) {
  const res = await apiFetch(page, '/api/admin/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) throw new Error(`failed to create event ${body.id}: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.event;
}

async function scheduleEvent(page, id, startsAt, endsAt) {
  const res = await apiFetch(page, `/api/admin/events/${id}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startsAt, endsAt }),
  });
  if (res.status !== 200) throw new Error(`failed to schedule ${id}: ${res.status} ${JSON.stringify(res.body)}`);
}

async function activateEventApi(page, id) {
  return apiFetch(page, `/api/admin/events/${id}/activate`, { method: 'POST' });
}

async function endEventApi(page, id) {
  const res = await apiFetch(page, `/api/admin/events/${id}/end`, { method: 'POST' });
  if (res.status !== 200) throw new Error(`failed to end ${id}: ${res.status} ${JSON.stringify(res.body)}`);
}

// Seeds userId's save with `owned` Home Volunteer grid units (baseProd=3,
// GRID_DEFS[0]) and a last_save pushed `elapsedMs` into the past, then hits
// GET /api/state (which runs the real online-production evaluate() path)
// and returns the resulting credits gain over `initialState()`'s starting
// 10 credits. With production.gridMult the only thing that ever changes
// between calls (owned/thresholds/every other multiplier held fixed at
// their no-upgrades defaults), the gain scales exactly linearly with
// gridMult - see shared/gameRules.js's computeMults/tierRate.
async function measureGridGain(page, userId, owned, elapsedMs) {
  const s = initialState();
  s.run.grid[0].owned = owned;
  await putSave(userId, s, Date.now() - elapsedMs);
  const res = await apiFetch(page, '/api/state', { method: 'GET' });
  if (res.status !== 200) throw new Error(`GET /api/state failed while measuring grid gain: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.run.credits - 10;
}

// Reads the number the CLIENT actually renders in the "Total Output" card
// (StatsRow.jsx:14-16), as opposed to anything the server reports. Values go
// through shared/gameRules.js's fmt(), so they may carry a K/M/G/... suffix -
// parse it back rather than assuming a bare number. Returns NaN if the card
// isn't on screen, which every caller asserts against, so a missing card can
// never read as a silent 0.
const FMT_SUFFIXES = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q'];

function parseFmt(text) {
  const m = /^(-?[\d.]+)([A-Z]?)$/.exec(String(text).trim());
  if (!m) return NaN;
  const tier = FMT_SUFFIXES.indexOf(m[2] || '');
  if (tier < 0) return NaN;
  return Number(m[1]) * Math.pow(1000, tier);
}

async function readOutputRate(page) {
  const text = await page.evaluate(() => {
    const label = Array.from(document.querySelectorAll('div'))
      .find((d) => d.textContent.trim() === 'Total Output');
    if (!label || !label.nextElementSibling) return null;
    // "<value> F/s" - the unit lives in a nested <span>, so drop it.
    return label.nextElementSibling.textContent.replace(/\s*F\/s\s*$/, '');
  });
  return text === null ? NaN : parseFmt(text);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Starting server on ${BASE_URL} (DB_PATH=${DB_PATH})...`);
  await startServer();
  console.log('Server up.');

  const pw = await loadPlaywright();
  browser = await pw.chromium.launch();

  // --- Seed users -----------------------------------------------------------
  // The owner id doubles as our event-authoring "coordinator" persona - an
  // owner's effective roles always include event_coordinator (server/
  // auth.js's getEffectiveRoles), so no separate setRoles call is needed.
  const coordinator = await seedUser({ provider: 'github', providerId: '37058311', username: 'coord_v14_e2e' });
  assert(`${coordinator.id}` === OWNER_ID, `expected seeded owner id ${OWNER_ID}, got ${coordinator.id}`);

  const ladderPlayer = await seedUser({ provider: 'discord', providerId: 'e2e-v14-ladder', username: 'ladder_v14_e2e' });
  const optOutPlayer = await seedUser({ provider: 'discord', providerId: 'e2e-v14-optout', username: 'optout_v14_e2e' });
  const overlayPlayer = await seedUser({ provider: 'discord', providerId: 'e2e-v14-overlay', username: 'overlay_v14_e2e' });
  const plainPlayer = await seedUser({ provider: 'discord', providerId: 'e2e-v14-plain', username: 'plain_v14_e2e' });
  const ratePlayer = await seedUser({ provider: 'discord', providerId: 'e2e-v14-rate', username: 'rate_v14_e2e' });
  const heatPlayer = await seedUser({ provider: 'discord', providerId: 'e2e-v14-heat', username: 'heat_v14_e2e' });
  const gracePlayer = await seedUser({ provider: 'discord', providerId: 'e2e-v14-grace', username: 'grace_v14_e2e' });

  // ladderPlayer's pre-existing progress, seeded BEFORE any event exists (and
  // therefore before they ever join one) - Check 1 below asserts this value
  // becomes the join baseline rather than being either ignored (started from
  // zero) or double-counted (treated as already-earned ladder progress).
  {
    const s = initialState();
    s.meta.stats.lifetimeFlopsAllTime = 500;
    await putSave(ladderPlayer.id, s, Date.now());
  }

  const coordCtx = await browser.newContext();
  await coordCtx.addCookies([cookieFor(coordinator)]);
  const coordPage = await coordCtx.newPage();

  const ladderCtx = await browser.newContext();
  await ladderCtx.addCookies([cookieFor(ladderPlayer)]);
  const ladderPage = await ladderCtx.newPage();

  const optOutCtx = await browser.newContext();
  await optOutCtx.addCookies([cookieFor(optOutPlayer)]);
  const optOutPage = await optOutCtx.newPage();

  const overlayCtx = await browser.newContext();
  await overlayCtx.addCookies([cookieFor(overlayPlayer)]);
  const overlayPage = await overlayCtx.newPage();

  const plainCtx = await browser.newContext();
  await plainCtx.addCookies([cookieFor(plainPlayer)]);
  const plainPage = await plainCtx.newPage();

  const rateCtx = await browser.newContext();
  await rateCtx.addCookies([cookieFor(ratePlayer)]);
  const ratePage = await rateCtx.newPage();

  const heatCtx = await browser.newContext();
  await heatCtx.addCookies([cookieFor(heatPlayer)]);
  const heatPage = await heatCtx.newPage();

  const graceCtx = await browser.newContext();
  await graceCtx.addCookies([cookieFor(gracePlayer)]);
  const gracePage = await graceCtx.newPage();

  // Navigate every page once up front (no event exists yet, so none of this
  // triggers a join) purely so each page has a same-origin document loaded -
  // apiFetch's page.evaluate(fetch(relativePath)) needs that to resolve.
  await Promise.all([
    bootAndGetState(coordPage),
    bootAndGetState(ladderPage),
    bootAndGetState(optOutPage),
    bootAndGetState(overlayPage),
    bootAndGetState(plainPage),
    bootAndGetState(ratePage),
    bootAndGetState(heatPage),
    bootAndGetState(gracePage),
  ]);

  // --- Check: non-coordinator 403s on every admin event route, and sees
  //     no Events tab (the client-side half of the same requirement - the
  //     server gate above is authoritative, but a tab that renders and then
  //     403s on every click is still a bug) --------------------------------
  await check('a non-coordinator gets 403 on every admin event route and sees no Events tab', async () => {
    await plainPage.getByTitle('View profile').click();
    await plainPage.getByRole('button', { name: 'Settings', exact: true }).click();
    // Positive control FIRST: without it, every assertion below would pass
    // vacuously if the Settings pane simply failed to open. Username is the
    // section heading every user sees on this pane, admin or not
    // (ProfileSettings.jsx:42).
    await plainPage.getByText('Username', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
    // A plain player holds no admin/coordinator role at all, so the whole
    // ADMIN section - Events included - must be absent, not merely empty.
    assert(await plainPage.getByText('ADMIN', { exact: true }).count() === 0, 'expected NO ADMIN panel section for a plain non-coordinator player');
    assert(await plainPage.getByRole('button', { name: 'Events', exact: true }).count() === 0, 'expected no Events tab for a plain non-coordinator player');
    assert(await plainPage.getByTestId('events-new').count() === 0, 'expected no Events-tab authoring control for a plain non-coordinator player');

    const routes = [
      ['GET', '/api/admin/events'],
      ['POST', '/api/admin/events'],
      ['PUT', '/api/admin/events/e2e-nope'],
      ['DELETE', '/api/admin/events/e2e-nope'],
      ['POST', '/api/admin/events/e2e-nope/schedule'],
      ['POST', '/api/admin/events/e2e-nope/activate'],
      ['POST', '/api/admin/events/e2e-nope/end'],
      ['GET', '/api/admin/events/e2e-nope/participation'],
    ];
    for (const [method, urlPath] of routes) {
      // eslint-disable-next-line no-await-in-loop
      const res = await apiFetch(plainPage, urlPath, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({}),
      });
      assert(res.status === 403, `expected 403 for ${method} ${urlPath} as a non-coordinator, got ${res.status}: ${JSON.stringify(res.body)}`);
    }
  });

  // --- Setup: author + schedule + activate Event 1 (the ladder event) -----
  // Plain apiFetch, not a UI-driven flow: the coordinator-panel authoring
  // experience itself is smoke-v14-events.mjs's job (Task 8), not this
  // file's. Two rungs on the same metric: rung 0 is trivially clearable
  // (target 50), rung 1 is not (target 10,000,000) - Check 1/2 below use
  // both.
  const event1Id = `e2e-ladder-${Date.now()}`;
  await createEvent(coordPage, {
    id: event1Id,
    name: 'E2E Ladder Event',
    modifiers: [],
    ladder: [
      { metric: 'flopsEarned', target: 50, reward: { wafers: 20 } },
      { metric: 'flopsEarned', target: 10000000, reward: { wafers: 5 } },
    ],
  });
  {
    const now = Date.now();
    await scheduleEvent(coordPage, event1Id, now - 60000, now + 2 * 3600 * 1000);
  }
  {
    const act = await activateEventApi(coordPage, event1Id);
    if (act.status !== 200) throw new Error(`failed to activate ${event1Id}: ${act.status} ${JSON.stringify(act.body)}`);
  }

  // --- Overlay baseline: measured while Event 1 (no modifiers) is the only
  //     active event, i.e. production.gridMult is still exactly 1 -----------
  const GRID_OWNED = 10;
  const ELAPSED_MS = 40000; // 40s - comfortably inside the online (not offline-capped) production path
  const OVERLAY_MULT = 3;
  const baselineGain = await measureGridGain(overlayPage, overlayPlayer.id, GRID_OWNED, ELAPSED_MS);
  assert(baselineGain > 1000, `sanity check: expected a substantial baseline grid gain (10 owned * baseProd 3 * 40s), got ${baselineGain}`);

  // --- Check 1: ladder progress reflects post-join deltas only ------------
  await check('ladder progress reflects post-join deltas only (pre-existing stats excluded from the join baseline)', async () => {
    const boot = await bootAndGetState(ladderPage); // ladderPlayer's first touch since Event 1 activated - this is the join.
    assert(boot.activeEvent && boot.activeEvent.id === event1Id, `expected ladderPlayer's boot to report activeEvent.id=${event1Id}, got ${JSON.stringify(boot.activeEvent)}`);
    assert(boot.eventProgress && boot.eventProgress.eventId === event1Id, 'expected eventProgress to target Event 1 right after join');
    assert(boot.eventProgress.baseline.flopsEarned === 500, `expected the join baseline to snapshot the pre-existing stat (500), got ${boot.eventProgress.baseline.flopsEarned}`);

    const preAct = await apiFetch(ladderPage, '/api/event', { method: 'GET' });
    assert(preAct.status === 200, `GET /api/event failed: ${preAct.status}`);
    assert(preAct.body.progress.rungs[0].current === 0, `expected rung 0's current progress to be 0 immediately after join (delta against an equal baseline), got ${preAct.body.progress.rungs[0].current} - a raw-stat bug would show 500 here`);
    assert(preAct.body.progress.rungs[0].met === false, 'expected rung 0 to be unmet immediately after join');

    // Act: ladderPlayer earns 300 more FLOPS post-join. A direct DB mutation
    // stands in for real gameplay here (same short-circuit convention
    // smoke-v13.mjs's mutateSave uses for other time-based mechanics) - the
    // invariant under test is the baseline subtraction, not how the stat
    // itself got incremented.
    const row = await getSave(ladderPlayer.id);
    const data = JSON.parse(row.data);
    data.meta.stats.lifetimeFlopsAllTime += 300;
    await putSave(ladderPlayer.id, data, Date.now());

    const postAct = await apiFetch(ladderPage, '/api/event', { method: 'GET' });
    assert(postAct.body.progress.rungs[0].current === 300, `expected rung 0's current progress to read 300 (only the post-join delta - not the pre-existing 500, not the raw 800 total), got ${postAct.body.progress.rungs[0].current}`);
    assert(postAct.body.progress.rungs[0].met === true, 'expected rung 0 to become met once its 50-target delta is cleared');
    assert(postAct.body.progress.rungs[1].current === 300, `expected rung 1 (same metric, different target) to report the identical 300 delta, got ${postAct.body.progress.rungs[1].current}`);
    assert(postAct.body.progress.rungs[1].met === false, 'expected rung 1 (target 10,000,000) to remain unmet');
  });

  // --- Check 2: claim pays out once, can't double-claim, unmet rung has no
  //     claim control ------------------------------------------------------
  await check('claiming a met rung pays out exactly once through the real UI, opens the reward confirmation, and rejects a direct-API double-claim; an unmet rung never renders a claim control', async () => {
    await ladderPage.reload();
    await ladderPage.waitForResponse((r) => r.url().endsWith('/api/state'));
    await ladderPage.waitForTimeout(150);

    const before = await apiFetch(ladderPage, '/api/state', { method: 'GET' });
    const wafersBefore = before.body.meta.wafers;

    await ladderPage.getByRole('button', { name: 'Event', exact: true }).click();
    await ladderPage.waitForTimeout(150);

    const claimButtons = ladderPage.getByRole('button', { name: 'Claim', exact: true });
    assert(await claimButtons.count() === 1, `expected exactly one visible Claim button (rung 0 met, rung 1 unmet and un-rendered), got ${await claimButtons.count()}`);

    const [claimResp] = await Promise.all([
      ladderPage.waitForResponse((r) => r.url().endsWith('/api/actions') && r.request().method() === 'POST'),
      claimButtons.click(),
    ]);
    assert(claimResp.status() === 200, `expected 200 from the claim's POST /api/actions, got ${claimResp.status()}`);
    const claimBody = await claimResp.json();
    assert(claimBody.results[0].ok === true, `expected the claim to be accepted, got ${JSON.stringify(claimBody.results[0])}`);
    assert(claimBody.results[0].reward && claimBody.results[0].reward.wafers === 20, `expected the claim to pay out 20 wafers, got ${JSON.stringify(claimBody.results[0].reward)}`);
    assert(claimBody.results[0].rungIndex === 0, `expected rungIndex 0 in the claim result, got ${claimBody.results[0].rungIndex}`);

    await ladderPage.waitForTimeout(150);
    assert(await claimButtons.count() === 0, 'expected no Claim button to remain visible after claiming the only claimable rung (rung 0 now claimed, rung 1 still unmet)');

    // CRITICAL 3: the reward confirmation. claimEventRung's optimistic local
    // apply ALWAYS returned invalid_target (its ladder arrives via
    // config.__claimableEvent, a server-only per-request field the client
    // never holds), so the `if (result.ok)` branch that opened this modal
    // never fired once - a claim looked, to the player, like nothing had
    // happened. The modal is now opened from handleReconcile on the
    // authoritative server result, correlated by _cid.
    await ladderPage.getByText('Resolved', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
    assert(await ladderPage.getByText('+20 wafers').count() === 1, 'expected the reward confirmation modal to name the 20-wafer payout');
    await ladderPage.getByRole('button', { name: 'Nice', exact: true }).click();
    await ladderPage.waitForTimeout(150);

    const afterClaim = await apiFetch(ladderPage, '/api/state', { method: 'GET' });
    assert(afterClaim.body.meta.wafers === wafersBefore + 20, `expected wafers to increase by exactly 20 (before=${wafersBefore}, after=${afterClaim.body.meta.wafers})`);

    // Direct-API double-claim attempt (bypassing the now-hidden UI button
    // entirely) must still be rejected server-side.
    const doubleClaim = await apiFetch(ladderPage, '/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{ _cid: 999, type: 'claimEventRung', index: 0 }] }),
    });
    assert(doubleClaim.status === 200, `expected 200 (batch-level) from the double-claim attempt, got ${doubleClaim.status}`);
    assert(doubleClaim.body.results[0].ok === false && doubleClaim.body.results[0].error === 'invalid_target', `expected the double-claim to be rejected with invalid_target, got ${JSON.stringify(doubleClaim.body.results[0])}`);

    const afterDoubleClaim = await apiFetch(ladderPage, '/api/state', { method: 'GET' });
    assert(afterDoubleClaim.body.meta.wafers === wafersBefore + 20, `expected wafers to stay at ${wafersBefore + 20} after a rejected double-claim, got ${afterDoubleClaim.body.meta.wafers}`);
  });

  // --- Check 3: opting out removes the user from the leaderboard ----------
  await check('opting out (via the real "Hide me" checkbox) immediately removes a participant from the event leaderboard', async () => {
    await bootAndGetState(optOutPage); // joins Event 1

    const before = await apiFetch(optOutPage, '/api/event', { method: 'GET' });
    assert(before.status === 200 && before.body.event && before.body.event.id === event1Id, `expected optOutPlayer to see Event 1 as active, got ${JSON.stringify(before.body)}`);
    const beforeIds = before.body.leaderboard.map((r) => r.userId);
    assert(beforeIds.includes(optOutPlayer.id), `expected ${optOutPlayer.id} on the leaderboard after joining, got ids: ${beforeIds.join(', ')}`);

    await optOutPage.getByRole('button', { name: 'Event', exact: true }).click();
    await optOutPage.waitForTimeout(150);
    const checkbox = optOutPage.getByRole('checkbox');
    assert(await checkbox.count() === 1, 'expected exactly one "Hide me" checkbox on the Event tab');
    const [optResp] = await Promise.all([
      optOutPage.waitForResponse((r) => r.url().endsWith('/api/me/leaderboard-opt-out') && r.request().method() === 'PUT'),
      checkbox.check(),
    ]);
    assert(optResp.status() === 200, `expected 200 from PUT /api/me/leaderboard-opt-out, got ${optResp.status()}`);

    const after = await apiFetch(optOutPage, '/api/event', { method: 'GET' });
    const afterIds = after.body.leaderboard.map((r) => r.userId);
    assert(!afterIds.includes(optOutPlayer.id), `expected ${optOutPlayer.id} to be gone from the leaderboard after opting out, got ids: ${afterIds.join(', ')}`);
  });

  // --- Check 4: one-active-at-a-time -----------------------------------
  let event2Id;
  await check('one-active-at-a-time: activating a second event 409s with event_active until the first is explicitly ended', async () => {
    event2Id = `e2e-overlay-${Date.now()}`;
    const created = await createEvent(coordPage, {
      id: event2Id,
      name: 'E2E Overlay Event',
      modifiers: [{ path: 'production.gridMult', value: OVERLAY_MULT }],
      ladder: [{ metric: 'flopsEarned', target: 1, reward: { wafers: 1 } }],
    });
    assert(created.id === event2Id, 'expected the second event to be created as a draft');

    const now = Date.now();
    await scheduleEvent(coordPage, event2Id, now - 60000, now + 2 * 3600 * 1000);

    const conflict = await activateEventApi(coordPage, event2Id);
    assert(conflict.status === 409 && conflict.body.error === 'event_active', `expected 409 event_active activating event 2 while event 1 is still active, got ${conflict.status} ${JSON.stringify(conflict.body)}`);

    await endEventApi(coordPage, event1Id);

    const second = await activateEventApi(coordPage, event2Id);
    assert(second.status === 200, `expected 200 activating event 2 once event 1 was ended, got ${second.status} ${JSON.stringify(second.body)}`);
  });

  // --- Check 5: the overlay is live, and the STORED config is untouched ---
  // GET /api/config is the GAMEPLAY read and now serves the event-overlaid
  // document (that's Check 6's subject). The invariant this check exists for -
  // "event modifiers are never written into the stored config" - therefore
  // moves to GET /api/admin/config, the admin baseline route the Balancing tab
  // reads and PUTs back against.
  await check('overlay is live: an active production.gridMult modifier measurably changes output, GET /api/config reflects it, and GET /api/admin/config still reports the untouched stored baseline', async () => {
    const baselineBefore = await apiFetch(coordPage, '/api/admin/config', { method: 'GET' });
    assert(baselineBefore.status === 200, `GET /api/admin/config failed for the coordinator/owner: ${baselineBefore.status}`);
    assert(baselineBefore.body.data.production.gridMult === 1, `expected the STORED config's gridMult to remain 1 while event 2's overlay is active, got ${baselineBefore.body.data.production.gridMult}`);

    const gameplay = await apiFetch(overlayPage, '/api/config', { method: 'GET' });
    assert(gameplay.body.data.production.gridMult === OVERLAY_MULT, `expected the GAMEPLAY config (GET /api/config) to carry the ${OVERLAY_MULT}x overlay, got ${gameplay.body.data.production.gridMult}`);
    assert(gameplay.body.activeEventId === event2Id, `expected GET /api/config to name the active event as its cache key, got ${gameplay.body.activeEventId}`);
    assert(gameplay.body.data.__activeEvent === undefined, 'expected the runtime-only __activeEvent field to be stripped before reaching the client');

    const overlaidGain = await measureGridGain(overlayPage, overlayPlayer.id, GRID_OWNED, ELAPSED_MS);
    const lowerBound = baselineGain * (OVERLAY_MULT - 0.3);
    const upperBound = baselineGain * (OVERLAY_MULT + 0.3);
    assert(overlaidGain > lowerBound, `expected the ${OVERLAY_MULT}x gridMult overlay to meaningfully increase output (baseline=${baselineGain}, overlaid=${overlaidGain}, expected > ${lowerBound})`);
    assert(overlaidGain < upperBound, `overlaid gain (${overlaidGain}) is implausibly far above baseline*${OVERLAY_MULT} (${upperBound}) - check for a runaway/duplicated multiplier`);

    const baselineAfter = await apiFetch(coordPage, '/api/admin/config', { method: 'GET' });
    assert(baselineAfter.body.data.production.gridMult === 1, `expected the STORED config's gridMult to still read 1 after measuring the overlaid output, got ${baselineAfter.body.data.production.gridMult}`);
  });

  // --- Check 6: the CLIENT runs on the overlaid config, and notices when
  //     the overlay appears/disappears without a reload -------------------
  // Everything above asserts against the SERVER. This one reads the number
  // the client actually renders. Pre-fix, GET /api/config served the
  // un-overlaid admin baseline, so the headline rate was identical with and
  // without an active event and every reconcile snapped the counter forward.
  await check("the client's rendered output rate reflects the active event's overlay, and updates when the overlay ends without a page reload", async () => {
    // Grid-only production, so the whole headline scales linearly with
    // production.gridMult and the ratio below is exact.
    {
      const s = initialState();
      s.run.grid[0].owned = GRID_OWNED;
      await putSave(ratePlayer.id, s, Date.now());
    }
    await bootAndGetState(ratePage); // event 2 (gridMult 3) is active here
    await ratePage.waitForTimeout(500);

    const overlaidRate = await readOutputRate(ratePage);
    assert(Number.isFinite(overlaidRate) && overlaidRate > 0, `could not read a Total Output rate from the client, got ${overlaidRate}`);

    // End the overlay. The config VERSION does not change when an event
    // flips active/ended, so the pre-existing onConfigSaved refetch path
    // cannot cover this - the client polls (version, activeEventId).
    await endEventApi(coordPage, event2Id);
    await ratePage.waitForTimeout(13000); // > CONFIG_POLL_MS (10s), no reload

    const plainRate = await readOutputRate(ratePage);
    assert(Number.isFinite(plainRate) && plainRate > 0, `could not read a post-overlay Total Output rate from the client, got ${plainRate}`);
    assert(overlaidRate !== plainRate, `expected the client's rendered rate to CHANGE when the ${OVERLAY_MULT}x overlay ended, but it read ${overlaidRate} F/s both before and after - the client is running on the un-overlaid config`);
    const ratio = overlaidRate / plainRate;
    assert(ratio > OVERLAY_MULT - 0.3 && ratio < OVERLAY_MULT + 0.3, `expected the client's overlaid rate to be ~${OVERLAY_MULT}x its un-overlaid rate, got ${overlaidRate} vs ${plainRate} (ratio ${ratio.toFixed(2)})`);
  });

  // --- Check 7: Summer Surge's shipped heat.capacity overlay does not make
  //     the client hallucinate a meltdown ---------------------------------
  const event3Id = `e2e-heat-${Date.now()}`;
  await check("with Summer Surge's shipped heat.capacity:4000 overlay active, the client shows no meltdown and gauges heat against the overlaid capacity", async () => {
    await createEvent(coordPage, {
      id: event3Id,
      name: 'E2E Heat Event',
      // The exact modifier server/data/seasonalEvents.js ships on
      // summer-surge, against the stored baseline of 2000.
      modifiers: [{ path: 'heat.capacity', value: 4000 }],
      ladder: [{ metric: 'flopsEarned', target: 1, reward: { wafers: 1 } }],
    });
    {
      const now = Date.now();
      await scheduleEvent(coordPage, event3Id, now - 60000, now + 2 * 3600 * 1000);
      const act = await activateEventApi(coordPage, event3Id);
      assert(act.status === 200, `failed to activate ${event3Id}: ${act.status} ${JSON.stringify(act.body)}`);
    }

    // Heat sitting between the baseline cap (2000) and the overlaid cap
    // (4000). Nothing is owned except one Colo Rack Unit (tiers[3], the
    // tier RackStack.jsx gates `overclockUnlocked` on), so there is minimal
    // production and no offline-gain modal to get in the way; evaluate()
    // checks the heat cap regardless of ownership.
    {
      const s = initialState();
      s.run.tiers[3].owned = 1; // Colo Rack Unit - unlocks the Overclock tab
      s.run.heat = 2100;
      await putSave(heatPlayer.id, s, Date.now());
    }
    await bootAndGetState(heatPage);
    // Several 250ms production ticks, i.e. several chances for the client's
    // own evaluate() to cross ITS heat cap.
    await heatPage.waitForTimeout(3000);

    // POSITIVE CONTROL, and the sharpest assertion in this check: the heat
    // gauge is rendered as run.heat / config.heat.capacity. 2100/4000 = 53%.
    // On the un-overlaid config it is min(100, 2100/2000) = 100% until the
    // first tick melts down and resets it to 0% - so this reading alone
    // proves the overlaid capacity reached the client AND that the client is
    // predicting locally against it, which is what makes the absence
    // assertion below non-vacuous.
    await heatPage.getByRole('button', { name: 'Overclock', exact: true }).click();
    await heatPage.waitForTimeout(200);
    const heatText = await heatPage.getByText(/^\d+%$/).first().innerText();
    const heatPct = parseInt(heatText, 10);
    assert(heatPct >= 50 && heatPct <= 56, `expected the client to gauge heat 2100 against the OVERLAID capacity 4000 (~53%), got ${heatText} - 100% or 0% means it is still using the stored 2000 cap`);

    assert(await heatPage.getByText('Overheated!').count() === 0, 'expected NO meltdown modal: the server considers heat 2100 healthy against the event\'s 4000 capacity, so a client-side "Overheated!" is a pure hallucination that also freezes the overclock lane locally');
    const state = await apiFetch(heatPage, '/api/state', { method: 'GET' });
    assert(!state.body.server.overheated, `sanity: the SERVER must not consider this rack overheated either, got server.overheated=${state.body.server.overheated}`);
    assert(state.body.run.heatCooldownUntil === null, `sanity: the SERVER must not have set an overheat cooldown, got ${state.body.run.heatCooldownUntil}`);
  });

  // --- Check 8: the 48h claim grace survives a full page reload ----------
  const event4Id = `e2e-grace-${Date.now()}`;
  await check('after the event ends globally, a full page reload inside the 48h grace still renders the ladder and a working Claim button', async () => {
    await endEventApi(coordPage, event3Id);
    await createEvent(coordPage, {
      id: event4Id,
      name: 'E2E Grace Event',
      modifiers: [],
      ladder: [
        { metric: 'flopsEarned', target: 50, reward: { wafers: 20 } },
        { metric: 'flopsEarned', target: 10000000, reward: { wafers: 5 } },
      ],
    });
    {
      const now = Date.now();
      await scheduleEvent(coordPage, event4Id, now - 60000, now + 2 * 3600 * 1000);
      const act = await activateEventApi(coordPage, event4Id);
      assert(act.status === 200, `failed to activate ${event4Id}: ${act.status} ${JSON.stringify(act.body)}`);
    }

    const boot = await bootAndGetState(gracePage); // joins event 4
    assert(boot.eventProgress && boot.eventProgress.eventId === event4Id, `expected gracePlayer to join ${event4Id}, got ${JSON.stringify(boot.eventProgress)}`);

    // Clear rung 0's 50-FLOPS target, then end the event globally and push
    // the personal window an hour into the past - i.e. 47h of claim grace
    // left, the exact situation spec §5.3 exists for.
    {
      const data = JSON.parse((await getSave(gracePlayer.id)).data);
      data.meta.stats.lifetimeFlopsAllTime += 300;
      await putSave(gracePlayer.id, data, Date.now());
    }
    await endEventApi(coordPage, event4Id);
    {
      const data = JSON.parse((await getSave(gracePlayer.id)).data);
      data.meta.eventProgress.endsAt = Date.now() - 3600 * 1000;
      await putSave(gracePlayer.id, data, Date.now());
    }

    // THE reload. Pre-fix the ladder existed only as in-memory React state
    // seeded at boot from GET /api/state's `activeEvent`, and both that field
    // and GET /api/event went null the instant the event ended globally - so
    // this reload left the player with "Event details aren't available right
    // now", zero Claim buttons, and rewards that expired unclaimable, while
    // the identical claim posted straight to /api/actions still succeeded.
    await bootAndGetState(gracePage);
    await gracePage.getByRole('button', { name: 'Event', exact: true }).click();
    await gracePage.waitForTimeout(300);

    // Positive control first: the panel must have rendered the real event,
    // not the fallback card - otherwise every assertion below is vacuous.
    await gracePage.getByText('E2E Grace Event', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
    assert(await gracePage.getByText('Event details aren’t available right now.', { exact: false }).count() === 0, 'expected the real ladder, not the "Event details aren\'t available right now" fallback, after a reload inside the claim grace');

    const claimButtons = gracePage.getByRole('button', { name: 'Claim', exact: true });
    assert(await claimButtons.count() === 1, `expected exactly one Claim button (rung 0 met and unclaimed) after reloading inside the grace window, got ${await claimButtons.count()}`);

    const wafersBefore = (await apiFetch(gracePage, '/api/state', { method: 'GET' })).body.meta.wafers;
    const [claimResp] = await Promise.all([
      gracePage.waitForResponse((r) => r.url().endsWith('/api/actions') && r.request().method() === 'POST'),
      claimButtons.click(),
    ]);
    const claimBody = await claimResp.json();
    assert(claimBody.results[0].ok === true, `expected the in-grace claim to be accepted, got ${JSON.stringify(claimBody.results[0])}`);
    assert(claimBody.results[0].reward.wafers === 20, `expected 20 wafers from the in-grace claim, got ${JSON.stringify(claimBody.results[0].reward)}`);

    await gracePage.getByText('Resolved', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
    const wafersAfter = (await apiFetch(gracePage, '/api/state', { method: 'GET' })).body.meta.wafers;
    assert(wafersAfter === wafersBefore + 20, `expected wafers to rise by 20 through the in-grace UI claim (before=${wafersBefore}, after=${wafersAfter})`);
  });

  await coordCtx.close();
  await ladderCtx.close();
  await optOutCtx.close();
  await overlayCtx.close();
  await plainCtx.close();
  await rateCtx.close();
  await heatCtx.close();
  await graceCtx.close();
  await browser.close();
  browser = null;

  shuttingDown = true;
  killServer();

  console.log('\n=== ERRORS ===');
  if (failures.length === 0) {
    console.log('NONE');
  } else {
    for (const f of failures) console.log(`- ${f.name}: ${f.message}`);
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
}

try {
  await main();
} catch (e) {
  console.error('\nFATAL:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
} finally {
  shuttingDown = true;
  if (browser) { try { await browser.close(); } catch (e) { /* ignore */ } }
  killServer();
}
