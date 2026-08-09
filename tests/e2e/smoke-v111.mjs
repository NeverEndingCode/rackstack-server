#!/usr/bin/env node
// v1.11 Risk & Reliability - end-to-end smoke suite (Task 11).
//
// Covers:
//
//   1. A save carrying a live ransomware outage across the whole absence earns
//      strictly less than the identical save without one - and both earn
//      something. This is the release working at all.
//   2. That same pair have IDENTICAL Cold Storage job accrual and tapes. Cold
//      Storage is the safe harbour (spec decision 6) and nothing may reach it.
//   3. POST /api/actions { type: 'buySupply', id: 'antivirus' } charges credits
//      and stocks one; with no credits it is refused as insufficient_credits
//      and changes nothing.
//   4. A save whose nextHazardAt is 1 (1970) reconciles quickly, rolls
//      nextHazardAt into the future, and never exceeds
//      MAX_HAZARDS_PER_EVALUATION outages. The bound is a requirement, not a
//      nicety - an unbounded loop here is a hung request.
//   5. A stocked supply absorbs a hazard that fired while the player was
//      offline, leaving no outage behind. That is the only defence that can
//      reach an incident which starts and ends during an absence.
//   6. The master kill switch clears a live outage on the next reconcile - a
//      true kill, not a pause.
//   7. PUT /api/admin/config with a string on risk.enabled is rejected. The
//      v1.11 boolean tunable type is enforced end to end, not just in unit
//      tests.
//   8. Over the built client: the Resilience tab renders its supply shop.
//
// Same harness shape as smoke-v110.mjs - boots a real `node server/index.js`
// against a scratch SQLite file, seeds users/saves through server/db.js and
// mints JWT cookies via server/auth.js. Checks 1-7 are API invariants and need
// no browser; check 8 uses the same Playwright resolution the other suites do
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

const PORT = 3811;
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = '/tmp/e2e-v111.db';
const JWT_SECRET = '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0';
// Admin checks need an owner. Same mechanism smoke-v14-events.mjs uses: the id
// is provider:providerId, so seeding github/37058311 produces exactly this.
const OWNER_ID = 'github:37058311';

for (const ext of ['', '-wal', '-shm']) {
  try { rmSync(DB_PATH + ext, { force: true }); } catch (e) { /* ignore */ }
}

process.env.JWT_SECRET = JWT_SECRET;
process.env.SUPER_ADMIN_IDS = OWNER_ID;
process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = 'test';

const {
  upsertUser, putSave, setToursCompleted, driver,
} = await import(path.join(REPO_ROOT, 'server', 'db.js'));
const { issueToken, COOKIE_NAME } = await import(path.join(REPO_ROOT, 'server', 'auth.js'));
const { initialState } = await import(path.join(REPO_ROOT, 'shared', 'state.js'));
const { MAX_HAZARDS_PER_EVALUATION } = await import(path.join(REPO_ROOT, 'shared', 'outages.js'));
const { TOUR_IDS } = await import(path.join(REPO_ROOT, 'shared', 'tours.js'));

// GET /api/state returns run/meta/server FLATTENED at the top level, not
// wrapped in `state` - unlike POST /api/actions, which does return { state }.
const stateOf = (body) => ({ run: body.run, meta: body.meta, server: body.server });

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
// Mirrors smoke-v12..v110 so this suite behaves the same way in CI.
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

const HOUR = 3600 * 1000;

let seq = 0;
async function seedUser(mutate, ident) {
  seq += 1;
  const user = await upsertUser({
    provider: ident ? ident.provider : 'discord',
    providerId: ident ? ident.providerId : `v111-${seq}`,
    username: ident ? ident.username : `v111user${seq}`,
    avatarUrl: null,
  });
  const s = initialState();
  s.run.tiers[0] = { id: 0, owned: 40, manager: true, ready: 0 };
  s.run.grid[0] = { id: 0, owned: 10 };
  if (mutate) mutate(s);
  await putSave(user.id, s, Date.now() - HOUR);   // a 1h offline gap
  return user;
}

