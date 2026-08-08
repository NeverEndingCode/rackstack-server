#!/usr/bin/env node
// v1.9 SuperTokens client login - end-to-end smoke suite (Task 2 Step 5).
//
// Covers:
//
//   1. GET /api/auth-info is reachable with no session and reports the mode.
//   2. In `dual` it says loginFlow=supertokens - the client drives SuperTokens
//      even though the passport routes are still registered underneath.
//   3. GET /auth/callback/github reaches the SPA rather than being answered by
//      SuperTokens' middleware. The entire client callback leg depends on it.
//   4. The login screen renders SuperTokens BUTTONS in dual mode.
//   5. The full redirect round trip over the built client: click ->
//      /auth/authorisationurl -> provider redirect -> /auth/callback/github
//      -> POST /auth/signinup -> session -> the game renders, with the spent
//      ?code= replaced out of the URL.
//   6. A provider that refuses (error=access_denied) lands back on the login
//      screen with a readable message, and never POSTs signinup.
//   7. An unconfigured provider (the exact 400 production returned all through
//      v1.8) shows a message instead of a blank screen.
//   8. Restarted in `passport` mode, the SAME build renders plain <a> links to
//      the passport routes - both stacks from one bundle.
//
// The provider is stubbed by pointing `urlWithQueryParams` back at this
// server's own /auth/callback/github, so no external service is contacted and
// no SuperTokens core is required. POST /auth/signinup is intercepted too and
// answers with a legacy JWT cookie, which `dual` accepts - so the assertion
// "the client completed the flow and the app came up authenticated" is real
// even though the core round trip is stubbed.
//
// What this suite deliberately does NOT prove: that the signInUp mapping
// resolves a returning player to their existing users.id. That needs a real
// SuperTokens core and is Task 1 of the v1.9 plan, to be run against the box
// once this ships.
//
// Same harness shape as smoke-v16.mjs. Every check prints `PASS <name>` or
// `FAIL <name>: <reason>`; `=== ERRORS ===` at the end lists failures or NONE.

import { spawn } from 'node:child_process';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..', '..');

const PORT = 3809;
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = '/tmp/e2e-v19.db';
const JWT_SECRET = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80';

for (const ext of ['', '-wal', '-shm']) {
  try { rmSync(DB_PATH + ext, { force: true }); } catch (e) { /* ignore */ }
}

process.env.JWT_SECRET = JWT_SECRET;
process.env.DB_PATH = DB_PATH;
process.env.NODE_ENV = 'test';

// Both stacks read these. The SuperTokens core is never reachable and never
// contacted: every endpoint that would touch it is intercepted in the browser.
process.env.GITHUB_CLIENT_ID = 'gh-id';
process.env.GITHUB_CLIENT_SECRET = 'gh-secret';
process.env.GITHUB_CALLBACK_URL = `${BASE_URL}/auth/github/callback`;
process.env.DISCORD_CLIENT_ID = 'dc-id';
process.env.DISCORD_CLIENT_SECRET = 'dc-secret';
process.env.DISCORD_CALLBACK_URL = `${BASE_URL}/auth/discord/callback`;
process.env.PUBLIC_ORIGIN = BASE_URL;
process.env.SUPERTOKENS_CONNECTION_URI = 'http://supertokens.invalid:3567';
process.env.SUPERTOKENS_API_KEY = 'test-core-api-key';

const { upsertUser, putSave, driver } = await import(path.join(REPO_ROOT, 'server', 'db.js'));
const { issueToken, COOKIE_NAME } = await import(path.join(REPO_ROOT, 'server', 'auth.js'));
const { initialState } = await import(path.join(REPO_ROOT, 'shared', 'state.js'));

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

