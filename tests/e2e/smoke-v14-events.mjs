#!/usr/bin/env node
// v1.4 Live Events - admin Events tab end-to-end smoke suite (Task 8).
//
// Boots a real `node server/index.js` against a scratch SQLite file, seeds
// users/roles directly through server/db.js (same trick tests/e2e/smoke-v12
// and smoke-v13 use), mints JWT cookies via server/auth.js, and drives the
// *built* client (client/dist, served by the app itself) with
// Playwright/Chromium. Follows smoke-v13.mjs's exact structure: same
// Playwright-resolution fallback, same server-spawn/teardown pattern, same
// check()/assert() bookkeeping, same JWT-signing approach.
//
// Requires a built client (`cd client && npm run build`) and Playwright with
// the Chromium browser downloaded. Every check prints `PASS <name>` or
// `FAIL <name>: <reason>` as it runs; exits non-zero if anything failed.

import { spawn } from 'node:child_process';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

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

const PORT = 3804;
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = '/tmp/e2e-v14-events.db';
const JWT_SECRET = '5f3c1a2b4d6e8f0a1b2c3d4e5f60718293a4b5c6d7e8f9001122334455667799';
const OWNER_ID = 'github:37058311';
const SUPER_ADMIN_IDS = OWNER_ID;

for (const ext of ['', '-wal', '-shm']) {
  try { rmSync(DB_PATH + ext, { force: true }); } catch (e) { /* ignore */ }
}

process.env.JWT_SECRET = JWT_SECRET;
process.env.SUPER_ADMIN_IDS = SUPER_ADMIN_IDS;
process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = 'test';

const { upsertUser, setRoles, setToursCompleted, db } = await import(path.join(REPO_ROOT, 'server', 'db.js'));
const { TOUR_IDS } = await import(path.join(REPO_ROOT, 'shared', 'tours.js'));
const { issueToken, COOKIE_NAME } = await import(path.join(REPO_ROOT, 'server', 'auth.js'));

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

