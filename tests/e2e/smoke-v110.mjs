#!/usr/bin/env node
// v1.10 Quality of Life - end-to-end smoke suite (Task 10).
//
// Covers:
//
//   1. A save with bestLegacyCores 250 and legacyCores 0 - a player who has
//      spent everything in a Singularity - is on the legacyCores board at 250.
//      This is the bug v1.10 exists to fix: before it, the board read the
//      current cores and the `.value > 0` filter deleted them outright.
//   2. A save that has never earned a core is still absent from that board, so
//      the fix widened the board's reader without weakening its filter.
//   3. POST /api/actions with { type: 'buy', lane: 'tiers', index: 0,
//      mode: 'milestone' } and ample credits lands EXACTLY on the first
//      threshold (25) - not one over, not one under.
//   4. The same action with 1 credit is rejected as insufficient_credits and
//      changes nothing. The server owns the target; a client that asked for a
//      jump it cannot pay for gets no partial buy.
//   5. GET /api/minigame/bests returns the maximum across two finished
//      sessions, not the latest.
//   6. Over the built client: the milestone button renders on the Racks panel
//      and is disabled when the jump is unaffordable.
//
// Same harness shape as smoke-v16.mjs - boots a real `node server/index.js`
// against a scratch SQLite file, seeds users/saves through server/db.js and
// mints JWT cookies via server/auth.js. Checks 1-5 are API invariants and need
// no browser; check 6 uses the same Playwright resolution the other suites do
// and SKIPs rather than fails when no browser can be resolved.
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

const PORT = 3810;
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = '/tmp/e2e-v110.db';
const JWT_SECRET = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80';

for (const ext of ['', '-wal', '-shm']) {
  try { rmSync(DB_PATH + ext, { force: true }); } catch (e) { /* ignore */ }
}

process.env.JWT_SECRET = JWT_SECRET;
process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = 'test';

const {
  upsertUser, putSave, driver, createMinigameSession, finishMinigameSession,
} = await import(path.join(REPO_ROOT, 'server', 'db.js'));
const { issueToken, COOKIE_NAME } = await import(path.join(REPO_ROOT, 'server', 'auth.js'));
const { initialState } = await import(path.join(REPO_ROOT, 'shared', 'state.js'));
const { MILESTONES } = await import(path.join(REPO_ROOT, 'shared', 'gameData.js'));
const { ONBOARDING_TOUR_ID } = await import(path.join(REPO_ROOT, 'shared', 'tours.js'));

// The first milestone at the DEFAULT config - no infiniteloop shard upgrade is
// seeded anywhere in this suite, so the discount is 1x and the threshold is the
// raw MILESTONES entry.
const FIRST_MILESTONE = MILESTONES[0];