async function startServer(authMode) {
  serverProc = spawn(process.execPath, [path.join(REPO_ROOT, 'server', 'index.js')], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(PORT), AUTH_MODE: authMode },
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

  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(`${BASE_URL}/api/auth-info`);
      if (res.ok) break;
    } catch (e) { /* not up yet */ }
    if (Date.now() > deadline) {
      throw new Error(`server did not become ready within 20s; output:\n${out}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function stopServer() {
  if (!serverProc || serverProc.killed) return;
  const exited = new Promise((resolve) => serverProc.once('exit', resolve));
  serverProc.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  serverProc = null;
}

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

function skip(name, why) {
  console.log(`SKIP ${name}: ${why}`);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

let seq = 0;
async function seedUser() {
  seq += 1;
  const user = await upsertUser({
    provider: 'github', providerId: `v19-${seq}`, username: `v19user${seq}`, avatarUrl: null,
  });
  await putSave(user.id, initialState(), Date.now());
  return user;
}

function cookieFor(user) {
  return issueToken({ id: user.id, username: user.username, avatar_url: user.avatar_url });
}

// ---------------------------------------------------------------------------

await startServer('dual');

await check('GET /api/auth-info answers without a session', async () => {
  const res = await fetch(`${BASE_URL}/api/auth-info`);
  assert(res.status === 200, `expected 200, got ${res.status}`);
  const body = await res.json();
  assert(Array.isArray(body.providers), 'providers should be an array');
  assert(body.providers.includes('github'), 'github should be configured');
});

await check('dual mode tells the client to drive SuperTokens', async () => {
  const body = await (await fetch(`${BASE_URL}/api/auth-info`)).json();
  assert(body.authMode === 'dual', `authMode was ${body.authMode}`);
  assert(body.loginFlow === 'supertokens', `loginFlow was ${body.loginFlow}`);
});

await check('the passport routes are still registered underneath in dual', async () => {
  // The rollback path has to stay live: dual means both stacks work.
  const res = await fetch(`${BASE_URL}/auth/github`, { redirect: 'manual' });
  assert(res.status === 302, `expected a 302 to GitHub, got ${res.status}`);
});

await check('GET /auth/callback/github reaches the SPA, not SuperTokens', async () => {
  // SuperTokens' ThirdParty recipe serves only POST /auth/callback/apple, so
  // this falls through to the SPA - which is the only reason the client can
  // handle the redirect at all. If a future SDK starts answering here, every
  // login dead-ends and this is the check that says so.
  const res = await fetch(`${BASE_URL}/auth/callback/github?code=x`);
  const type = res.headers.get('content-type') || '';
  assert(type.includes('text/html'), `expected the SPA's HTML, got content-type ${type}`);
});

const playwright = await loadPlaywrightOrNull();

