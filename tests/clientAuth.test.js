// The client half of the SuperTokens flow (v1.9): client/src/game/auth.js and
// the refresh-on-401 wrapper in client/src/game/api.js.
//
// Both are exercised against a stubbed global fetch rather than a browser.
// What matters here is the protocol - which endpoint, which body, how many
// times - and that is exactly what a stub can assert and a rendered component
// cannot.

process.env.JWT_SECRET = 'test-secret-client-auth';

import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';

import {
  callbackProviderFromPath,
  startSuperTokensLogin,
  completeSuperTokensLogin,
  loginErrorMessage,
  FALLBACK_AUTH_INFO,
} from '../client/src/game/auth.js';

import {
  fetchState, configureAuthRefresh, __resetAuthRefreshForTests,
} from '../client/src/game/api.js';

const ORIGIN = 'https://rackstack.example.com';

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  };
}

let originalFetch;
let originalNavigator;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalNavigator = globalThis.navigator;
  __resetAuthRefreshForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  // Plain reassignment can throw: the real `navigator` global is an accessor
  // with no setter, and a test may have left it in that pristine state.
  // Deleting first (a no-op if a test already replaced it) sidesteps that.
  delete globalThis.navigator;
  if (originalNavigator !== undefined) globalThis.navigator = originalNavigator;
  vi.restoreAllMocks();
});

describe('callbackProviderFromPath', () => {
  it('recognises the provider redirect target', () => {
    expect(callbackProviderFromPath('/auth/callback/github')).toBe('github');
    expect(callbackProviderFromPath('/auth/callback/discord')).toBe('discord');
  });

  it('tolerates a trailing slash', () => {
    expect(callbackProviderFromPath('/auth/callback/github/')).toBe('github');
  });

  it('is not fooled by a deeper path or a lookalike prefix', () => {
    // A deeper path is not a provider, and must not be handed to the server as
    // one - `/auth/callback/github/../x` style values are how a redirect
    // target turns into an open redirect.
    expect(callbackProviderFromPath('/auth/callback/github/extra')).toBeNull();
    expect(callbackProviderFromPath('/auth/callbackfoo/github')).toBeNull();
    expect(callbackProviderFromPath('/auth/callback/')).toBeNull();
    expect(callbackProviderFromPath('/')).toBeNull();
    expect(callbackProviderFromPath(undefined)).toBeNull();
  });
});

describe('startSuperTokensLogin', () => {
  it('asks for the authorisation url and navigates to it', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse({ status: 'OK', urlWithQueryParams: 'https://github.com/login/oauth?x=1' });
    });

    let navigatedTo = null;
    const res = await startSuperTokensLogin('github', {
      origin: ORIGIN,
      assign: (url) => { navigatedTo = url; },
    });

    expect(res.ok).toBe(true);
    expect(navigatedTo).toBe('https://github.com/login/oauth?x=1');

    const requested = new URL(calls[0].url, ORIGIN);
    expect(requested.pathname).toBe('/auth/authorisationurl');
    expect(requested.searchParams.get('thirdPartyId')).toBe('github');
    // The redirect target the provider will send the player back to, and the
    // value SuperTokens will compare against at the exchange.
    expect(requested.searchParams.get('redirectURIOnProviderDashboard'))
      .toBe(`${ORIGIN}/auth/callback/github`);
    expect(calls[0].opts.credentials).toBe('include');
  });

  it('reports an unconfigured provider instead of navigating', async () => {
    // The exact production failure v1.9 fixes: SuperTokens 400s with "the
    // provider github could not be found in the configuration" when the recipe
    // has no such provider. The player must see a message, not a blank screen.
    globalThis.fetch = vi.fn(async () => jsonResponse(
      { message: 'the provider github could not be found in the configuration' },
      { ok: false, status: 400 },
    ));

    let navigated = false;
    const res = await startSuperTokensLogin('github', {
      origin: ORIGIN,
      assign: () => { navigated = true; },
    });

    expect(navigated).toBe(false);
    expect(res).toMatchObject({ ok: false, provider: 'github', reason: 'unavailable' });
    expect(loginErrorMessage('github', res.reason)).toMatch(/not available/i);
  });
});

