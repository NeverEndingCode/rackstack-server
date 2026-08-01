#!/usr/bin/env node
// v1.6 Onboarding & QoL - end-to-end smoke suite (Task 14).
//
// Covers:
//
//   1. GET /api/me returns a toursCompleted array.
//   2. PUT /api/me/tours { onboarding, true } returns 200 and a set
//      containing 'onboarding'.
//   3. GET /api/me then reflects it.
//   4. PUT { onboarding, false } removes it (the replay path).
//   5. PUT with an unregistered tour id returns 400.
//   6. GET /api/config exposes heat.ventPercent and heat.overheatPopupMs, and
//      no longer exposes heat.ventAmount.
//   7. A `vent` action through POST /api/actions sheds 25% of capacity.
//   8. A fresh player actually SEES the tour over the built client: the
//      overlay renders, Next advances the counter and switches tabs.
//   9. Skip closes it and persists, so a reload does not re-show it.
//
// Same harness shape as smoke-v15.mjs - boots a real `node server/index.js`
// against a scratch SQLite file, seeds users/saves through server/db.js and
// mints JWT cookies via server/auth.js - but deliberately WITHOUT Playwright:
// checks 1-7 are pure API invariants, so a plain authenticated fetch is
// sufficient for them. Checks 8-9 do need the real client, and use the same
// Playwright resolution the other suites do; if no browser can be resolved
// they are SKIPped rather than failed, so this suite still runs headless.
//
// Every check prints `PASS <name>` or `FAIL <name>: <reason>`. At the end:
// `=== ERRORS ===` followed by each failure, or `NONE`. Exits non-zero if
// anything failed. The server child process is always killed on the way out.

import { spawn } from 'node:child_process';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

const PORT = 3807;
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = '/tmp/e2e-v16.db';
const JWT_SECRET = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80';

for (const ext of ['', '-wal', '-shm']) {
  try { rmSync(DB_PATH + ext, { force: true }); } catch (e) { /* ignore */ }
}

process.env.JWT_SECRET = JWT_SECRET;
process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = 'test';

const { upsertUser, putSave, db } = await import(path.join(REPO_ROOT, 'server', 'db.js'));
const { issueToken, COOKIE_NAME } = await import(path.join(REPO_ROOT, 'server', 'auth.js'));
const { initialState } = await import(path.join(REPO_ROOT, 'shared', 'state.js'));
const { TOUR_IDS, ONBOARDING_TOUR_ID } = await import(path.join(REPO_ROOT, 'shared', 'tours.js'));

db.pragma('busy_timeout = 5000');

let serverProc = null;
let shuttingDown = false;

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
      console.error(`\n[server] exited early (code=${code} signal=${signal}); output:\n${out}`);
    }
  });

  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(`${BASE_URL}/`);
      if (res.ok || res.status === 404) break;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) {
      throw new Error(`server did not become ready within 15s; output:\n${out}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }
}

// ---------------------------------------------------------------------------
// Playwright resolution: plain import first, scratchpad fallback second.
// Mirrors smoke-v12..v15 so this suite behaves the same way in CI.
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

async function loadPlaywrightOrNull() {
  try {
    return await import('playwright');
  } catch (e) {
    for (const c of findScratchpadPlaywright()) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await import(`file://${c}`);
      } catch (e2) { /* try the next candidate */ }
    }
    return null;
  }
}

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

let seq = 0;
async function seedUser(mutate) {
  seq += 1;
  const user = await upsertUser({
    provider: 'discord', providerId: `v16-${seq}`, username: `v16user${seq}`, avatarUrl: null,
  });
  const s = initialState();
  if (mutate) mutate(s);
  await putSave(user.id, s, Date.now());
  return user;
}

function cookieFor(user) {
  const token = issueToken({ id: user.id, username: user.username, avatar_url: user.avatar_url });
  return `${COOKIE_NAME}=${token}`;
}

async function api(user, urlPath, opts = {}) {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      cookie: cookieFor(user),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { /* not json */ }
  return { status: res.status, body };
}