// Multiple processes hold this same SQLite file open (this harness for
// seeding, plus the spawned server for real traffic); busy_timeout is a
// SQLite-only pragma (Postgres uses MVCC instead), so only apply it against
// the SQLite driver.
if (driver.__backend === 'sqlite') {
  driver.__raw.pragma('busy_timeout = 5000');
}

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
// Mirrors smoke-v12..v19 so this suite behaves the same way in CI.
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
    provider: 'discord', providerId: `v110-${seq}`, username: `v110user${seq}`, avatarUrl: null,
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

  // --- 1-2: the leaderboard reads the PEAK ---------------------------------
  //
  // Both accounts are seeded and the board is fetched ONCE, before any other
  // check touches /api/leaderboard. The payload is cached server-side for
  // social.leaderboardCacheMs, so seeding the second account after a first
  // fetch would leave it out of a stale board and make check 2 pass for
  // entirely the wrong reason.

  const spentUser = await seedUser((s) => {
    s.meta.legacyCores = 0;             // spent in a Singularity
    s.meta.stats.bestLegacyCores = 250; // but they earned 250
  });
  const freshUser = await seedUser();   // never earned a core
  const boardRes = await api(spentUser, '/api/leaderboard');
  const legacyBoard = boardRes.body && boardRes.body.boards
    ? boardRes.body.boards.legacyCores
    : null;

  await check('a player who spent every core is still on the legacyCores board, at their peak', async () => {
    assert(boardRes.status === 200, `expected 200 from /api/leaderboard, got ${boardRes.status}`);
    assert(Array.isArray(legacyBoard), `expected a legacyCores board, got ${JSON.stringify(legacyBoard)}`);
    const row = legacyBoard.find((r) => r.userId === spentUser.id);
    assert(row, 'the player who spent their cores is missing from the board');
    assert(row.value === 250, `expected 250, got ${row.value}`);
  });

  await check('an account that never earned a core is still absent from that board', async () => {
    assert(Array.isArray(legacyBoard), 'no legacyCores board to check');
    const row = legacyBoard.find((r) => r.userId === freshUser.id);
    assert(!row, `expected no row, got ${JSON.stringify(row)}`);
  });

  // --- 3-4: buy mode 'milestone', computed server-side ----------------------

  await check(`a milestone buy lands exactly on the first threshold (${FIRST_MILESTONE})`, async () => {
    const u = await seedUser((s) => { s.run.credits = 1e12; });
    const res = await api(u, '/api/actions', {
      method: 'POST',
      body: JSON.stringify({
        actions: [{ type: 'buy', lane: 'tiers', index: 0, mode: 'milestone' }],
      }),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const result = res.body.results[0];
    assert(result.ok, `expected ok, got ${JSON.stringify(result)}`);
    const owned = res.body.state.run.tiers[0].owned;
    assert(
      owned === FIRST_MILESTONE,
      `expected exactly ${FIRST_MILESTONE} owned, got ${owned}`,
    );
  });

  await check('an unaffordable milestone buy is refused and changes nothing', async () => {
    const u = await seedUser((s) => { s.run.credits = 1; });
    const before = await api(u, '/api/state');
    const ownedBefore = before.body.run.tiers[0].owned;

    const res = await api(u, '/api/actions', {
      method: 'POST',
      body: JSON.stringify({
        actions: [{ type: 'buy', lane: 'tiers', index: 0, mode: 'milestone' }],
      }),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const result = res.body.results[0];
    assert(result.ok === false, `expected a rejection, got ${JSON.stringify(result)}`);
    assert(
      result.error === 'insufficient_credits',
      `expected insufficient_credits, got ${result.error}`,
    );

    const after = await api(u, '/api/state');
    assert(
      after.body.run.tiers[0].owned === ownedBefore,
      `owned changed on a refused buy: ${ownedBefore} -> ${after.body.run.tiers[0].owned}`,
    );
  });

  // --- 5: minigame personal bests -------------------------------------------

  await check('GET /api/minigame/bests returns the maximum finished score, not the latest', async () => {
    const u = await seedUser();
    const first = await createMinigameSession(u.id, 'rush');
    await finishMinigameSession(first.id, 120);
    const second = await createMinigameSession(u.id, 'rush');
    await finishMinigameSession(second.id, 40);   // lower, and later

    const res = await api(u, '/api/minigame/bests');
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.bests.rush === 120, `expected 120, got ${res.body.bests.rush}`);
  });

  await check('GET /api/minigame/bests requires auth', async () => {
    const res = await fetch(`${BASE_URL}/api/minigame/bests`);
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  // --- 6: the milestone button over the real client -------------------------

  const pw = await loadPlaywrightOrNull();
  if (!pw) {
    console.log('SKIP the milestone button renders on Racks and is disabled when unaffordable (no Playwright available)');
  } else {
    const browser = await pw.chromium.launch();
    try {
      await check('the milestone button renders on Racks and is disabled when unaffordable', async () => {
        // No credits, so the 25-rack jump is unaffordable and the button must
        // render disabled rather than not render at all - "you cannot afford
        // this yet" and "there is nothing left to buy" are different states.
        const u = await seedUser((s) => { s.run.credits = 0; });
        // Mark the onboarding tour done: a fresh account otherwise opens with
        // the tutorial overlay covering the panel under test.
        await api(u, '/api/me/tours', {
          method: 'PUT',
          body: JSON.stringify({ tourId: ONBOARDING_TOUR_ID, completed: true }),
        });

        const ctx = await browser.newContext();
        await ctx.addCookies([{
          name: COOKIE_NAME,
          value: issueToken({ id: u.id, username: u.username, avatar_url: u.avatar_url }),
          url: BASE_URL,
        }]);
        const page = await ctx.newPage();
        await page.goto(BASE_URL);

        // Racks is the default tab. The label is `→ <target>: <n> for <cost>`.
        const btn = page.locator(`button:has-text("→ ${FIRST_MILESTONE}:")`).first();
        await btn.waitFor({ state: 'visible', timeout: 15000 });
        const label = (await btn.textContent()).trim();
        assert(
          label.startsWith(`→ ${FIRST_MILESTONE}: ${FIRST_MILESTONE} for `),
          `unexpected label "${label}"`,
        );
        assert(await btn.isDisabled(), 'the button was enabled with zero credits');

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