describe('completeSuperTokensLogin', () => {
  it('exchanges the code via redirectURIInfo and reports the mapped user', async () => {
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse({ status: 'OK', user: { id: 'github:37058311' } });
    });

    const res = await completeSuperTokensLogin({
      pathname: '/auth/callback/github',
      search: '?code=abc123&state=xyz',
      origin: ORIGIN,
    });

    expect(res.ok).toBe(true);
    // The whole release rests on this being the pre-existing users.id rather
    // than a SuperTokens UUID.
    expect(res.user.id).toBe('github:37058311');

    expect(calls[0].url).toBe('/auth/signinup');
    expect(calls[0].opts.method).toBe('POST');
    expect(calls[0].opts.credentials).toBe('include');

    const body = JSON.parse(calls[0].opts.body);
    expect(body.thirdPartyId).toBe('github');
    expect(body.redirectURIInfo.redirectURIQueryParams).toEqual({ code: 'abc123', state: 'xyz' });
    expect(body.redirectURIInfo.redirectURIOnProviderDashboard)
      .toBe(`${ORIGIN}/auth/callback/github`);

    // Never oAuthTokens: submitting tokens directly is refused server-side by
    // rejectRawOAuthTokens, because accepting caller-supplied tokens as proof
    // of identity was an account-takeover bypass.
    expect(body.oAuthTokens).toBeUndefined();
  });

  it('asks for the session in COOKIES, which is what actually logs the player in', async () => {
    // The v1.9.0 regression, and the reason it shipped. SuperTokens picks the
    // token transfer method at session creation from this header, and with it
    // absent defaults to "header" - the session comes back in st-access-token
    // response headers, no cookie is set, signinup still answers status OK,
    // and the next /api/me is a 401. Nothing in the flow reports an error.
    //
    // supertokens-web-js sends this for you. Hand-rolling means owning it.
    const calls = [];
    globalThis.fetch = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      return jsonResponse({ status: 'OK', user: { id: 'github:37058311' } });
    });

    await completeSuperTokensLogin({
      pathname: '/auth/callback/github',
      search: '?code=abc123',
      origin: ORIGIN,
    });

    expect(calls[0].opts.headers['st-auth-mode']).toBe('cookie');
  });

  it('does not POST when the player cancelled at the provider', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ status: 'OK' }));

    const res = await completeSuperTokensLogin({
      pathname: '/auth/callback/github',
      search: '?error=access_denied',
      origin: ORIGIN,
    });

    // POSTing a callback that carries no code turns a clear "you cancelled"
    // into an opaque server error.
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false, provider: 'github', reason: 'denied' });
    expect(loginErrorMessage('github', res.reason)).toMatch(/cancelled/i);
  });

  it('does not POST when there is no code at all', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ status: 'OK' }));

    const res = await completeSuperTokensLogin({
      pathname: '/auth/callback/github',
      search: '',
      origin: ORIGIN,
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
  });

  it('surfaces SIGN_IN_UP_NOT_ALLOWED as its own message', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({
      status: 'SIGN_IN_UP_NOT_ALLOWED', reason: 'nope',
    }));

    const res = await completeSuperTokensLogin({
      pathname: '/auth/callback/discord',
      search: '?code=abc',
      origin: ORIGIN,
    });

    expect(res).toMatchObject({ ok: false, provider: 'discord', reason: 'not_allowed' });
    expect(loginErrorMessage('discord', res.reason)).toMatch(/not allowed/i);
  });

  it('treats a server refusal (GENERAL_ERROR / rejectRawOAuthTokens) as a failure', async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse(
      { status: 'GENERAL_ERROR', message: 'refused' },
      { ok: false, status: 400 },
    ));

    const res = await completeSuperTokensLogin({
      pathname: '/auth/callback/github',
      search: '?code=abc',
      origin: ORIGIN,
    });

    expect(res).toMatchObject({ ok: false, reason: 'failed' });
  });
});

describe('the fallback auth info', () => {
  it('assumes passport, which leaves refresh off', () => {
    // The safe direction on an unreachable /api/auth-info: buttons still
    // render (passport is the server default and the documented rollback) and
    // no doomed refresh is attempted on every 401.
    expect(FALLBACK_AUTH_INFO.loginFlow).toBe('passport');
    configureAuthRefresh(FALLBACK_AUTH_INFO);
  });
});

