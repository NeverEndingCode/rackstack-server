#!/usr/bin/env node
// v1.3 Cold Storage end-to-end smoke suite (Task 9).
//
// Boots a real `node server/index.js` against a scratch SQLite file, seeds
// users/saves/config directly through server/db.js (same trick
// tests/e2e/smoke-v12.mjs uses), mints JWT cookies via server/auth.js, and
// drives the *built* client (client/dist, served by the app itself) with
// Playwright/Chromium. Follows smoke-v12.mjs's exact structure: same
// Playwright-resolution fallback, same server-spawn/teardown pattern, same
// check()/assert() bookkeeping, same JWT-signing approach.
//
// Requires a built client (`cd client && npm run build`) and Playwright with
// the Chromium browser downloaded:
//   npm i -D playwright && npx playwright install --with-deps chromium
//   node tests/e2e/smoke-v13.mjs
// If Playwright isn't resolvable as a normal package (e.g. it was installed
// into a scratch/tmp directory rather than this repo's node_modules), this
// script falls back to scanning /tmp/claude-*/**/scratchpad/node_modules
// for a usable install before giving up with an explicit error.
//
// Every check prints `PASS <name>` or `FAIL <name>: <reason>` as it runs.
// At the end: `=== ERRORS ===` followed by each failure, or `NONE`. Exits
// non-zero if anything failed. The server child process is always killed
// on the way out (success, failure, or signal).

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
    claudeDirs = readdirSync(tmp).filter((d) => d.startsWith('claude-'));
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
  // Also check a plain /tmp/e2e-verify style scratch install (seen in prior
  // task sessions in this repo alongside the claude-* scratchpad convention).
  try {
    const idx = path.join(tmp, 'e2e-verify', 'node_modules', 'playwright', 'index.mjs');
    if (existsSync(idx)) found.push(idx);
  } catch (e) { /* ignore */ }
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

const PORT = 3802;
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = '/tmp/e2e-v13.db';
const JWT_SECRET = '5f3c1a2b4d6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9001122334455667788';
const OWNER_ID = 'github:37058311';
// Deliberately only the owner is a SUPER_ADMIN - the non-admin user seeded
// below must be excluded so the admin-gating checks are unambiguous.
const SUPER_ADMIN_IDS = OWNER_ID;

for (const ext of ['', '-wal', '-shm']) {
  try { rmSync(DB_PATH + ext, { force: true }); } catch (e) { /* ignore */ }
}

process.env.JWT_SECRET = JWT_SECRET;
process.env.SUPER_ADMIN_IDS = SUPER_ADMIN_IDS;
process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = 'test';

// Dynamic imports (not hoisted above the env assignments above) - server/db.js
// reads DB_PATH and server/auth.js reads JWT_SECRET/SUPER_ADMIN_IDS at
// module-evaluation time.
const { upsertUser, putSave, getSave, setToursCompleted, db } = await import(path.join(REPO_ROOT, 'server', 'db.js'));
const { TOUR_IDS } = await import(path.join(REPO_ROOT, 'shared', 'tours.js'));
const { issueToken, COOKIE_NAME } = await import(path.join(REPO_ROOT, 'server', 'auth.js'));
const { initialState } = await import(path.join(REPO_ROOT, 'shared', 'state.js'));
const { fmt } = await import(path.join(REPO_ROOT, 'shared', 'gameRules.js'));
const { jobDurationSec } = await import(path.join(REPO_ROOT, 'shared', 'coldStorage.js'));

// Multiple processes hold this same SQLite file open (this harness for
// seeding, plus the spawned server for real traffic) - WAL mode allows
// concurrent readers/writers, but give writers a generous busy timeout so a
// harmless lock collision during a concurrent write retries instead of
// throwing outright.
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
// Seeding helpers
// ---------------------------------------------------------------------------

// v1.6: these suites exercise pre-v1.6 features, so their seeded players
// start with the guided tours already completed - otherwise the onboarding
// tour auto-starts over the built client and its overlay swallows the clicks
// these checks depend on. New-player tour behaviour is covered by smoke-v16.
function seedUser({ provider, providerId, username }) {
  const user = upsertUser({ provider, providerId, username, avatarUrl: null });
  setToursCompleted(user.id, TOUR_IDS);
  return user;
}

function tokenFor(user) {
  return issueToken({ id: user.id, username: user.username, avatar_url: user.avatar_url });
}

function cookieFor(user) {
  return { name: COOKIE_NAME, value: tokenFor(user), url: BASE_URL };
}

