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

beforeEach(() => {
  originalFetch = globalThis.fetch;
  __resetAuthRefreshForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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