// The onboarding tour auto-starts for an account that has completed nothing,
// and its overlay is a full-screen `fixed inset-0` div that swallows every
// click - so the browser check below must seed the tours as done first.
async function seedToursCompleted(user) {
  await setToursCompleted(user.id, TOUR_IDS);
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
  console.log('Server up.');

  const past = Date.now() - HOUR;

  // --- 1-2: an outage costs output, Cold Storage never notices -------------

  const clean = await seedUser((s) => {
    s.meta.coldStorage.job = { type: 'defrag', accruedOfflineSec: 0, startedAt: past };
  });
  const dark = await seedUser((s) => {
    s.meta.coldStorage.job = { type: 'defrag', accruedOfflineSec: 0, startedAt: past };
    s.server.outages = [{
      id: 'hazard:e2e', kind: 'ransomware', scope: { lane: '*' }, factor: 0,
      startAt: past, endAt: Date.now() + HOUR, source: 'hazard',
    }];
  });

  const cleanState = stateOf((await api(clean, '/api/state')).body);
  const darkState = stateOf((await api(dark, '/api/state')).body);

  await check('an outage reduces output over the same window', async () => {
    assert(cleanState.run.credits > 10, 'clean save earned nothing');
    assert(darkState.run.credits < cleanState.run.credits,
      `expected the darkened save to earn less: ${darkState.run.credits} vs ${cleanState.run.credits}`);
  });

  await check('Cold Storage is a safe harbour - identical with and without an incident', async () => {
    assert(darkState.meta.coldStorage.job.accruedOfflineSec
      === cleanState.meta.coldStorage.job.accruedOfflineSec,
      'cold storage job accrual differed under an outage');
    assert(darkState.meta.coldStorage.tapes === cleanState.meta.coldStorage.tapes,
      'cold storage tapes differed under an outage');
  });

  // --- 3: buying a supply --------------------------------------------------

  const buyer = await seedUser((s) => { s.run.credits = 1e12; });
  await seedToursCompleted(buyer);
  await check('buySupply charges credits and stocks one', async () => {
    // Baseline AFTER the offline gap is credited, not the seeded 1e12 - an
    // hour of accrual dwarfs the supply price, so comparing against the seed
    // would "pass" even if nothing were charged.
    const before = stateOf((await api(buyer, '/api/state')).body).run.credits;
    const res = await api(buyer, '/api/actions', {
      method: 'POST',
      body: JSON.stringify({ actions: [{ type: 'buySupply', id: 'antivirus' }] }),
    });
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.body.results[0].ok === true, `buySupply rejected: ${JSON.stringify(res.body.results[0])}`);
    assert(res.body.state.meta.supplies.antivirus === 1,
      `expected 1 antivirus, got ${res.body.state.meta.supplies.antivirus}`);
    const cost = res.body.results[0].cost;
    assert(cost > 0, `expected a positive cost, got ${cost}`);
    assert(res.body.state.run.credits <= before,
      `credits did not fall: ${before} -> ${res.body.state.run.credits}`);
  });

  const pauper = await seedUser((s) => {
    s.run.credits = 0;
    s.run.tiers[0].owned = 0;
    s.run.grid[0].owned = 0;
  });
  await check('buySupply is refused when unaffordable, and changes nothing', async () => {
    const res = await api(pauper, '/api/actions', {
      method: 'POST',
      body: JSON.stringify({ actions: [{ type: 'buySupply', id: 'antivirus' }] }),
    });
    assert(res.body.results[0].error === 'insufficient_credits',
      `expected insufficient_credits, got ${JSON.stringify(res.body.results[0])}`);
    assert(res.body.state.meta.supplies.antivirus === 0, 'stock changed on a rejected buy');
  });

  // --- 4: the bound. A 1970 nextHazardAt must terminate, not spin ----------

  const ancient = await seedUser((s) => { s.server.nextHazardAt = 1; });
  await check('a nextHazardAt far in the past terminates and reschedules', async () => {
    const t0 = Date.now();
    const res = await api(ancient, '/api/state');
    const took = Date.now() - t0;
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(took < 5000, `took ${took}ms - the firing loop is not bounded`);
    const st = stateOf(res.body);
    assert(st.server.nextHazardAt > Date.now(), 'nextHazardAt was not rolled forward past now');
    assert(st.server.outages.length <= MAX_HAZARDS_PER_EVALUATION,
      `fired ${st.server.outages.length} outages, above the bound`);
  });

  // --- 5: absorption reaches an offline player ----------------------------

  const hedged = await seedUser((s) => {
    s.meta.supplies = { antivirus: 3, backupIsp: 3, spareDrives: 3 };
    s.server.nextHazardAt = Date.now() - HOUR / 2;   // one is due
  });
  await check('a stocked supply absorbs a hazard that fired while offline', async () => {
    const st = stateOf((await api(hedged, '/api/state')).body);
    const supplies = st.meta.supplies;
    const total = supplies.antivirus + supplies.backupIsp + supplies.spareDrives;
    assert(total < 9, 'nothing was consumed - no hazard fired to absorb');
    assert(st.server.outages.length === 0,
      `absorbed hazards must leave no outage, found ${st.server.outages.length}`);
  });

  // --- 6-7: the kill switch, and the boolean type, end to end -------------

  const owner = await seedUser(undefined, {
    provider: 'github', providerId: '37058311', username: 'owner_v111_e2e',
  });
  assert(`${owner.id}` === OWNER_ID, `expected seeded owner id ${OWNER_ID}, got ${owner.id}`);

  await check('a string on a boolean tunable is rejected', async () => {
    const cur = (await api(owner, '/api/admin/config')).body;
    const doc = structuredClone(cur.data);
    doc.risk.enabled = 'no';
    // PUT /api/admin/config takes the document wrapped as { data }.
    const res = await api(owner, '/api/admin/config', {
      method: 'PUT', body: JSON.stringify({ data: doc }),
    });
    assert(res.body && Array.isArray(res.body.errors), 'a string boolean was accepted');
    assert(res.body.errors.some((e) => e.startsWith('risk.enabled:')),
      `expected a risk.enabled error, got ${JSON.stringify(res.body.errors)}`);
  });

  const throttled = await seedUser((s) => {
    s.server.outages = [{
      id: 'hazard:kill', kind: 'ransomware', scope: { lane: '*' }, factor: 0,
      startAt: past, endAt: Date.now() + 10 * HOUR, source: 'hazard',
    }];
  });
  await check('the kill switch clears a live outage on the next reconcile', async () => {
    const cur = (await api(owner, '/api/admin/config')).body;
    const off = structuredClone(cur.data);
    off.risk.enabled = false;
    const put = await api(owner, '/api/admin/config', {
      method: 'PUT', body: JSON.stringify({ data: off }),
    });
    assert(typeof put.body.version === 'number', `config PUT failed: ${JSON.stringify(put.body)}`);

    const st = stateOf((await api(throttled, '/api/state')).body);
    assert(st.server.outages.length === 0,
      `expected the outage cleared, found ${st.server.outages.length}`);

    // Restore, so the browser pass below sees the shipped defaults.
    const on = structuredClone(off);
    on.risk.enabled = true;
    await api(owner, '/api/admin/config', {
      method: 'PUT', body: JSON.stringify({ data: on }),
    });
  });

  // --- 8: the Resilience tab renders --------------------------------------

  const pw = await loadPlaywrightOrNull();
  if (!pw) {
    console.log('SKIP the Resilience tab renders its supply shop (no Playwright browser available)');
  } else {
    let browser = null;
    try {
      browser = await pw.chromium.launch();
      await check('the Resilience tab renders its supply shop', async () => {
        const context = await browser.newContext();
        await context.addCookies([{
          name: COOKIE_NAME,
          value: cookieFor(buyer).slice(COOKIE_NAME.length + 1),
          domain: 'localhost',
          path: '/',
        }]);
        const page = await context.newPage();
        await page.goto(BASE_URL);
        await page.getByRole('button', { name: /Resilience/ }).click();
        const buy = page.getByTestId('supply-buy-antivirus');
        await buy.waitFor({ timeout: 10000 });
        const label = await buy.textContent();
        assert(label.includes('Buy 1'), `supply buy button did not render its price: ${label}`);
        await context.close();
      });
    } catch (e) {
      console.log(`SKIP the Resilience tab renders its supply shop (browser launch failed: ${e.message})`);
    } finally {
      if (browser) await browser.close();
    }
  }

  console.log('\n=== ERRORS ===');
  if (failures.length === 0) {
    console.log('NONE');
  } else {
    for (const f of failures) console.log(`${f.name}: ${f.message}`);
  }
}

try {
  await main();
} catch (e) {
  console.error(`\nFATAL: ${e && e.stack ? e.stack : e}`);
  failures.push({ name: 'harness', message: String(e) });
} finally {
  shuttingDown = true;
  killServer();
}

process.exit(failures.length === 0 ? 0 : 1);
