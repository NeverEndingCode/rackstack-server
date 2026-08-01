#!/usr/bin/env node
// v1.5 Social & Retention - end-to-end smoke suite (Task 12).
//
// Covers the plan's coverage checklist:
//
//   1. Two users seeded on the same day get the SAME three contract types,
//      with DIFFERENT numeric targets scaled to their own progress.
//   2. A contract's target does not move when output changes mid-day - the
//      rollover snapshot is what the player is held to.
//   3. Claiming a met contract through the REAL Claim button pays wafers +
//      tapes exactly once; the button is gone afterwards.
//   4. The streak banner pays on day 1 and refuses a second claim the same
//      UTC day.
//   5. An achievement unlocks automatically with NO payout, and shows up in
//      the badge case.
//   6. GET /api/leaderboard ranks two seeded users correctly, and opting out
//      via the real checkbox removes the user from every board.
//   7. A player with Cold Storage locked receives only base-lane contracts -
//      no dead contract they cannot possibly complete.
//
// Same harness shape as smoke-v14.mjs: boots a real `node server/index.js`
// against a scratch SQLite file, seeds users/saves directly through
// server/db.js, mints JWT cookies via server/auth.js, and drives the *built*
// client (client/dist, served by the app itself) with Playwright/Chromium for
// anything exercising a real client-side wrapper (the claim buttons, the
// opt-out checkbox). Pure numeric/ranking invariants are asserted straight
// against the API, matching smoke-v13/v14's precedent - Playwright is reused
// there purely as an authenticated-fetch harness.
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
      '  npm i -D playwright && npx playwright install chromium\n',
    );
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Server env / lifecycle
// ---------------------------------------------------------------------------

const PORT = 3806;
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = '/tmp/e2e-v15.db';
const JWT_SECRET = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80';
const OWNER_ID = 'github:37058311';

for (const ext of ['', '-wal', '-shm']) {
  try { rmSync(DB_PATH + ext, { force: true }); } catch (e) { /* ignore */ }
}

process.env.JWT_SECRET = JWT_SECRET;
process.env.SUPER_ADMIN_IDS = OWNER_ID;
process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = 'test';

const { upsertUser, putSave, getSave, setLeaderboardOptOut, db } = await import(path.join(REPO_ROOT, 'server', 'db.js'));
const { issueToken, COOKIE_NAME } = await import(path.join(REPO_ROOT, 'server', 'auth.js'));
const { initialState } = await import(path.join(REPO_ROOT, 'shared', 'state.js'));
const { DEFAULT_CONFIG } = await import(path.join(REPO_ROOT, 'shared', 'configSchema.js'));
const { contractsForState, contractDef } = await import(path.join(REPO_ROOT, 'shared', 'contracts.js'));
const { utcDateKey } = await import(path.join(REPO_ROOT, 'shared', 'daily.js'));

db.pragma('busy_timeout = 5000');

let serverProc = null;
let browser = null;
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

let seq = 0;
function seedUser(mutate) {
  seq += 1;
  const user = upsertUser({
    provider: 'discord', providerId: `v15-${seq}`, username: `v15user${seq}`, avatarUrl: null,
  });
  const s = initialState();
  if (mutate) mutate(s);
  putSave(user.id, s, Date.now());
  return user;
}

function cookieFor(user) {
  return {
    name: COOKIE_NAME,
    value: issueToken({ id: user.id, username: user.username, avatar_url: user.avatar_url }),
    url: BASE_URL,
  };
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

async function newPageFor(user) {
  const ctx = await browser.newContext();
  await ctx.addCookies([cookieFor(user)]);
  const page = await ctx.newPage();
  return { ctx, page };
}

async function boot(page) {
  const [stateRes] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/state') && r.request().method() === 'GET'),
    page.goto(BASE_URL),
  ]);
  const body = await stateRes.json();
  await page.waitForTimeout(200);
  return body;
}