async function newPage(context) {
  const page = await context.newPage();
  return page;
}

async function bootAndGetState(page) {
  const [stateRes] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/state') && r.request().method() === 'GET'),
    page.goto(BASE_URL),
  ]);
  const body = await stateRes.json();
  // Give React a moment to render off the fetched state.
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

// Cold Storage's action types (claimBlock, claimAllBlocks, resetTrack,
// startJob, cancelJob, claimJob, buyTapeUpgrade) are NOT in the client's
// action-queue IMMEDIATE set (client/src/game/api.js) - unlike buyUpgrade/
// claimGoal/etc, a UI click on them just enqueues the action for the queue's
// normal up-to-1s auto-flush timer rather than posting right away. Waiting a
// fixed short timeout after such a click is flaky (the flush can legitimately
// take close to a second); this instead waits for the actual POST
// /api/actions network round-trip the click triggers.
async function clickAndAwaitFlush(page, locator) {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/actions') && r.request().method() === 'POST', { timeout: 5000 }),
    locator.click(),
  ]);
  return resp;
}

// Reads the current saved state for a user straight from the DB (mirrors how
// stateService.js parses the `saves.data` JSON column), mutates it, and
// writes it back with `putSave` - the same direct-seeding trick used
// throughout this suite to short-circuit real-time mechanics (block arrival,
// offline job accrual) instead of waiting on wall-clock time in a test.
function mutateSave(userId, mutator) {
  const row = getSave(userId);
  const data = row ? JSON.parse(row.data) : initialState();
  mutator(data);
  putSave(userId, data, Date.now());
  return data;
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

  // --- Seed all users up front -------------------------------------------
  const owner = seedUser({ provider: 'github', providerId: '37058311', username: 'owner_cs_e2e' });
  const nonAdmin = seedUser({ provider: 'discord', providerId: 'e2e-cs-nonadmin', username: 'nonadmin_cs_e2e' });
  const lockedUser = seedUser({ provider: 'discord', providerId: 'e2e-cs-locked', username: 'locked_cs_e2e' });
  const trackUser = seedUser({ provider: 'discord', providerId: 'e2e-cs-track', username: 'track_cs_e2e' });
  const jobUser = seedUser({ provider: 'discord', providerId: 'e2e-cs-job', username: 'job_cs_e2e' });
  const tapeUser = seedUser({ provider: 'discord', providerId: 'e2e-cs-tape', username: 'tape_cs_e2e' });

  assert(`${owner.id}` === OWNER_ID, `expected seeded owner id ${OWNER_ID}, got ${owner.id}`);

  // lockedUser: fresh state, no Server Room (tiers[4]) owned - used to prove
  // the Cold Storage tab is hidden until unlocked, then reappears once
  // bought. Plenty of credits so the real buy action succeeds.
  {
    const s = initialState();
    s.run.credits = 1_000_000;
    putSave(lockedUser.id, s, Date.now());
  }

  // trackUser: Server Room owned (unlocks the tab) + trackStartedAt pushed
  // 17 block-durations into the past, so all 16 blocks have arrived
  // (arrivedCount is capped implicitly by TOTAL_BLOCKS in the reducer/UI).
  {
    const s = initialState();
    s.run.tiers[4].owned = 1;
    s.meta.coldStorage.trackStartedAt = Date.now() - 17 * 6 * 3600 * 1000;
    putSave(trackUser.id, s, Date.now());
  }

  // jobUser: Server Room owned, otherwise fresh - the job itself is started
  // through the real action API below, then its accrual is short-circuited
  // directly via the DB.
  {
    const s = initialState();
    s.run.tiers[4].owned = 1;
    putSave(jobUser.id, s, Date.now());
  }

  // tapeUser: Server Room owned + a pile of tapes so the upgrade-purchase
  // cost curve (baseCost 20, costMult 2.0, maxLevel 5 for "headstart") is
  // trivially affordable through the real action API - this test is about
  // the buy/level/reject mechanic, not the cost curve (covered elsewhere).
  {
    const s = initialState();
    s.run.tiers[4].owned = 1;
    s.meta.coldStorage.tapes = 1_000_000;
    putSave(tapeUser.id, s, Date.now());
  }

  // --- Check A: Cold Storage tab locked until Server Room owned, then
  //     unlocks and renders after buying it --------------------------------
  // (TabBar.jsx always renders every tab button - "hidden" here means
  // disabled/grayed-out with a locked title, the same convention already
  // used for the Grid/Overclock/Singularity tabs, not removed from the DOM.)
  await check('Cold Storage tab locked until Server Room owned, unlocks and renders after', async () => {
    const context = await browser.newContext();
    await context.addCookies([cookieFor(lockedUser)]);
    const page = await newPage(context);
    await bootAndGetState(page);

    const tab = page.getByRole('button', { name: 'Cold Storage', exact: true });
    assert(await tab.count() === 1, 'expected the Cold Storage tab button to exist even while locked');
    assert(await tab.isDisabled(), 'expected the Cold Storage tab to be disabled before owning a Server Room');

    const buy = await apiFetch(page, '/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{ _cid: 1, type: 'buy', lane: 'tiers', index: 4, mode: 1 }] }),
    });
    assert(buy.status === 200, `buy Server Room status ${buy.status}`);
    assert(buy.body.results[0].ok === true, `buy Server Room rejected: ${JSON.stringify(buy.body.results[0])}`);
    assert(buy.body.state.run.tiers[4].owned >= 1, 'expected tiers[4].owned >= 1 after buying Server Room');

    await page.reload();
    await page.waitForResponse((r) => r.url().endsWith('/api/state'));
    await page.waitForTimeout(150);

    const tabAfter = page.getByRole('button', { name: 'Cold Storage', exact: true });
    assert(!(await tabAfter.isDisabled()), 'expected the Cold Storage tab to be enabled after owning a Server Room');
    await tabAfter.click();
    await page.waitForTimeout(150);
    const bodyText = await page.textContent('body');
    assert(bodyText.includes('Passive Track'), 'expected the Cold Storage panel to render once unlocked');

    await context.close();
  });

  // --- Check B: passive track - claim one, Claim All, Reset Track --------
  await check('passive track: claim one block, Claim All sweeps rest, Reset Track gated then works', async () => {
    const context = await browser.newContext();
    await context.addCookies([cookieFor(trackUser)]);
    const page = await newPage(context);
    const boot = await bootAndGetState(page);
    assert(boot.meta.coldStorage.blocksClaimed.every((c) => c === false), 'expected a fresh, all-unclaimed track');

    await page.getByRole('button', { name: 'Cold Storage', exact: true }).click();
    await page.waitForTimeout(150);

    const tapesBefore = boot.meta.coldStorage.tapes;

    // Reset Track must be disabled while any block is still unclaimed.
    const resetBtn = page.getByRole('button', { name: 'Reset Track', exact: true });
    assert(await resetBtn.isDisabled(), 'expected Reset Track to be disabled before all 16 blocks are claimed');

    // Claim block index 0 (tile shows "1" while claimable) through the UI.
    await clickAndAwaitFlush(page, page.getByRole('button', { name: '1', exact: true }));
    await page.waitForTimeout(150);

    const afterOne = await apiFetch(page, '/api/state', { method: 'GET' });
    assert(afterOne.body.meta.coldStorage.blocksClaimed[0] === true, 'expected block 0 claimed after clicking its tile');
    assert(afterOne.body.meta.coldStorage.tapes > tapesBefore, `expected tapes to increase after claiming block 0 (before=${tapesBefore}, after=${afterOne.body.meta.coldStorage.tapes})`);

    const tapesAfterOne = afterOne.body.meta.coldStorage.tapes;
    const tapesTile = await page.locator('text=/^' + fmt(tapesAfterOne).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$/').first();
    assert(await tapesTile.count() > 0, `expected the tapes tile to show the updated formatted tapes total (${fmt(tapesAfterOne)})`);

    // Claim All sweeps the remaining 15.
    await clickAndAwaitFlush(page, page.getByRole('button', { name: 'Claim All', exact: true }));
    await page.waitForTimeout(150);

    const afterAll = await apiFetch(page, '/api/state', { method: 'GET' });
    assert(afterAll.body.meta.coldStorage.blocksClaimed.every(Boolean), 'expected all 16 blocks claimed after Claim All');
    assert(afterAll.body.meta.coldStorage.tapes > tapesAfterOne, 'expected tapes to increase further after Claim All');

    // Reset Track is now enabled and starts a fresh cycle.
    assert(!(await resetBtn.isDisabled()), 'expected Reset Track to be enabled once all 16 blocks are claimed');
    await clickAndAwaitFlush(page, resetBtn);
    await page.waitForTimeout(150);

    const afterReset = await apiFetch(page, '/api/state', { method: 'GET' });
    assert(afterReset.body.meta.coldStorage.trackCycle === 1, `expected trackCycle=1 after Reset Track, got ${afterReset.body.meta.coldStorage.trackCycle}`);
    assert(afterReset.body.meta.coldStorage.blocksClaimed.every((c) => c === false), 'expected a fresh all-unclaimed track after Reset Track');
    assert(afterReset.body.meta.coldStorage.trackStartedAt > Date.now() - 5000, 'expected trackStartedAt reset to ~now');

    await context.close();
  });

  // --- Check C: offline job - start, short-circuit accrual, claim --------
  await check('offline job: start, seed accrual to completion, Claim Job pays out and clears the slot', async () => {
    const context = await browser.newContext();
    await context.addCookies([cookieFor(jobUser)]);
    const page = await newPage(context);
    await bootAndGetState(page);

    await page.getByRole('button', { name: 'Cold Storage', exact: true }).click();
    await page.waitForTimeout(150);

    const start = await apiFetch(page, '/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{ _cid: 1, type: 'startJob', jobType: 'defrag' }] }),
    });
    assert(start.status === 200, `startJob status ${start.status}`);
    assert(start.body.results[0].ok === true, `startJob rejected: ${JSON.stringify(start.body.results[0])}`);
    assert(start.body.state.meta.coldStorage.job && start.body.state.meta.coldStorage.job.type === 'defrag', 'expected an active defrag job');

    const tapesBeforeJob = start.body.state.meta.coldStorage.tapes;

    // Short-circuit real offline time: mutate the DB row directly so the
    // 1h defrag job (3600s duration) reads as fully accrued, exactly as the
    // brief instructs (mirrors how v1.2's e2e suite short-circuits
    // time-based mechanics like heatCooldownUntil).
    const cfg = await apiFetch(page, '/api/config', { method: 'GET' });
    const durationSec = jobDurationSec('defrag', cfg.body.data);
    mutateSave(jobUser.id, (data) => {
      data.meta.coldStorage.job = { type: 'defrag', accruedOfflineSec: durationSec, startedAt: Date.now() - durationSec * 1000 };
    });

    await page.reload();
    await page.waitForResponse((r) => r.url().endsWith('/api/state'));
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: 'Cold Storage', exact: true }).click();
    await page.waitForTimeout(150);

    const claimBtn = page.getByRole('button', { name: 'Claim', exact: true });
    await claimBtn.waitFor({ state: 'visible', timeout: 3000 });
    await clickAndAwaitFlush(page, claimBtn);
    await page.waitForTimeout(150);

    const afterClaim = await apiFetch(page, '/api/state', { method: 'GET' });
    assert(afterClaim.body.meta.coldStorage.job === null, 'expected the job slot cleared after Claim');
    assert(afterClaim.body.meta.coldStorage.tapes > tapesBeforeJob, `expected tapes to increase after claiming the job payout (before=${tapesBeforeJob}, after=${afterClaim.body.meta.coldStorage.tapes})`);

    await context.close();
  });

  // --- Check D: tape upgrade - buy updates level/deducts tapes; past max
  //     level is rejected -------------------------------------------------
  await check('tape upgrade: buying updates level and deducts tapes; past max level is rejected', async () => {
    const context = await browser.newContext();
    await context.addCookies([cookieFor(tapeUser)]);
    const page = await newPage(context);
    await bootAndGetState(page);

    await page.getByRole('button', { name: 'Cold Storage', exact: true }).click();
    await page.waitForTimeout(150);

    const before = await apiFetch(page, '/api/state', { method: 'GET' });
    const tapesBefore = before.body.meta.coldStorage.tapes;
    const levelBefore = before.body.meta.coldStorage.upgrades.headstart || 0;
    assert(levelBefore === 0, `expected headstart at level 0 before buying, got ${levelBefore}`);

    // "Head Start" ("headstart") has the shallowest cost curve of the 7 tape
    // upgrades (maxLevel 5) - scope to its own card (the only `.rounded-xl.p-3`
    // block containing its name) and click its buy button through the real UI.
    const headStartCard = page.locator('div.rounded-xl.p-3', { hasText: 'Head Start' });
    await headStartCard.waitFor({ state: 'visible' });
    assert(await headStartCard.count() === 1, `expected exactly one Head Start upgrade card, got ${await headStartCard.count()}`);
    await clickAndAwaitFlush(page, headStartCard.getByRole('button'));
    await page.waitForTimeout(150);

    const afterOne = await apiFetch(page, '/api/state', { method: 'GET' });
    assert(afterOne.body.meta.coldStorage.upgrades.headstart === 1, `expected headstart level 1 after buying, got ${afterOne.body.meta.coldStorage.upgrades.headstart}`);
    assert(afterOne.body.meta.coldStorage.tapes < tapesBefore, `expected tapes to decrease after buying (before=${tapesBefore}, after=${afterOne.body.meta.coldStorage.tapes})`);

    // Drive the remaining levels (2..5) via the action API directly - same
    // mechanic, just faster than clicking through each one.
    for (let i = 0; i < 4; i++) {
      // eslint-disable-next-line no-await-in-loop
      const buy = await apiFetch(page, '/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actions: [{ _cid: 100 + i, type: 'buyTapeUpgrade', id: 'headstart' }] }),
      });
      assert(buy.status === 200, `buyTapeUpgrade status ${buy.status}`);
      assert(buy.body.results[0].ok === true, `buyTapeUpgrade rejected before max level: ${JSON.stringify(buy.body.results[0])}`);
    }

    const atMax = await apiFetch(page, '/api/state', { method: 'GET' });
    assert(atMax.body.meta.coldStorage.upgrades.headstart === 5, `expected headstart at max level 5, got ${atMax.body.meta.coldStorage.upgrades.headstart}`);

    // Buying past max level is rejected.
    const rejected = await apiFetch(page, '/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{ _cid: 200, type: 'buyTapeUpgrade', id: 'headstart' }] }),
    });
    assert(rejected.status === 200, `buyTapeUpgrade (past max) status ${rejected.status}`);
    assert(rejected.body.results[0].ok === false && rejected.body.results[0].error === 'max_level',
      `expected max_level rejection, got ${JSON.stringify(rejected.body.results[0])}`);

    // The UI reflects MAXED and won't let you click through it either.
    await page.reload();
    await page.waitForResponse((r) => r.url().endsWith('/api/state'));
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: 'Cold Storage', exact: true }).click();
    await page.waitForTimeout(150);
    const maxedBtn = page.getByRole('button', { name: 'MAXED', exact: true });
    assert(await maxedBtn.count() === 1, `expected exactly one maxed-out upgrade button, got ${await maxedBtn.count()}`);
    assert(await maxedBtn.isDisabled(), 'expected the maxed-out upgrade button to render as disabled "MAXED"');

    await context.close();
  });

  // --- Check E: admin config edit reflected in a subsequent state fetch --
  await check('admin config edit to batchQueue.blockDurationMs is reflected in a subsequent fetch', async () => {
    const context = await browser.newContext();
    await context.addCookies([cookieFor(owner)]);
    const page = await newPage(context);
    await bootAndGetState(page);

    const before = await apiFetch(page, '/api/config', { method: 'GET' });
    assert(before.status === 200, `GET /api/config status ${before.status}`);
    const versionBefore = before.body.version;
    const newConfig = JSON.parse(JSON.stringify(before.body.data));
    const originalBlockDurationMs = newConfig.batchQueue.blockDurationMs;
    const newBlockDurationMs = originalBlockDurationMs === 7200000 ? 10800000 : 7200000; // 2h (or 3h if already 2h)
    newConfig.batchQueue.blockDurationMs = newBlockDurationMs;

    const put = await apiFetch(page, '/api/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: newConfig }),
    });
    assert(put.status === 200, `PUT /api/admin/config status ${put.status}: ${JSON.stringify(put.body)}`);
    assert(put.body.version > versionBefore, `expected config version to bump (before=${versionBefore}, after=${put.body.version})`);

    const after = await apiFetch(page, '/api/config', { method: 'GET' });
    assert(after.body.data.batchQueue.blockDurationMs === newBlockDurationMs,
      `expected live config batchQueue.blockDurationMs=${newBlockDurationMs}, got ${after.body.data.batchQueue.blockDurationMs}`);
    assert(after.body.version === put.body.version, 'expected the fetched version to match the PUT response version');

    await context.close();
  });

  // --- Check F: non-admin has no Balancing tab and is 403'd at the API ---
  await check('non-admin has no Balancing tab; direct admin config PUT is 403', async () => {
    const context = await browser.newContext();
    await context.addCookies([cookieFor(nonAdmin)]);
    const page = await newPage(context);
    await bootAndGetState(page);

    await page.getByTitle('View profile').click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();

    const balancingTabCount = await page.getByRole('button', { name: 'Balancing', exact: true }).count();
    assert(balancingTabCount === 0, 'expected no Balancing tab for a non-admin user');

    const forbidden = await apiFetch(page, '/api/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    assert(forbidden.status === 403, `expected 403 from a non-admin PUT /api/admin/config, got ${forbidden.status}`);

    await context.close();
  });

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