describe('refresh on 401', () => {
  it('refreshes once and retries the original request', async () => {
    configureAuthRefresh({ loginFlow: 'supertokens' });

    const seen = [];
    let stateCalls = 0;
    globalThis.fetch = vi.fn(async (url) => {
      seen.push(url);
      if (url === '/auth/session/refresh') return { ok: true, status: 200, text: async () => '' };
      stateCalls += 1;
      if (stateCalls === 1) return jsonResponse({ error: 'unauthorized' }, { ok: false, status: 401 });
      return jsonResponse({ run: { level: 3 } });
    });

    const res = await fetchState();

    expect(res).toEqual({ run: { level: 3 } });
    expect(seen).toEqual(['/api/state', '/auth/session/refresh', '/api/state']);
  });

  it('asks for the refreshed session in cookies too', async () => {
    configureAuthRefresh({ loginFlow: 'supertokens' });

    const calls = [];
    let refreshed = false;
    globalThis.fetch = vi.fn(async (url, opts) => {
      calls.push({ url, opts });
      if (url === '/auth/session/refresh') {
        refreshed = true;
        return { ok: true, status: 200, text: async () => '' };
      }
      if (!refreshed) return jsonResponse({ error: 'unauthorized' }, { ok: false, status: 401 });
      return jsonResponse({ ok: true });
    });

    await fetchState();

    // A refresh that silently moved the session to header transport would log
    // the player out on the next request - the same invisible failure as the
    // signinup one, just deferred.
    const refresh = calls.find((c) => c.url === '/auth/session/refresh');
    expect(refresh.opts.headers['st-auth-mode']).toBe('cookie');
  });

  it('gives up after a second 401 rather than looping', async () => {
    configureAuthRefresh({ loginFlow: 'supertokens' });

    let refreshes = 0;
    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/auth/session/refresh') {
        refreshes += 1;
        return { ok: true, status: 200, text: async () => '' };
      }
      return jsonResponse({ error: 'unauthorized' }, { ok: false, status: 401 });
    });

    const res = await fetchState();

    // A 401 after a successful refresh means the session is genuinely gone.
    expect(refreshes).toBe(1);
    expect(res.status).toBe(401);
  });

  it('sends exactly ONE refresh for concurrent 401s', async () => {
    configureAuthRefresh({ loginFlow: 'supertokens' });

    let refreshes = 0;
    let refreshResolve;
    const refreshGate = new Promise((resolve) => { refreshResolve = resolve; });
    // The access token is expired for EVERY request until a refresh completes.
    // (An earlier version of this test keyed "already seen" off the URL, so
    // only the first of the three ever got a 401 - and it passed with the
    // single-flight guard deleted. The gate below is what makes all three
    // 401 concurrently, which is the whole scenario.)
    let refreshed = false;

    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/auth/session/refresh') {
        refreshes += 1;
        await refreshGate;
        refreshed = true;
        return { ok: true, status: 200, text: async () => '' };
      }
      if (!refreshed) return jsonResponse({ error: 'unauthorized' }, { ok: false, status: 401 });
      return jsonResponse({ ok: true });
    });

    // Three requests fire together, all hit an expired access token. A refresh
    // per 401 would send three concurrent calls presenting the SAME refresh
    // token; SuperTokens rotates it on use, so the second and third look like
    // token theft to the core and it revokes the session. One shared promise
    // is what prevents a routine renewal becoming a forced logout.
    const all = Promise.all([fetchState(), fetchState(), fetchState()]);
    await new Promise((r) => setTimeout(r, 10));
    refreshResolve();
    await all;

    expect(refreshes).toBe(1);
  });

  it('never refreshes in passport mode', async () => {
    configureAuthRefresh({ loginFlow: 'passport' });

    const seen = [];
    globalThis.fetch = vi.fn(async (url) => {
      seen.push(url);
      return jsonResponse({ error: 'unauthorized' }, { ok: false, status: 401 });
    });

    const res = await fetchState();

    // In passport mode a 401 means "not logged in" and the refresh endpoint is
    // not even mounted.
    expect(seen).toEqual(['/api/state']);
    expect(res.status).toBe(401);
  });

  it('does not retry when the refresh itself fails', async () => {
    configureAuthRefresh({ loginFlow: 'supertokens' });

    const seen = [];
    globalThis.fetch = vi.fn(async (url) => {
      seen.push(url);
      if (url === '/auth/session/refresh') return { ok: false, status: 401, text: async () => '' };
      return jsonResponse({ error: 'unauthorized' }, { ok: false, status: 401 });
    });

    const res = await fetchState();

    expect(seen).toEqual(['/api/state', '/auth/session/refresh']);
    expect(res.status).toBe(401);
  });
});

// The real `navigator` global (Node 21+, and every browser) exposes
// `navigator` as an accessor with no setter, so a plain `globalThis.navigator
// = ...` throws in this ESM test file's strict mode. Delete it first, same
// as this codebase's own withRefreshLock() feature-detects its absence.
function stubNavigator(value) {
  delete globalThis.navigator;
  if (value !== undefined) globalThis.navigator = value;
}