if (!playwright) {
  skip('the client login flow', 'playwright is not installed');
} else {
  const browser = await playwright.chromium.launch();

  const newPage = async () => {
    const context = await browser.newContext({ baseURL: BASE_URL });
    const page = await context.newPage();
    return { context, page };
  };

  await check('the login screen renders SuperTokens buttons in dual mode', async () => {
    const { context, page } = await newPage();
    try {
      await page.goto(`${BASE_URL}/`);
      const button = page.locator('button', { hasText: 'Continue with GitHub' });
      await button.waitFor({ timeout: 10000 });
      // A <button>, not an <a href="/auth/github">: in dual the client must
      // fetch the authorisation url rather than hit the passport route.
      assert(await button.count() === 1, 'expected exactly one GitHub button');
      assert(await page.locator('a[href="/auth/github"]').count() === 0,
        'a passport link should not be rendered when loginFlow is supertokens');
    } finally { await context.close(); }
  });

  await check('the full redirect round trip signs the player in', async () => {
    const user = await seedUser();
    const { context, page } = await newPage();
    try {
      let authUrlCalls = 0;
      let signinupBody = null;
      let signinupHeaders = null;

      // The provider, stubbed: send the browser straight back to our own
      // callback with a code, so nothing external is contacted.
      await page.route('**/auth/authorisationurl*', async (route) => {
        authUrlCalls += 1;
        const requested = new URL(route.request().url());
        assert(requested.searchParams.get('thirdPartyId') === 'github', 'wrong thirdPartyId');
        assert(
          requested.searchParams.get('redirectURIOnProviderDashboard')
            === `${BASE_URL}/auth/callback/github`,
          'wrong redirect target',
        );
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'OK',
            urlWithQueryParams: `${BASE_URL}/auth/callback/github?code=fake-code&state=fake-state`,
          }),
        });
      });

      // The core round trip, stubbed. Setting the legacy cookie here is what
      // makes the assertion real: `dual` accepts it, so /api/me succeeds and
      // the app genuinely transitions to its authenticated view.
      await page.route('**/auth/signinup', async (route) => {
        signinupBody = JSON.parse(route.request().postData() || '{}');
        signinupHeaders = route.request().headers();
        await context.addCookies([{
          name: COOKIE_NAME, value: cookieFor(user), url: BASE_URL, httpOnly: true,
        }]);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'OK', user: { id: user.id } }),
        });
      });

      await page.goto(`${BASE_URL}/`);

      // Armed BEFORE the click. Waiting on the absence of the login buttons
      // instead is a race: for a moment after the callback navigation the
      // document is empty, so "no login button" is trivially true and the
      // assertions below run before the exchange has happened.
      const signinup = page.waitForRequest(
        (req) => req.url().includes('/auth/signinup'),
        { timeout: 15000 },
      );

      await page.locator('button', { hasText: 'Continue with GitHub' }).click();
      await signinup;

      // A positive signal that the AUTHENTICATED app rendered: a fresh player
      // gets the onboarding tour, whose first step has a Next button.
      await page.getByRole('button', { name: 'Next' })
        .waitFor({ state: 'visible', timeout: 15000 });

      assert(authUrlCalls === 1, `expected 1 authorisationurl call, got ${authUrlCalls}`);
      assert(signinupBody, 'signinup was never called');
      assert(signinupBody.thirdPartyId === 'github', 'wrong provider at signinup');
      assert(
        signinupBody.redirectURIInfo.redirectURIQueryParams.code === 'fake-code',
        'the authorisation code was not forwarded',
      );
      // Never oAuthTokens - the server refuses those (rejectRawOAuthTokens).
      assert(!signinupBody.oAuthTokens, 'the client must not submit raw oAuthTokens');

      // Without this header SuperTokens returns the session in response
      // headers instead of cookies, signinup still says OK, and the next
      // /api/me is a 401. That is what v1.9.0 shipped.
      assert(
        signinupHeaders['st-auth-mode'] === 'cookie',
        `signinup must ask for cookie transport, got ${signinupHeaders['st-auth-mode']}`,
      );

      // The spent code must be replaced out of the URL: a reload that re-POSTs
      // a burned authorisation code fails and bounces the player to login.
      const url = new URL(page.url());
      assert(url.pathname === '/', `expected to land on /, got ${url.pathname}`);
      assert(!url.search.includes('code='), `the spent code is still in the URL: ${url.search}`);
    } finally { await context.close(); }
  });

  await check('a cancelled login lands back on the login screen with a message', async () => {
    const { context, page } = await newPage();
    try {
      let signinupCalled = false;
      await page.route('**/auth/signinup', async (route) => {
        signinupCalled = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });

      await page.goto(`${BASE_URL}/auth/callback/github?error=access_denied`);
      await page.locator('text=/cancelled/i').waitFor({ timeout: 10000 });

      // There is no code to exchange; POSTing anyway turns a clear "you
      // cancelled" into an opaque server error.
      assert(!signinupCalled, 'signinup must not be called when the provider refused');
    } finally { await context.close(); }
  });

  await check('a signin the server calls OK but that sets no session says so', async () => {
    // The v1.9.0 failure mode, reproduced: signinup answers status OK and no
    // session cookie is set. The player must be told, not silently returned to
    // a login screen with nothing wrong on it - that is what made the missing
    // st-auth-mode header survive a release and a production deploy.
    const { context, page } = await newPage();
    try {
      await page.route('**/auth/authorisationurl*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'OK',
          urlWithQueryParams: `${BASE_URL}/auth/callback/github?code=fake-code`,
        }),
      }));

      // OK, but deliberately no cookie - exactly what header transport does.
      await page.route('**/auth/signinup', (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'OK', user: { id: 'github:1' } }),
      }));

      await page.goto(`${BASE_URL}/`);
      await page.locator('button', { hasText: 'Continue with GitHub' }).click();
      await page.locator('text=/did not set a session/i').waitFor({ timeout: 15000 });
    } finally { await context.close(); }
  });

  await check('an unconfigured provider shows a message, not a blank screen', async () => {
    const { context, page } = await newPage();
    try {
      // Exactly what production returned for every login attempt through the
      // whole of v1.8, because the providers were registered under a key the
      // SDK ignores.
      await page.route('**/auth/authorisationurl*', (route) => route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'the provider github could not be found in the configuration' }),
      }));

      await page.goto(`${BASE_URL}/`);
      await page.locator('button', { hasText: 'Continue with GitHub' }).click();
      await page.locator('text=/not available/i').waitFor({ timeout: 10000 });
    } finally { await context.close(); }
  });

  // -------------------------------------------------------------------------
  // The same build, in passport mode.
  // -------------------------------------------------------------------------
  shuttingDown = true;
  await stopServer();
  shuttingDown = false;
  await startServer('passport');

  await check('passport mode reports itself', async () => {
    const body = await (await fetch(`${BASE_URL}/api/auth-info`)).json();
    assert(body.authMode === 'passport', `authMode was ${body.authMode}`);
    assert(body.loginFlow === 'passport', `loginFlow was ${body.loginFlow}`);
  });

  await check('the same bundle renders passport links in passport mode', async () => {
    // The reason /api/auth-info exists. Hardcoding SuperTokens would break the
    // default mode and the documented rollback; one build has to serve both.
    const { context, page } = await newPage();
    try {
      await page.goto(`${BASE_URL}/`);
      const link = page.locator('a[href="/auth/github"]');
      await link.waitFor({ timeout: 10000 });
      assert(await page.locator('button', { hasText: 'Continue with GitHub' }).count() === 0,
        'a SuperTokens button should not be rendered in passport mode');
    } finally { await context.close(); }
  });

  await browser.close();
}

shuttingDown = true;
await stopServer();

console.log('\n=== ERRORS ===');
if (failures.length === 0) {
  console.log('NONE');
} else {
  for (const f of failures) console.log(`${f.name}: ${f.message}`);
}
process.exit(failures.length === 0 ? 0 : 1);
