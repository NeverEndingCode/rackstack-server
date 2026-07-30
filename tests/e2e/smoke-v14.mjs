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
//   6. A non-coordinator gets 403 on every admin event route.
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

const { upsertUser, putSave, getSave, db } = await import(path.join(REPO_ROOT, 'server', 'db.js'));
const { issueToken, COOKIE_NAME } = await import(path.join(REPO_ROOT, 'server', 'auth.js'));
const { initialState } = await import(path.join(REPO_ROOT, 'shared', 'state.js'));

db.pragma('busy_timeout = 5000');

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

function seedUser({ provider, providerId, username }) {
  return upsertUser({ provider, providerId, username, avatarUrl: null });
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
  putSave(userId, s, Date.now() - elapsedMs);
  const res = await apiFetch(page, '/api/state', { method: 'GET' });
  if (res.status !== 200) throw new Error(`GET /api/state failed while measuring grid gain: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.run.credits - 10;
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
  const coordinator = seedUser({ provider: 'github', providerId: '37058311', username: 'coord_v14_e2e' });
  assert(`${coordinator.id}` === OWNER_ID, `expected seeded owner id ${OWNER_ID}, got ${coordinator.id}`);

  const ladderPlayer = seedUser({ provider: 'discord', providerId: 'e2e-v14-ladder', username: 'ladder_v14_e2e' });
  const optOutPlayer = seedUser({ provider: 'discord', providerId: 'e2e-v14-optout', username: 'optout_v14_e2e' });
  const overlayPlayer = seedUser({ provider: 'discord', providerId: 'e2e-v14-overlay', username: 'overlay_v14_e2e' });
  const plainPlayer = seedUser({ provider: 'discord', providerId: 'e2e-v14-plain', username: 'plain_v14_e2e' });

  // ladderPlayer's pre-existing progress, seeded BEFORE any event exists (and
  // therefore before they ever join one) - Check 1 below asserts this value
  // becomes the join baseline rather than being either ignored (started from
  // zero) or double-counted (treated as already-earned ladder progress).
  {
    const s = initialState();
    s.meta.stats.lifetimeFlopsAllTime = 500;
    putSave(ladderPlayer.id, s, Date.now());
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

  // Navigate every page once up front (no event exists yet, so none of this
  // triggers a join) purely so each page has a same-origin document loaded -
  // apiFetch's page.evaluate(fetch(relativePath)) needs that to resolve.
  await Promise.all([
    bootAndGetState(coordPage),
    bootAndGetState(ladderPage),
    bootAndGetState(optOutPage),
    bootAndGetState(overlayPage),
    bootAndGetState(plainPage),
  ]);

  // --- Check: non-coordinator 403s on every admin event route -------------
  await check('a non-coordinator gets 403 on every admin event route', async () => {
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
    const row = getSave(ladderPlayer.id);
    const data = JSON.parse(row.data);
    data.meta.stats.lifetimeFlopsAllTime += 300;
    putSave(ladderPlayer.id, data, Date.now());

    const postAct = await apiFetch(ladderPage, '/api/event', { method: 'GET' });
    assert(postAct.body.progress.rungs[0].current === 300, `expected rung 0's current progress to read 300 (only the post-join delta - not the pre-existing 500, not the raw 800 total), got ${postAct.body.progress.rungs[0].current}`);
    assert(postAct.body.progress.rungs[0].met === true, 'expected rung 0 to become met once its 50-target delta is cleared');
    assert(postAct.body.progress.rungs[1].current === 300, `expected rung 1 (same metric, different target) to report the identical 300 delta, got ${postAct.body.progress.rungs[1].current}`);
    assert(postAct.body.progress.rungs[1].met === false, 'expected rung 1 (target 10,000,000) to remain unmet');
  });

  // --- Check 2: claim pays out once, can't double-claim, unmet rung has no
  //     claim control ------------------------------------------------------
  await check('claiming a met rung pays out exactly once through the real UI and rejects a direct-API double-claim; an unmet rung never renders a claim control', async () => {
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

  // --- Check 5: the overlay is live, and the stored config is untouched ---
  await check('overlay is live: an active production.gridMult modifier measurably changes output, and GET /api/config still reports the untouched stored baseline', async () => {
    const configBefore = await apiFetch(overlayPage, '/api/config', { method: 'GET' });
    assert(configBefore.body.data.production.gridMult === 1, `expected the stored config's gridMult to remain 1 while event 2's overlay is active, got ${configBefore.body.data.production.gridMult}`);

    const overlaidGain = await measureGridGain(overlayPage, overlayPlayer.id, GRID_OWNED, ELAPSED_MS);
    const lowerBound = baselineGain * (OVERLAY_MULT - 0.3);
    const upperBound = baselineGain * (OVERLAY_MULT + 0.3);
    assert(overlaidGain > lowerBound, `expected the ${OVERLAY_MULT}x gridMult overlay to meaningfully increase output (baseline=${baselineGain}, overlaid=${overlaidGain}, expected > ${lowerBound})`);
    assert(overlaidGain < upperBound, `overlaid gain (${overlaidGain}) is implausibly far above baseline*${OVERLAY_MULT} (${upperBound}) - check for a runaway/duplicated multiplier`);

    const configAfter = await apiFetch(overlayPage, '/api/config', { method: 'GET' });
    assert(configAfter.body.data.production.gridMult === 1, `expected the stored config's gridMult to still read 1 after measuring the overlaid output, got ${configAfter.body.data.production.gridMult}`);
  });

  await coordCtx.close();
  await ladderCtx.close();
  await optOutCtx.close();
  await overlayCtx.close();
  await plainCtx.close();
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