async function main() {
  await startServer();

  // --- 1-4: the tours round trip -------------------------------------------

  await check('GET /api/me returns an empty toursCompleted for a fresh user', async () => {
    const u = await seedUser();
    const res = await api(u, '/api/me');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(Array.isArray(res.body.toursCompleted), 'toursCompleted is not an array');
    assert(res.body.toursCompleted.length === 0, `expected [], got ${JSON.stringify(res.body.toursCompleted)}`);
  });

  await check('completing onboarding marks every registered tour, and /api/me reflects it', async () => {
    const u = await seedUser();
    const put = await api(u, '/api/me/tours', {
      method: 'PUT',
      body: JSON.stringify({ tourId: ONBOARDING_TOUR_ID, completed: true }),
    });
    assert(put.status === 200, `expected 200, got ${put.status}`);
    assert(put.body.ok === true, 'expected ok:true');
    const got = [...put.body.toursCompleted].sort();
    const want = [...TOUR_IDS].sort();
    assert(
      JSON.stringify(got) === JSON.stringify(want),
      `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
    );

    const me = await api(u, '/api/me');
    assert(
      me.body.toursCompleted.includes(ONBOARDING_TOUR_ID),
      'GET /api/me did not reflect the completion',
    );
  });

  await check('completed:false removes the tour (replay path)', async () => {
    const u = await seedUser();
    await api(u, '/api/me/tours', {
      method: 'PUT',
      body: JSON.stringify({ tourId: ONBOARDING_TOUR_ID, completed: true }),
    });
    const res = await api(u, '/api/me/tours', {
      method: 'PUT',
      body: JSON.stringify({ tourId: ONBOARDING_TOUR_ID, completed: false }),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(
      !res.body.toursCompleted.includes(ONBOARDING_TOUR_ID),
      'onboarding was not removed',
    );
    const me = await api(u, '/api/me');
    assert(!me.body.toursCompleted.includes(ONBOARDING_TOUR_ID), 'removal did not persist');
  });

  // --- 5: validation --------------------------------------------------------

  await check('an unregistered tour id is rejected with 400', async () => {
    const u = await seedUser();
    const res = await api(u, '/api/me/tours', {
      method: 'PUT',
      body: JSON.stringify({ tourId: 'bogus-tour', completed: true }),
    });
    assert(res.status === 400, `expected 400, got ${res.status}`);
    assert(res.body.error === 'invalid_request', `expected invalid_request, got ${res.body.error}`);
  });

  // --- 6: the new heat tunables --------------------------------------------

  await check('GET /api/config exposes ventPercent + overheatPopupMs and drops ventAmount', async () => {
    const u = await seedUser();
    const res = await api(u, '/api/config');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const heat = res.body.data.heat;
    assert(heat.ventPercent === 25, `expected ventPercent 25, got ${heat.ventPercent}`);
    assert(heat.overheatPopupMs === 15000, `expected overheatPopupMs 15000, got ${heat.overheatPopupMs}`);
    assert(heat.ventAmount === undefined, `expected no ventAmount, got ${heat.ventAmount}`);
  });

  // --- 7: percentage venting through the real action path ------------------

  await check('a vent action sheds 25% of heat capacity', async () => {
    const u = await seedUser((s) => { s.run.heat = 1500; });
    const before = await api(u, '/api/state');
    assert(before.status === 200, `expected 200, got ${before.status}`);
    const capacity = 2000;   // DEFAULT_CONFIG.heat.capacity, no Cold Storage bonus
    const startHeat = before.body.run.heat;
    assert(startHeat > 0, `expected seeded heat, got ${startHeat}`);

    const post = await api(u, '/api/actions', {
      method: 'POST',
      body: JSON.stringify({ actions: [{ type: 'vent' }] }),
    });
    assert(post.status === 200, `expected 200 from /api/actions, got ${post.status}`);

    const after = await api(u, '/api/state');
    const endHeat = after.body.run.heat;
    const shed = startHeat - endHeat;
    const expected = capacity * 0.25;
    // Production between the two reads can add heat back only if the player
    // owns overclock nodes - this seed owns none, so the drop is exact.
    assert(
      Math.abs(shed - expected) < 1,
      `expected to shed ~${expected}, shed ${shed} (${startHeat} -> ${endHeat})`,
    );
  });

  // --- 8-9: the tour over the real client ----------------------------------

  const pw = await loadPlaywrightOrNull();
  if (!pw) {
    console.log('SKIP tour renders over the built client (no Playwright available)');
    console.log('SKIP Skip persists across a reload (no Playwright available)');
  } else {
    const browser = await pw.chromium.launch();
    try {
      await check('a fresh player sees the tour, and Next advances it', async () => {
        const u = await seedUser();
        const ctx = await browser.newContext();
        await ctx.addCookies([{
          name: COOKIE_NAME,
          value: issueToken({ id: u.id, username: u.username, avatar_url: u.avatar_url }),
          url: BASE_URL,
        }]);
        const page = await ctx.newPage();
        await page.goto(BASE_URL);

        // Step 1 is the centered welcome card.
        const next = page.getByRole('button', { name: 'Next' });
        await next.waitFor({ state: 'visible', timeout: 15000 });
        const counter = page.locator('text=/^\\d+ \\/ \\d+$/').first();
        const first = await counter.textContent();
        assert(/^1 \//.test(first.trim()), `expected to start at step 1, got "${first}"`);
        const total = Number(first.trim().split('/')[1]);
        assert(total === 11, `expected 11 steps for a fresh account, got ${total}`);

        await next.click();
        const second = await counter.textContent();
        assert(/^2 \//.test(second.trim()), `expected step 2, got "${second}"`);

        // Step 3 targets the Racks buy row, so the tour must switch tabs and
        // spotlight a real element rather than falling back to centered.
        await next.click();
        const third = await counter.textContent();
        assert(/^3 \//.test(third.trim()), `expected step 3, got "${third}"`);
        const holeCount = await page.locator('svg mask#tour-mask rect').count();
        assert(holeCount >= 2, `expected a spotlight hole by step 3, got ${holeCount} mask rects`);

        await ctx.close();
      });

      await check('Skip closes the tour and persists across a reload', async () => {
        const u = await seedUser();
        const ctx = await browser.newContext();
        await ctx.addCookies([{
          name: COOKIE_NAME,
          value: issueToken({ id: u.id, username: u.username, avatar_url: u.avatar_url }),
          url: BASE_URL,
        }]);
        const page = await ctx.newPage();
        await page.goto(BASE_URL);

        // The X control is labelled "Skip tutorial", so match exactly.
        const skip = page.getByRole('button', { name: 'Skip', exact: true });
        await skip.waitFor({ state: 'visible', timeout: 15000 });
        await skip.click();
        await skip.waitFor({ state: 'detached', timeout: 5000 });

        // The server write is optimistic, so give it a moment to land before
        // asserting the reload does not re-show the tour.
        await page.waitForTimeout(500);
        const me = await api(u, '/api/me');
        assert(
          me.body.toursCompleted.includes(ONBOARDING_TOUR_ID),
          `skip did not persist, got ${JSON.stringify(me.body.toursCompleted)}`,
        );

        await page.reload();
        await page.waitForTimeout(1500);
        const reshown = await page.getByRole('button', { name: 'Skip', exact: true }).count();
        assert(reshown === 0, 'the tour re-appeared after being skipped');

        await ctx.close();
      });
    } finally {
      await browser.close();
    }
  }

  console.log('\n=== ERRORS ===');
  if (failures.length === 0) {
    console.log('NONE');
  } else {
    for (const f of failures) console.log(`${f.name}: ${f.message}`);
  }
  shuttingDown = true;
  killServer();
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  shuttingDown = true;
  killServer();
  process.exitCode = 1;
});