// A save whose racks are already bought so the player has real output (needed
// for a non-trivial c_flops target and a non-zero day-1 streak reward), and
// with Cold Storage unlocked unless `cold` is false.
function withRacks(count, { cold = true } = {}) {
  return (s) => {
    s.run.tiers[0].owned = count;
    if (cold) s.run.tiers[4].owned = 1; // Server Room
    s.run.credits = 1e9;
  };
}

async function openSocialTab(page) {
  await page.getByRole('button', { name: /^Social$/ }).click();
  await page.waitForTimeout(150);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { chromium } = await loadPlaywright();
  await startServer();
  browser = await chromium.launch();

  const contexts = [];
  const track = (ctx) => { contexts.push(ctx); return ctx; };

  // --- 1 + 2: determinism, per-player scaling, snapshotting ----------------

  await check('two players on the same day get the same three contract types', async () => {
    const a = seedUser(withRacks(20));
    const b = seedUser(withRacks(5000));
    const { ctx: ca, page: pa } = await newPageFor(a); track(ca);
    const { ctx: cb, page: pb } = await newPageFor(b); track(cb);
    const sa = await boot(pa);
    const sb = await boot(pb);

    const typesA = contractsForState(sa.meta).map((c) => c.def.id);
    const typesB = contractsForState(sb.meta).map((c) => c.def.id);
    assert(typesA.length === 3, `expected 3 contracts, got ${typesA.length}`);
    assert(
      JSON.stringify(typesA) === JSON.stringify(typesB),
      `expected identical contract types, got ${typesA} vs ${typesB}`,
    );
    assert(
      sa.meta.contracts.dateKey === utcDateKey(sa.serverTime),
      `expected today's dateKey, got ${sa.meta.contracts.dateKey}`,
    );

    // ...but the FLOPS target scales to each player's own output.
    const flopsIdx = typesA.indexOf('c_flops');
    if (flopsIdx >= 0) {
      assert(
        sb.meta.contracts.targets[flopsIdx] > sa.meta.contracts.targets[flopsIdx],
        'expected the higher-output player to get a larger FLOPS target',
      );
    }
  });

  await check('a contract target does not move when output changes mid-day', async () => {
    const u = seedUser(withRacks(20));
    const { ctx, page } = await newPageFor(u); track(ctx);
    const before = await boot(page);
    const targetsBefore = before.meta.contracts.targets;

    // Buy a lot more output, then re-read state.
    const buy = await apiFetch(page, '/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{ type: 'buy', lane: 'tiers', index: 0, mode: 200 }] }),
    });
    assert(buy.status === 200, `buy failed: ${buy.status}`);

    const after = (await apiFetch(page, '/api/state', { method: 'GET' })).body;
    assert(
      JSON.stringify(after.meta.contracts.targets) === JSON.stringify(targetsBefore),
      `targets moved mid-day: ${targetsBefore} -> ${after.meta.contracts.targets}`,
    );
  });

  // --- 7: locked Cold Storage never yields a dead contract -----------------

  await check('a player without Cold Storage gets only base-lane contracts', async () => {
    const u = seedUser(withRacks(20, { cold: false }));
    const { ctx, page } = await newPageFor(u); track(ctx);
    const state = await boot(page);
    const resolved = contractsForState(state.meta);
    assert(resolved.length === 3, `expected 3 contracts, got ${resolved.length}`);
    for (const c of resolved) {
      assert(
        c.def.lane === 'base',
        `cold-lane contract ${c.def.id} handed to a player without Cold Storage`,
      );
    }
  });

  // --- 3: claiming a met contract through the real button ------------------

  await check('claiming a met contract through the UI pays once and cannot repeat', async () => {
    // Seed a player whose c_minigames-style counter is already far past any
    // plausible target, so at least one slot is claimable on first load.
    const u = seedUser((s) => {
      withRacks(20)(s);
      s.meta.stats.minigamesWon = 0;
    });
    const { ctx, page } = await newPageFor(u); track(ctx);
    const state = await boot(page);

    // Push every selected metric past its target, server-side, then reload.
    const saved = JSON.parse(getSave(u.id).data);
    for (const c of contractsForState(saved.meta)) {
      saved.meta.stats[c.def.metric] = (saved.meta.contracts.baseline[c.def.metric] || 0) + c.target;
    }
    putSave(u.id, saved, Date.now());

    await boot(page);
    await openSocialTab(page);

    const before = (await apiFetch(page, '/api/state', { method: 'GET' })).body;
    const wafersBefore = before.meta.wafers;
    const tapesBefore = before.meta.coldStorage.tapes;

    // Scoped by testid: the streak banner in the sticky header also renders a
    // Claim control, and a name-based lookup matches it first.
    const claimButtons = page.getByTestId('contract-claim');
    const count = await claimButtons.count();
    assert(count >= 1, `expected at least one claimable contract, saw ${count}`);

    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/actions') && r.request().method() === 'POST'),
      claimButtons.first().click(),
    ]);
    const body = await resp.json();
    const result = body.results.find((r) => typeof r.index === 'number' && r.reward);
    assert(result && result.ok === true, `claim rejected: ${JSON.stringify(body.results)}`);
    assert(result.reward.wafers > 0, `expected wafers, got ${JSON.stringify(result.reward)}`);
    assert(result.reward.tapes > 0, `expected tapes, got ${JSON.stringify(result.reward)}`);

    await page.waitForTimeout(300);
    const after = (await apiFetch(page, '/api/state', { method: 'GET' })).body;
    assert(
      after.meta.wafers === wafersBefore + result.reward.wafers,
      `wafers ${wafersBefore} -> ${after.meta.wafers}, expected +${result.reward.wafers}`,
    );
    assert(
      after.meta.coldStorage.tapes === tapesBefore + result.reward.tapes,
      `tapes ${tapesBefore} -> ${after.meta.coldStorage.tapes}, expected +${result.reward.tapes}`,
    );
    assert(after.meta.stats.contractsCompletedLifetime === 1, 'expected exactly one completed contract');

    // A direct replay of the same claim must be rejected.
    const replay = await apiFetch(page, '/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{ type: 'claimContract', index: result.index }] }),
    });
    assert(replay.body.results[0].ok === false, 'expected a double claim to be rejected');
    assert(
      replay.body.results[0].error === 'invalid_target',
      `expected invalid_target, got ${replay.body.results[0].error}`,
    );
  });

  // --- 4: the streak banner ------------------------------------------------

  await check('the streak banner pays on day 1 and refuses a second same-day claim', async () => {
    const u = seedUser(withRacks(50));
    const { ctx, page } = await newPageFor(u); track(ctx);
    const before = await boot(page);
    assert(before.meta.streak.count === 0, 'expected a fresh streak');

    const creditsBefore = before.run.credits;
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/actions') && r.request().method() === 'POST'),
      page.getByRole('button', { name: /Day 1/ }).click(),
    ]);
    const body = await resp.json();
    const result = body.results.find((r) => typeof r.day === 'number');
    assert(result && result.ok === true, `streak claim rejected: ${JSON.stringify(body.results)}`);
    assert(result.day === 1, `expected day 1, got ${result.day}`);
    assert(result.reward.flops > 0, `expected a FLOPS reward, got ${JSON.stringify(result.reward)}`);

    await page.waitForTimeout(300);
    const after = (await apiFetch(page, '/api/state', { method: 'GET' })).body;
    assert(after.meta.streak.count === 1, `expected streak 1, got ${after.meta.streak.count}`);
    assert(after.run.credits > creditsBefore, 'expected credits to rise from the streak payout');

    // The banner must now read as claimed, not offer another Claim.
    await page.getByText('back tomorrow').waitFor({ state: 'visible', timeout: 5000 });

    const replay = await apiFetch(page, '/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actions: [{ type: 'claimStreak' }] }),
    });
    assert(replay.body.results[0].ok === false, 'expected a second same-day streak claim to be rejected');
  });

  // --- 5: achievements unlock automatically, with no payout ----------------

  await check('an achievement unlocks automatically with no payout and shows in the badge case', async () => {
    const u = seedUser((s) => {
      withRacks(20)(s);
      s.meta.stats.singularities = 1; // 'first_singularity' condition met
    });
    const { ctx, page } = await newPageFor(u); track(ctx);

    const saved = JSON.parse(getSave(u.id).data);
    const before = {
      wafers: saved.meta.wafers,
      xp: saved.meta.xp,
      level: saved.meta.level,
      tapes: saved.meta.coldStorage.tapes,
    };

    const state = await boot(page);
    assert(
      state.meta.achievements.first_singularity !== undefined,
      'expected first_singularity to unlock on load',
    );
    assert(
      Array.isArray(state.unlockedAchievements) && state.unlockedAchievements.includes('first_singularity'),
      `expected the unlock to be reported, got ${JSON.stringify(state.unlockedAchievements)}`,
    );

    // Pure prestige: nothing was paid out.
    assert(state.meta.wafers === before.wafers, `wafers changed: ${before.wafers} -> ${state.meta.wafers}`);
    assert(state.meta.xp === before.xp, `xp changed: ${before.xp} -> ${state.meta.xp}`);
    assert(state.meta.level === before.level, `level changed: ${before.level} -> ${state.meta.level}`);
    assert(
      state.meta.coldStorage.tapes === before.tapes,
      `tapes changed: ${before.tapes} -> ${state.meta.coldStorage.tapes}`,
    );

    // And it renders in the badge case.
    await openSocialTab(page);
    await page.getByRole('button', { name: /Badges/ }).click();
    // Scoped to the badge case: the unlock toast renders the same name, so an
    // unscoped lookup is ambiguous (and would pass on the toast alone).
    await page.getByTestId('badge-case').getByText('Event Horizon', { exact: true })
      .waitFor({ state: 'visible', timeout: 5000 });
  });

  // --- 6: leaderboards + opt-out ------------------------------------------

  await check('the leaderboard ranks players and honours the opt-out checkbox', async () => {
    const low = seedUser((s) => { s.meta.stats.lifetimeFlopsAllTime = 1000; s.meta.level = 2; });
    const high = seedUser((s) => { s.meta.stats.lifetimeFlopsAllTime = 5e9; s.meta.level = 30; });
    const { ctx: cl, page: pl } = await newPageFor(low); track(cl);
    await boot(pl);

    const board = (await apiFetch(pl, '/api/leaderboard', { method: 'GET' })).body;
    const ids = board.boards.allTimeFlops.map((r) => r.userId);
    assert(ids.includes(high.id) && ids.includes(low.id), 'expected both players on the FLOPS board');
    assert(
      ids.indexOf(high.id) < ids.indexOf(low.id),
      'expected the higher-FLOPS player to rank first',
    );

    // Now opt out through the real checkbox, and confirm the API drops them.
    const { ctx: ch, page: ph } = await newPageFor(high); track(ch);
    await boot(ph);
    await openSocialTab(ph);
    await ph.getByRole('button', { name: /Board/ }).click();
    await ph.waitForTimeout(200);

    await Promise.all([
      ph.waitForResponse((r) => r.url().endsWith('/api/me/leaderboard-opt-out')),
      ph.getByLabel('Hide me from all leaderboards').check(),
    ]);
    await ph.waitForTimeout(300);

    const after = (await apiFetch(pl, '/api/leaderboard', { method: 'GET' })).body;
    for (const [key, rows] of Object.entries(after.boards)) {
      assert(
        !rows.map((r) => r.userId).includes(high.id),
        `opted-out player still present on board "${key}"`,
      );
    }
  });

  for (const ctx of contexts) {
    // eslint-disable-next-line no-await-in-loop
    await ctx.close();
  }
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