describe('cross-tab refresh coordination', () => {
  it('still sends exactly one refresh for concurrent 401s when navigator.locks exists', async () => {
    configureAuthRefresh({ loginFlow: 'supertokens' });
    // A trivial single-tab-shaped stub: Web Locks exists, but only one caller
    // is ever asking, so it should behave exactly like having no lock at all.
    stubNavigator({ locks: { request: (name, fn) => fn() } });

    let refreshes = 0;
    let refreshResolve;
    const refreshGate = new Promise((resolve) => { refreshResolve = resolve; });
    let refreshed = false;

    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/auth/session/refresh') {
        refreshes += 1;
        await refreshGate;
        refreshed = true;
        return { ok: true, status: 200, text: async () => '' };
      }
      if (!refreshed) return jsonResponse({ error: 'unauthorized' }, { ok: false, status: 401 });
      return jsonResponse({ ok: true });
    });

    const all = Promise.all([fetchState(), fetchState(), fetchState()]);
    await new Promise((r) => setTimeout(r, 10));
    refreshResolve();
    await all;

    // Proves the lock wrapper doesn't defeat the existing in-tab single-flight
    // guard now that a navigator.locks happens to exist.
    expect(refreshes).toBe(1);
  });

  it('serialises refreshes across tabs so neither ever overlaps the other', async () => {
    // Two tabs = two independent module instances, each with its own private
    // inFlightRefresh closure - exactly what two separate browsing contexts
    // running the same bundle would have. vi.resetModules() + a fresh
    // dynamic import gets us that inside one test file; it does not disturb
    // the module instance this file's own top-level `fetchState` etc. are
    // bound to (those bindings were already linked when the file loaded).
    vi.resetModules();
    const tab1 = await import('../client/src/game/api.js');
    vi.resetModules();
    const tab2 = await import('../client/src/game/api.js');

    tab1.configureAuthRefresh({ loginFlow: 'supertokens' });
    tab2.configureAuthRefresh({ loginFlow: 'supertokens' });

    // Both "tabs" share one browser-wide Web Locks manager in reality; model
    // that with one real FIFO mutex shared by both module instances (they
    // already share globalThis, exactly as two tabs share it).
    let queue = Promise.resolve();
    stubNavigator({
      locks: {
        request: (name, fn) => {
          const run = queue.then(fn, fn);
          queue = run.catch(() => {});
          return run;
        },
      },
    });

    let active = 0;
    let overlapped = false;
    let refreshCalls = 0;
    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/auth/session/refresh') {
        refreshCalls += 1;
        if (active > 0) overlapped = true;
        active += 1;
        // Wide enough to make an unguarded race show up reliably.
        await new Promise((r) => setTimeout(r, 10));
        active -= 1;
        return { ok: true, status: 200, text: async () => '' };
      }
      // Both tabs' access tokens are expired - each retries its own request
      // exactly once, same as every other test in this file.
      return jsonResponse({ error: 'unauthorized' }, { ok: false, status: 401 });
    });

    await Promise.all([tab1.fetchState(), tab2.fetchState()]);

    // The invariant that actually prevents SuperTokens' theft detection: the
    // two tabs' refresh network calls never overlap in time.
    expect(overlapped).toBe(false);
    // And the fix doesn't falsely dedupe tab2's refresh away - a lock delays,
    // it does not merge, so each tab still gets exactly one refresh call.
    expect(refreshCalls).toBe(2);
  });

  it('falls back to per-tab-only refresh when navigator is entirely unavailable', async () => {
    configureAuthRefresh({ loginFlow: 'supertokens' });
    stubNavigator(undefined);

    let refreshes = 0;
    let refreshed = false;
    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/auth/session/refresh') {
        refreshes += 1;
        refreshed = true;
        return { ok: true, status: 200, text: async () => '' };
      }
      if (!refreshed) return jsonResponse({ error: 'unauthorized' }, { ok: false, status: 401 });
      return jsonResponse({ ok: true });
    });

    const res = await fetchState();

    expect(refreshes).toBe(1);
    expect(res).toEqual({ ok: true });
  });

  it('falls back when navigator exists but has no locks (this test runtime today)', async () => {
    configureAuthRefresh({ loginFlow: 'supertokens' });
    // Exactly the shape Node's own built-in `navigator` global has - no
    // `.locks` - which is why every OTHER test in this file already exercises
    // this path implicitly. This test pins it explicitly so it can't regress
    // silently if a future Node/vitest version adds navigator.locks.
    stubNavigator({ userAgent: 'test' });

    let refreshes = 0;
    let refreshed = false;
    globalThis.fetch = vi.fn(async (url) => {
      if (url === '/auth/session/refresh') {
        refreshes += 1;
        refreshed = true;
        return { ok: true, status: 200, text: async () => '' };
      }
      if (!refreshed) return jsonResponse({ error: 'unauthorized' }, { ok: false, status: 401 });
      return jsonResponse({ ok: true });
    });

    const res = await fetchState();

    expect(refreshes).toBe(1);
    expect(res).toEqual({ ok: true });
  });
});
