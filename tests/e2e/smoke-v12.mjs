#!/usr/bin/env node
// v1.2 end-to-end smoke suite (Task 15).
//
// Boots a real `node server/index.js` against a scratch SQLite file, seeds
// users/saves/config directly through server/db.js (same trick
// tests/api.test.js uses for supertest - here we drive a real HTTP server
// plus a real browser instead), mints JWT cookies via server/auth.js, and
// drives the *built* client (client/dist, served by the app itself) with
// Playwright/Chromium.
//
// Requires a built client (`cd client && npm run build`) and Playwright with
// the Chromium browser downloaded. Playwright is intentionally NOT a
// dependency of this repo (this is the only thing that needs it) - install
// it ad hoc when you want to run this:
//   npm i -D playwright && npx playwright install --with-deps chromium
//   node tests/e2e/smoke-v12.mjs
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
import { readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
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
  // Bounded depth-first walk from each /tmp/claude-* dir looking for
  // .../node_modules/playwright/index.mjs, so we don't need to know the
  // exact session-uuid path segment.
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

const PORT = 3801;
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = '/tmp/e2e-v12.db';
const JWT_SECRET = '5f3c1a2b4d6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9001122334455667788';
const OWNER_ID = 'github:37058311';
const SUPER_ADMIN_IDS = OWNER_ID;

for (const ext of ['', '-wal', '-shm']) {
  try { rmSync(DB_PATH + ext, { force: true }); } catch (e) { /* ignore */ }
}

process.env.JWT_SECRET = JWT_SECRET;
process.env.SUPER_ADMIN_IDS = SUPER_ADMIN_IDS;
process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = 'test';

// Dynamic imports (not hoisted above the env assignments above) - same
// reasoning as tests/api.test.js and tests/db.test.js: server/db.js reads
// DB_PATH and server/auth.js reads JWT_SECRET/SUPER_ADMIN_IDS at
// module-evaluation time.
const { upsertUser, putSave, setToursCompleted, driver } = await import(path.join(REPO_ROOT, 'server', 'db.js'));
const { TOUR_IDS } = await import(path.join(REPO_ROOT, 'shared', 'tours.js'));
const { issueToken, COOKIE_NAME } = await import(path.join(REPO_ROOT, 'server', 'auth.js'));
const { initialState } = await import(path.join(REPO_ROOT, 'shared', 'state.js'));
const { fmt } = await import(path.join(REPO_ROOT, 'shared', 'gameRules.js'));

// Multiple processes will hold this same SQLite file open (this harness for
// seeding, plus the spawned server for real traffic) - WAL mode allows
// concurrent readers/writers, but give writers a generous busy timeout so a
// harmless lock collision during a concurrent write retries instead of
// throwing outright. Postgres has no such pragma (MVCC handles concurrent
// writers instead), so only apply this against the SQLite driver.
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
// Seeding helpers
// ---------------------------------------------------------------------------

let seq = 0;
// v1.6: these suites exercise pre-v1.6 features, so their seeded players
// start with the guided tours already completed - otherwise the onboarding
// tour auto-starts over the built client and its overlay swallows the clicks
// these checks depend on. New-player tour behaviour is covered by smoke-v16.
async function seedUser({ provider, providerId, username }) {
  seq += 1;
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
  const owner = await seedUser({ provider: 'github', providerId: '37058311', username: 'owner_e2e' });
  const fixtureUser = await seedUser({ provider: 'discord', providerId: 'e2e-fixture', username: 'fixture_e2e' });
  const econUser = await seedUser({ provider: 'discord', providerId: 'e2e-econ', username: 'econ_e2e' });
  const nameUser1 = await seedUser({ provider: 'discord', providerId: 'e2e-name1', username: 'name1_e2e' });
  const nameUser2 = await seedUser({ provider: 'discord', providerId: 'e2e-name2', username: 'name2_e2e' });
  const gamesUser = await seedUser({ provider: 'discord', providerId: 'e2e-games', username: 'games_e2e' });

  assert(`${owner.id}` === OWNER_ID, `expected seeded owner id ${OWNER_ID}, got ${owner.id}`);

  // v1.1 fixture: last_save ~2h ago so migration + offline gain both fire.
  const v11Fixture = JSON.parse(
    readFileSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'v11-save.json'), 'utf8'),
  );
  await putSave(fixtureUser.id, v11Fixture, Date.now() - 2 * 3600 * 1000);

  // econUser: flush credits so buy/collect/vent are trivially affordable
  // through the real action API (this is what we're testing - not the cost
  // curve, which is already covered by unit tests).
  {
    const s = initialState();
    s.run.credits = 1_000_000;
    await putSave(econUser.id, s, Date.now());
  }

  // nameUser1: fixed heat, zero overclock nodes (so it never changes on its
  // own) - used later to prove a non-admin's heat bar rescales purely from
  // the admin's config edit. tiers[3].owned>=1 just to unlock the Overclock
  // tab in the UI so the heat bar is reachable at all.
  {
    const s = initialState();
    s.run.heat = 50;
    s.run.tiers[3].owned = 1;
    await putSave(nameUser1.id, s, Date.now());
  }

  // --- Check A: v1.1 fixture migrates + renders, offline gain fires ------
  await check('v1.1 fixture migrates and renders credits/wafers + offline gain', async () => {
    const context = await browser.newContext();
    await context.addCookies([cookieFor(fixtureUser)]);
    const page = await newPage(context);
    const state = await bootAndGetState(page);

    assert(state.offlineGain > 1, `expected offline gain > 1, got ${state.offlineGain}`);
    assert(state.run.tiers.length === 14, `expected 14 padded tiers, got ${state.run.tiers.length}`);
    assert(state.meta.wafers === 7, `expected migrated wafers=7, got ${state.meta.wafers}`);

    const body = await page.textContent('body');
    assert(body.includes(fmt(state.run.credits)), `page text missing formatted credits ${fmt(state.run.credits)}`);
    assert(body.includes(fmt(state.meta.wafers)), `page text missing formatted wafers ${fmt(state.meta.wafers)}`);
    assert(body.includes('Welcome back'), 'expected the welcome/offline-gain modal to be showing');
    assert(body.includes(`+${fmt(state.offlineGain)} FLOPS`), 'welcome modal missing the formatted offline gain amount');

    await context.close();
  });

  // --- Check B: buy/collect/vent persist across a hard reload ------------
  let econContext;
  let econPage;
  await check('buy/collect/vent persist across a hard reload (server truth)', async () => {
    econContext = await browser.newContext();
    await econContext.addCookies([cookieFor(econUser)]);
    econPage = await newPage(econContext);
    await bootAndGetState(econPage);

    const buyTiers = await apiFetch(econPage, '/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actions: [
          { id: 1, type: 'buy', lane: 'tiers', index: 0, mode: 50 },
          // Also unlocks the Overclock tab in the UI (tiers[3].owned >= 1),
          // needed later in Check C when we navigate there as this user.
          { id: 2, type: 'buy', lane: 'tiers', index: 3, mode: 1 },
        ],
      }),
    });
    assert(buyTiers.status === 200, `buy tiers status ${buyTiers.status}`);
    assert(buyTiers.body.results[0].ok === true, 'buy tiers rejected');
    assert(buyTiers.body.results[1].ok === true, 'buy tiers[3] rejected');
    assert(buyTiers.body.state.run.tiers[0].owned === 50, `expected tiers[0].owned=50, got ${buyTiers.body.state.run.tiers[0].owned}`);

    // Let unmanaged tier0 production accrue into `ready`.
    await econPage.waitForTimeout(2500);

    const collect = await apiFetch(econPage, '/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{ id: 3, type: 'collect', index: 0 }] }),
    });
    assert(collect.status === 200, `collect status ${collect.status}`);
    assert(collect.body.results[0].ok === true, `collect rejected: ${JSON.stringify(collect.body.results[0])}`);
    assert(collect.body.state.run.tiers[0].ready === 0, 'expected tiers[0].ready reset to 0 after collect');
    const creditsAfterCollect = collect.body.state.run.credits;

    const buyOverclock = await apiFetch(econPage, '/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{ id: 4, type: 'buy', lane: 'overclock', index: 0, mode: 20 }] }),
    });
    assert(buyOverclock.status === 200, `buy overclock status ${buyOverclock.status}`);
    assert(buyOverclock.body.results[0].ok === true, 'buy overclock rejected');
    assert(buyOverclock.body.state.run.overclock[0].owned === 20, 'expected overclock[0].owned=20');

    // Let heat build up.
    await econPage.waitForTimeout(1500);

    const beforeVent = await apiFetch(econPage, '/api/state', { method: 'GET' });
    const heatBeforeVent = beforeVent.body.run.heat;
    assert(heatBeforeVent > 0, `expected some heat before venting, got ${heatBeforeVent}`);

    const vent = await apiFetch(econPage, '/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{ id: 5, type: 'vent' }] }),
    });
    assert(vent.status === 200, `vent status ${vent.status}`);
    assert(vent.body.results[0].ok === true, `vent rejected: ${JSON.stringify(vent.body.results[0])}`);
    const heatAfterVent = vent.body.state.run.heat;
    assert(heatAfterVent < heatBeforeVent, `expected heat to drop after venting (${heatBeforeVent} -> ${heatAfterVent})`);

    const expectedCredits = vent.body.state.run.credits;
    const expectedTier0Owned = vent.body.state.run.tiers[0].owned;
    const expectedOverclock0Owned = vent.body.state.run.overclock[0].owned;

    // Hard reload: nothing here is localStorage - a fresh GET /api/state is
    // the only source of truth the client has.
    const reloaded = await bootAndGetState(econPage);
    assert(reloaded.run.credits === expectedCredits, `credits didn't survive reload: expected ${expectedCredits}, got ${reloaded.run.credits}`);
    assert(reloaded.run.tiers[0].owned === expectedTier0Owned, 'tiers[0].owned did not survive reload');
    assert(reloaded.run.overclock[0].owned === expectedOverclock0Owned, 'overclock[0].owned did not survive reload');

    const body = await econPage.textContent('body');
    assert(body.includes(fmt(expectedCredits)), `reloaded page missing formatted credits ${fmt(expectedCredits)}`);
    assert(creditsAfterCollect > 0, 'sanity: credits after collect should be positive');
  });

  // --- Check C: admin edits heat.capacity via dashboard; overheat has no
  //     node loss; a different non-admin's heat bar rescales on reload ----
  await check('admin config edit -> overheat lockout with no node loss + non-admin heat bar rescales', async () => {
    // Push econUser's heat right up to the (still-default) capacity so a
    // few real seconds of overclock production tips it over once we drop
    // the configured capacity way down.
    const beforeOverheat = await apiFetch(econPage, '/api/state', { method: 'GET' });
    const overclockOwnedBefore = beforeOverheat.body.run.overclock[0].owned;
    assert(overclockOwnedBefore > 0, 'expected econUser to already own overclock nodes from the previous check');

    const ownerContext = await browser.newContext();
    await ownerContext.addCookies([cookieFor(owner)]);
    const ownerPage = await newPage(ownerContext);
    await bootAndGetState(ownerPage);

    await ownerPage.getByTitle('View profile').click();
    await ownerPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await ownerPage.getByRole('button', { name: 'Balancing', exact: true }).click();

    const capacityInput = ownerPage.getByTestId('tunable-heat.capacity');
    await capacityInput.waitFor({ state: 'visible' });
    await capacityInput.fill('100');
    const saveBtn = ownerPage.getByTestId('balancing-save');
    await saveBtn.click();
    await ownerPage.getByText(/^Saved as version/).waitFor({ timeout: 5000 });

    const cfgAfter = await apiFetch(ownerPage, '/api/config', { method: 'GET' });
    assert(cfgAfter.body.data.heat.capacity === 100, `expected live config heat.capacity=100, got ${cfgAfter.body.data.heat.capacity}`);

    // Directly seed heat close to the new (tiny) capacity so a short real
    // wait is enough to cross it (rather than waiting on the full climb
    // from wherever the previous check left it) - the overheat mechanic
    // itself (evaluate()'s heat-cap crossing -> cooldown, zero heat,
    // one-shot `overheated` flag, no owned-count change) is exactly what's
    // under test here, not the production math (covered by unit tests).
    await putSave(econUser.id, {
      run: { ...beforeOverheat.body.run, heat: 95 },
      meta: beforeOverheat.body.meta,
      server: beforeOverheat.body.server,
    }, Date.now());

    await econPage.waitForTimeout(3000);
    const overheated = await bootAndGetState(econPage);

    assert(overheated.run.heat === 0, `expected heat reset to 0 after overheat, got ${overheated.run.heat}`);
    assert(typeof overheated.run.heatCooldownUntil === 'number' && overheated.run.heatCooldownUntil > Date.now(),
      'expected an active heatCooldownUntil in the future');
    assert(overheated.run.overclock[0].owned === overclockOwnedBefore,
      `expected no node loss: overclock[0].owned should still be ${overclockOwnedBefore}, got ${overheated.run.overclock[0].owned}`);

    const bodyText = await econPage.textContent('body');
    assert(bodyText.includes('Overheated!'), 'expected the meltdown modal');
    assert(bodyText.includes('no nodes were lost'), 'expected the meltdown modal to reassure no nodes were lost');

    // Dismiss the meltdown modal, switch to the Overclock tab, and check
    // the frozen-lane messaging + disabled Vent button.
    await econPage.getByRole('button', { name: 'Understood', exact: true }).click();
    await econPage.getByRole('button', { name: 'Overclock', exact: true }).click();
    await econPage.getByText(/Overclock lane frozen after meltdown/).waitFor({ timeout: 3000 });
    // v1.6: the label carries the live vent percentage ("Vent Heat (-25%)"),
    // so match the prefix rather than the whole string.
    const ventBtn = econPage.getByRole('button', { name: /^Vent Heat/ });
    assert(await ventBtn.isDisabled(), 'expected Vent Heat to be disabled during the meltdown lockout');

    // Non-admin heat-bar rescale: nameUser1's raw heat (50) never changed;
    // only the capacity did (2000 -> 100), so their displayed percentage
    // should now read 50% instead of 2.5%.
    const nameContext = await browser.newContext();
    await nameContext.addCookies([cookieFor(nameUser1)]);
    const namePage = await newPage(nameContext);
    await bootAndGetState(namePage);
    await namePage.getByRole('button', { name: 'Overclock', exact: true }).click();
    const heatPctText = await namePage.locator('text=/^\\d+%$/').first().innerText();
    assert(heatPctText === '50%', `expected nameUser1's heat bar to read 50% after the capacity drop, got ${heatPctText}`);

    await ownerContext.close();
    await nameContext.close();
  });
  if (econContext) await econContext.close();

  // --- Check D: Balance overlay risk strips + live scoring ---------------
  await check('Balance overlay shows config-driven risk strips and +5/-2 scoring', async () => {
    const context = await browser.newContext();
    await context.addCookies([cookieFor(gamesUser)]);
    const page = await newPage(context);
    await bootAndGetState(page);

    const cfgRes = await apiFetch(page, '/api/config', { method: 'GET' });
    const z = cfgRes.body.data.minigames.balance;

    await page.getByRole('button', { name: 'Games', exact: true }).click();
    await page.getByRole('button', { name: 'Play', exact: true }).nth(3).click();
    await page.getByTestId('balance-overlay').waitFor({ state: 'visible' });

    const safe = await page.getByTestId('balance-zone-safe').evaluate((el) => ({ left: el.style.left, width: el.style.width }));
    const riskLow = await page.getByTestId('balance-zone-risk-low').evaluate((el) => ({ left: el.style.left, width: el.style.width }));
    const riskHigh = await page.getByTestId('balance-zone-risk-high').evaluate((el) => ({ left: el.style.left, width: el.style.width }));

    assert(safe.left === `${z.safeZoneMin}%`, `safe zone left: expected ${z.safeZoneMin}%, got ${safe.left}`);
    assert(safe.width === `${z.safeZoneMax - z.safeZoneMin}%`, `safe zone width mismatch: got ${safe.width}`);
    assert(riskLow.left === `${z.safeZoneMin}%`, `risk-low left mismatch: got ${riskLow.left}`);
    assert(riskLow.width === `${z.riskZoneWidth}%`, `risk-low width mismatch: got ${riskLow.width}`);
    assert(riskHigh.left === `${z.safeZoneMax - z.riskZoneWidth}%`, `risk-high left mismatch: got ${riskHigh.left}`);
    assert(riskHigh.width === `${z.riskZoneWidth}%`, `risk-high width mismatch: got ${riskHigh.width}`);

    async function readScore() {
      const text = await page.getByTestId('balance-score').innerText();
      const m = /^(-?\d+)/.exec(text);
      return m ? Number(m[1]) : NaN;
      }

    async function needleInRiskZone() {
      return page.evaluate((cfg) => {
        const el = document.querySelector('[data-testid="balance-needle"]');
        if (!el) return false;
        const m = /calc\(([-0-9.]+)%/.exec(el.style.left);
        if (!m) return false;
        const pos = parseFloat(m[1]);
        return (pos >= cfg.safeZoneMin && pos <= cfg.safeZoneMin + cfg.riskZoneWidth)
          || (pos >= cfg.safeZoneMax - cfg.riskZoneWidth && pos <= cfg.safeZoneMax);
      }, z);
    }

    let riskDelta = null;
    const huntDeadline = Date.now() + 10000;
    while (riskDelta !== z.pointsRisk && Date.now() < huntDeadline) {
      try {
        await page.waitForFunction((cfg) => {
          const el = document.querySelector('[data-testid="balance-needle"]');
          if (!el) return false;
          const m = /calc\(([-0-9.]+)%/.exec(el.style.left);
          if (!m) return false;
          const pos = parseFloat(m[1]);
          return (pos >= cfg.safeZoneMin && pos <= cfg.safeZoneMin + cfg.riskZoneWidth)
            || (pos >= cfg.safeZoneMax - cfg.riskZoneWidth && pos <= cfg.safeZoneMax);
        }, z, { timeout: 2000, polling: 20 });
      } catch (e) {
        continue; // eslint-disable-line no-continue
      }
      if (!(await needleInRiskZone())) continue; // eslint-disable-line no-continue
      const before = await readScore();
      await page.getByTestId('balance-bar').click();
      const after = await readScore();
      riskDelta = after - before;
    }
    assert(riskDelta === z.pointsRisk, `expected a +${z.pointsRisk} risk-zone score at some point, last delta was ${riskDelta}`);

    const beforeMiss = await readScore();
    await page.mouse.click(5, 5); // top-left corner: outside the centered overlay content -> guaranteed miss
    const afterMiss = await readScore();
    assert(afterMiss === beforeMiss - z.missPenalty, `expected a -${z.missPenalty} miss penalty, got delta ${afterMiss - beforeMiss}`);

    await page.getByTestId('balance-cancel').click();
    await context.close();
  });

  // --- Check E: minigame win cooldown enforced across reload -------------
  await check('minigame win cooldown enforced after a win, across reload', async () => {
    const context = await browser.newContext();
    await context.addCookies([cookieFor(gamesUser)]);
    const page = await newPage(context);
    await bootAndGetState(page);

    const start = await apiFetch(page, '/api/minigame/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: 'rush' }),
    });
    assert(start.status === 200, `minigame start status ${start.status}`);

    const finish = await apiFetch(page, '/api/minigame/finish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: start.body.sessionId, metric: 999999 }),
    });
    assert(finish.status === 200, `minigame finish status ${finish.status}`);
    assert(finish.body.wafers > 0, 'expected a positive wafer payout from maxing out the rush metric');
    assert(finish.body.state.server.gameCooldowns.rush > Date.now(), 'expected rush cooldown to be set in the future');

    await page.reload();
    await page.waitForResponse((r) => r.url().endsWith('/api/state'));
    await page.getByRole('button', { name: 'Games', exact: true }).click();
    await page.getByText(/^Cooldown \d+s$/).first().waitFor({ timeout: 3000 });

    await context.close();
  });

  // --- Check F: username change reflected in header; collision rejected --
  await check('username change reflects in header; collision rejected visibly', async () => {
    const ctx1 = await browser.newContext();
    await ctx1.addCookies([cookieFor(nameUser1)]);
    const page1 = await newPage(ctx1);
    await bootAndGetState(page1);

    await page1.getByTitle('View profile').click();
    await page1.getByRole('button', { name: 'Settings', exact: true }).click();
    const newName = 'e2eRenamedUser';
    await page1.getByRole('textbox').fill(newName);
    await page1.getByRole('button', { name: 'Save', exact: true }).click();
    await page1.getByText('Saved.').waitFor({ timeout: 3000 });
    await page1.getByTestId('profile-close').click();

    const headerName = await page1.getByTitle('View profile').locator('span').innerText();
    assert(headerName === newName, `expected header to show "${newName}", got "${headerName}"`);

    const ctx2 = await browser.newContext();
    await ctx2.addCookies([cookieFor(nameUser2)]);
    const page2 = await newPage(ctx2);
    await bootAndGetState(page2);

    await page2.getByTitle('View profile').click();
    await page2.getByRole('button', { name: 'Settings', exact: true }).click();
    await page2.getByRole('textbox').fill(newName.toUpperCase()); // case-insensitive collision
    await page2.getByRole('button', { name: 'Save', exact: true }).click();
    await page2.getByText('That name is taken').waitFor({ timeout: 3000 });

    // --- Check G rides along on this same non-admin session: no Balancing
    //     tab, and a direct admin PUT from their own cookie is 403'd. -----
    const adminSectionCount = await page2.getByText('ADMIN', { exact: true }).count();
    assert(adminSectionCount === 0, 'expected no admin section at all for a non-admin/non-owner user');
    const balancingTabCount = await page2.getByRole('button', { name: 'Balancing', exact: true }).count();
    assert(balancingTabCount === 0, 'expected no Balancing tab for a non-admin user');

    const forbidden = await apiFetch(page2, '/api/admin/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: {} }),
    });
    assert(forbidden.status === 403, `expected 403 from a non-admin PUT /api/admin/config, got ${forbidden.status}`);

    await ctx1.close();
    await ctx2.close();
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