async function main() {
  console.log(`Starting server on ${BASE_URL} (DB_PATH=${DB_PATH})...`);
  await startServer();
  console.log('Server up.');

  const pw = await loadPlaywright();
  browser = await pw.chromium.launch();

  // --- Seed users -----------------------------------------------------------
  const owner = await seedUser({ provider: 'github', providerId: '37058311', username: 'owner_ev_e2e' });
  assert(`${owner.id}` === OWNER_ID, `expected seeded owner id ${OWNER_ID}, got ${owner.id}`);

  // A PURE event_coordinator - explicitly NOT granted 'admin' - proving the
  // brief's requirement that a coordinator-only account can reach the panel
  // and see ONLY the Events tab.
  const coordinator = await seedUser({ provider: 'discord', providerId: 'e2e-ev-coord', username: 'coord_ev_e2e' });
  await setRoles(coordinator.id, ['event_coordinator']);

  // A plain, non-admin, non-coordinator player - used to confirm the event
  // becomes visible to a genuinely unprivileged second user once activated.
  const player = await seedUser({ provider: 'discord', providerId: 'e2e-ev-player', username: 'player_ev_e2e' });

  const eventId = `e2e-surge-${Date.now()}`;

  // --- Check A: a pure coordinator (no 'admin') sees ONLY the Events tab ---
  const coordContext = await browser.newContext();
  await coordContext.addCookies([cookieFor(coordinator)]);
  const coordPage = await coordContext.newPage();

  await check('pure event_coordinator (non-admin) reaches the admin panel and sees only the Events tab', async () => {
    await bootAndGetState(coordPage);
    await coordPage.getByTitle('View profile').click();
    await coordPage.getByRole('button', { name: 'Settings', exact: true }).click();

    const adminHeading = coordPage.getByText('ADMIN', { exact: true });
    assert(await adminHeading.count() === 1, 'expected the ADMIN panel to be visible to a pure event_coordinator');

    assert(await coordPage.getByRole('button', { name: 'Users', exact: true }).count() === 0, 'expected no Users tab for a pure coordinator');
    assert(await coordPage.getByRole('button', { name: 'Balancing', exact: true }).count() === 0, 'expected no Balancing tab for a pure coordinator');
    assert(await coordPage.getByRole('button', { name: 'Roles', exact: true }).count() === 0, 'expected no Roles tab for a pure coordinator');

    // Only one tab visible -> AdminPanel's tab-switcher bar (tabs.length > 1)
    // doesn't even render; the Events content should still show directly,
    // once its own GET /api/admin/events fetch resolves.
    await coordPage.getByTestId('events-new').waitFor({ state: 'visible', timeout: 5000 });
  });

  // --- Check B: full lifecycle - author, schedule, activate, verify note
  //     persists (the useEffect bug), then confirm visible to a second
  //     non-admin user, then end it -----------------------------------------
  await check('author a new event end-to-end: create, schedule, activate (note persists), visible to a second user, end', async () => {
    // --- Create -------------------------------------------------------------
    await coordPage.getByTestId('events-new').click();
    await coordPage.getByTestId('event-id').fill(eventId);
    await coordPage.getByTestId('event-name').fill('E2E Surge Week');
    await coordPage.getByTestId('event-description').fill('An automated end-to-end test event.');

    // Ladder: one rung, flopsEarned metric, target 1 (trivially satisfiable),
    // wafers reward - the default rung already has metric=flopsEarned.
    await coordPage.getByTestId('add-rung').click();
    await coordPage.getByTestId('rung-target-0').fill('1');
    await coordPage.getByTestId('rung-wafers-0').fill('500');

    const saveBtn = coordPage.getByTestId('event-save');
    assert(!(await saveBtn.isDisabled()), 'expected Create draft to be enabled once id/name/ladder are valid');
    const [createResp] = await Promise.all([
      coordPage.waitForResponse((r) => r.url().endsWith('/api/admin/events') && r.request().method() === 'POST'),
      saveBtn.click(),
    ]);
    assert(createResp.status() === 201, `expected 201 from create, got ${createResp.status()}`);

    // THE BUG UNDER TEST: right after creation, the success note must still
    // be visible (not wiped by the fresh-object-reference re-render), AND
    // the editor must have switched out of "New event" mode into the
    // existing-event view (Window/Schedule/Activate section appears).
    await coordPage.waitForTimeout(50);
    const createNote = coordPage.getByText('Event created as a draft.', { exact: true });
    assert(await createNote.count() === 1, 'expected the "Event created as a draft." success note to still be visible right after creation (useEffect identity-reset bug)');
    assert(await coordPage.getByTestId('event-schedule').count() === 1, 'expected the Schedule button to appear once the draft becomes the loaded event');

    // --- Schedule: a window that starts now and ends in the near future -----
    const now = Date.now();
    const startsAt = new Date(now - 60000); // 1 minute ago, so "activate" is immediately within-window
    const endsAt = new Date(now + 2 * 3600 * 1000); // 2 hours from now

    function toLocalInputValue(d) {
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    await coordPage.getByTestId('event-starts-at').fill(toLocalInputValue(startsAt));
    await coordPage.getByTestId('event-ends-at').fill(toLocalInputValue(endsAt));

    const scheduleBtn = coordPage.getByTestId('event-schedule');
    const [scheduleResp] = await Promise.all([
      coordPage.waitForResponse((r) => r.url().endsWith(`/api/admin/events/${eventId}/schedule`) && r.request().method() === 'POST'),
      scheduleBtn.click(),
    ]);
    assert(scheduleResp.status() === 200, `expected 200 from schedule, got ${scheduleResp.status()}: ${JSON.stringify(await scheduleResp.json().catch(() => null))}`);

    await coordPage.waitForTimeout(50);
    const scheduleNoteRe = /^Scheduled:/;
    const scheduleNote = coordPage.getByText(scheduleNoteRe);
    assert(await scheduleNote.count() === 1, 'expected the "Scheduled: ..." success note to be visible right after scheduling (same useEffect bug, second flow)');

    // --- Activate ------------------------------------------------------------
    const activateBtn = coordPage.getByTestId('event-activate');
    assert(!(await activateBtn.isDisabled()), 'expected Activate to be enabled once a valid future-ending window is scheduled');
    const [activateResp] = await Promise.all([
      coordPage.waitForResponse((r) => r.url().endsWith(`/api/admin/events/${eventId}/activate`) && r.request().method() === 'POST'),
      activateBtn.click(),
    ]);
    assert(activateResp.status() === 200, `expected 200 from activate, got ${activateResp.status()}: ${JSON.stringify(await activateResp.json().catch(() => null))}`);

    await coordPage.waitForTimeout(50);
    const activateNote = coordPage.getByText('Activated.', { exact: true });
    assert(await activateNote.count() === 1, 'expected the "Activated." success note to be visible right after activating (same useEffect bug, third flow)');

    const activeBadge = coordPage.getByText('active', { exact: true });
    assert(await activeBadge.count() >= 1, 'expected an "active" status badge after activating');

    // --- Edit an ACTIVE event's name/description only -------------------------
    // The server's PUT gate is PRESENCE-based (hasOwnProperty on ladder/
    // modifiers), not diff-based, so a payload that echoes the unchanged
    // ladder/modifiers back 409s 'event_active' even for a pure name edit.
    // handleSave must omit both keys while active, and the editors must be
    // locked so the UI doesn't imply otherwise.
    assert(await coordPage.getByTestId('modifiers-locked').count() === 1, 'expected the Modifiers section to show its locked notice while the event is active');
    assert(await coordPage.getByTestId('ladder-locked').count() === 1, 'expected the Ladder section to show its locked notice while the event is active');
    assert(await coordPage.getByTestId('add-modifier').count() === 0, 'expected the Add-modifier button to be hidden while the event is active');
    assert(await coordPage.getByTestId('add-rung').count() === 0, 'expected the Add-rung button to be hidden while the event is active');
    assert(await coordPage.getByTestId('rung-target-0').isDisabled(), 'expected existing rung inputs to be disabled while the event is active');
    assert(await coordPage.getByTestId('rung-remove-0').count() === 0, 'expected the per-rung Remove button to be hidden while the event is active');

    await coordPage.getByTestId('event-name').fill('E2E Surge Week (renamed live)');
    const activeSaveBtn = coordPage.getByTestId('event-save');
    assert(!(await activeSaveBtn.isDisabled()), 'expected Save to stay enabled for a name-only edit on an active event');
    const [activeEditResp] = await Promise.all([
      coordPage.waitForResponse((r) => r.url().endsWith(`/api/admin/events/${eventId}`) && r.request().method() === 'PUT'),
      activeSaveBtn.click(),
    ]);
    assert(activeEditResp.status() === 200, `expected 200 renaming an ACTIVE event, got ${activeEditResp.status()}: ${JSON.stringify(await activeEditResp.json().catch(() => null))} - a 409 event_active here means handleSave is still sending ladder/modifiers keys`);
    const activeEditBody = await activeEditResp.request().postDataJSON();
    assert(!('modifiers' in activeEditBody) && !('ladder' in activeEditBody), `expected the active-event PUT body to omit modifiers/ladder entirely, got keys: ${Object.keys(activeEditBody).join(', ')}`);

    // Restore the name so the second user's banner assertion below is unchanged.
    await coordPage.getByTestId('event-name').fill('E2E Surge Week');
    const [restoreResp] = await Promise.all([
      coordPage.waitForResponse((r) => r.url().endsWith(`/api/admin/events/${eventId}`) && r.request().method() === 'PUT'),
      coordPage.getByTestId('event-save').click(),
    ]);
    assert(restoreResp.status() === 200, `expected 200 restoring the active event's name, got ${restoreResp.status()}`);

    // --- Confirm visible to a SECOND, non-admin, non-coordinator user ------
    const playerContext = await browser.newContext();
    await playerContext.addCookies([cookieFor(player)]);
    const playerPage = await playerContext.newPage();
    const playerState = await bootAndGetState(playerPage);
    assert(playerState.activeEvent && playerState.activeEvent.id === eventId, `expected the second user's /api/state to report activeEvent.id=${eventId}, got ${JSON.stringify(playerState.activeEvent)}`);

    const banner = playerPage.getByText('E2E Surge Week live', { exact: false });
    assert(await banner.count() >= 1, 'expected the EventBanner to show "E2E Surge Week live" for the second, unprivileged user');

    await playerContext.close();

    // --- End -----------------------------------------------------------------
    const endBtn = coordPage.getByTestId('event-end');
    const [endResp] = await Promise.all([
      coordPage.waitForResponse((r) => r.url().endsWith(`/api/admin/events/${eventId}/end`) && r.request().method() === 'POST'),
      endBtn.click(),
    ]);
    assert(endResp.status() === 200, `expected 200 from end, got ${endResp.status()}`);

    await coordPage.waitForTimeout(50);
    const endNote = coordPage.getByText('Ended.', { exact: true });
    assert(await endNote.count() === 1, 'expected the "Ended." success note to be visible right after ending (same useEffect bug, fourth flow)');
    const endedBadge = coordPage.getByText('ended', { exact: true });
    assert(await endedBadge.count() >= 1, 'expected an "ended" status badge after ending');
  });

  // --- Check C: invalid_target on activating an already-past window is
  //     surfaced comprehensibly, and does NOT read as "Event unavailable"
  //     (the RackStack.jsx REJECT_MESSAGES fix is player-toast-only, but this
  //     confirms the admin-side inline message for the analogous 400 is sane
  //     too) --------------------------------------------------------------
  await check('activating an event whose window has already passed is rejected with a comprehensible inline message', async () => {
    const pastId = `e2e-past-${Date.now()}`;
    const create = await apiFetch(coordPage, '/api/admin/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: pastId,
        name: 'E2E Past Window',
        ladder: [{ metric: 'flopsEarned', target: 1, reward: { wafers: 1 } }],
      }),
    });
    assert(create.status === 201, `expected 201 creating past-window event, got ${create.status}`);

    const schedule = await apiFetch(coordPage, `/api/admin/events/${pastId}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ startsAt: Date.now() - 2 * 3600 * 1000, endsAt: Date.now() - 3600 * 1000 }),
    });
    assert(schedule.status === 200, `expected 200 scheduling past window, got ${schedule.status}`);

    const activate = await apiFetch(coordPage, `/api/admin/events/${pastId}/activate`, { method: 'POST' });
    assert(activate.status === 400 && activate.body.error === 'invalid_target', `expected 400 invalid_target activating a past window, got ${activate.status} ${JSON.stringify(activate.body)}`);

    // Now drive it through the actual UI to check the rendered message.
    await coordPage.reload();
    await coordPage.waitForResponse((r) => r.url().endsWith('/api/state'));
    await coordPage.getByTitle('View profile').click();
    await coordPage.getByRole('button', { name: 'Settings', exact: true }).click();
    await coordPage.getByTestId(`event-row-${pastId}`).click();

    const [activateResp2] = await Promise.all([
      coordPage.waitForResponse((r) => r.url().endsWith(`/api/admin/events/${pastId}/activate`) && r.request().method() === 'POST'),
      coordPage.getByTestId('event-activate').click(),
    ]);
    assert(activateResp2.status() === 400, `expected 400 from UI-driven activate, got ${activateResp2.status()}`);
    await coordPage.waitForTimeout(50);
    const msg = coordPage.getByText(/window has already passed/i);
    assert(await msg.count() === 1, 'expected a comprehensible "window has already passed" inline message for invalid_target on activate');
  });

  await coordContext.close();
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
