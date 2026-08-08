// The SuperTokens login flow, hand-rolled (v1.9).
//
// Three calls, deliberately not the `supertokens-web-js` SDK:
//
//   GET  /auth/authorisationurl  - ask the server where to send the player
//   POST /auth/signinup          - exchange the provider's ?code for a session
//   POST /auth/session/refresh   - renew an expired access token (see api.js)
//
// Those three, plus the /auth/callback/* redirect target, are EXACTLY the four
// entries in server/app.js's `gateSuperTokensPaths` allowlist. That is not a
// coincidence and it is the reason to hand-roll: the SDK assumes a surface we
// deliberately do not serve. Its signOut() targets POST /auth/signout, which
// v1.8 removed on purpose because it clears only the SuperTokens half of a
// dual-stack session and leaves the legacy JWT cookie authenticating the very
// next request. Adopting the SDK would mean either re-opening that endpoint or
// re-pointing it at /auth/logout - and a login that half-works is worse than
// one that fails loudly.
//
// Error convention matches game/api.js: these functions RETURN failure, they
// never throw.
//
// `credentials: 'include'` is mandatory on both calls. The session cookies
// SuperTokens sets on the signinup response are the entire point; without it
// the request succeeds, the player is handed a session, and the browser throws
// it away.

// The path the provider redirects back to. Registered on the GitHub/Discord
// OAuth apps alongside the passport callbacks (runbook Part A widens them
// rather than replacing them, so both stacks keep working during a rollout).
export const CALLBACK_PREFIX = '/auth/callback/';

// SuperTokens' ThirdParty recipe handles exactly one callback route,
// POST /auth/callback/apple. A GET to /auth/callback/github is not an API it
// serves, so its middleware calls next() and the request falls through to the
// SPA - which is what lets this module handle the redirect in the client at
// all. tests/supertokens.middleware.test.js pins that fallthrough.
export function callbackProviderFromPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(CALLBACK_PREFIX)) return null;
  const rest = pathname.slice(CALLBACK_PREFIX.length).replace(/\/+$/, '');
  // One segment only: '/auth/callback/github/extra' is not a provider.
  if (!rest || rest.includes('/')) return null;
  return rest;
}

// sessionStorage rather than localStorage: the verifier is single-use and
// scoped to this one login attempt, so it must not outlive the tab or leak
// into a second one. Absent PKCE (neither GitHub nor Discord uses it today)
// nothing is ever stored - but the SDK may return a verifier for a provider
// that does, and silently dropping it would break that provider's login in a
// way that only shows up at the exchange.
const PKCE_KEY = 'rackstack.st.pkce';

function storePkce(verifier) {
  try {
    if (verifier) window.sessionStorage.setItem(PKCE_KEY, verifier);
    else window.sessionStorage.removeItem(PKCE_KEY);
  } catch { /* private mode, storage disabled - PKCE providers simply won't work */ }
}

function takePkce() {
  try {
    const v = window.sessionStorage.getItem(PKCE_KEY);
    window.sessionStorage.removeItem(PKCE_KEY);
    return v || undefined;
  } catch { return undefined; }
}

async function requestJSON(path, opts) {
  let res;
  try {
    res = await fetch(path, { credentials: 'include', ...opts });
  } catch {
    return { status: 0, error: 'network_error' };
  }
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  if (!res.ok) {
    const errBody = (body && typeof body === 'object') ? body : {};
    return { status: res.status, ...errBody, error: errBody.error || 'request_failed' };
  }
  return body ?? {};
}

// GET /api/auth-info -> { authMode, loginFlow: 'passport'|'supertokens', providers: [id] }
//
// Public by design - it is what the login screen reads before anyone is
// authenticated, which is why it is not on /api/config (that route is behind
// requireAuth). `loginFlow` is the server's decision, not something the client
// re-derives from authMode: in `dual` both stacks work and the server says to
// drive SuperTokens, because exercising that path is the whole point of dual.
export function fetchAuthInfo() {
  return requestJSON('/api/auth-info');
}

// What to assume when /api/auth-info cannot be reached. `passport` is the
// server's default mode and the documented rollback, so falling back to it
// keeps a player able to log in on a server that is otherwise healthy - the
// alternative is a login screen with no buttons on it. It also leaves refresh
// disabled, which is the safe direction: a pointless refresh attempt in
// passport mode is a doomed round trip on every 401.
export const FALLBACK_AUTH_INFO = Object.freeze({
  authMode: 'passport',
  loginFlow: 'passport',
  providers: Object.freeze(['github', 'discord']),
});

/**
 * Step 1 of the login: ask where to send the player, then send them.
 *
 * Navigates away on success, so it resolves only on failure. Callers should
 * treat a returned value as "the login did not start" and show it.
 */
export async function startSuperTokensLogin(providerId, {
  origin = window.location.origin,
  assign = (url) => window.location.assign(url),
} = {}) {
  const redirectURI = `${origin}${CALLBACK_PREFIX}${providerId}`;
  const query = new URLSearchParams({
    thirdPartyId: providerId,
    redirectURIOnProviderDashboard: redirectURI,
  });

  const res = await requestJSON(`/auth/authorisationurl?${query}`);
  if (res.error || res.status !== 'OK' || !res.urlWithQueryParams) {
    // The 400 worth naming, because it is what a misconfigured deployment
    // returns and it reads as a generic failure otherwise: SuperTokens says
    // "the provider <id> could not be found in the configuration" when the
    // recipe has no such provider. Through all of v1.8 that was every request,
    // because init.js registered the providers under a key the SDK ignores.
    return { ok: false, provider: providerId, reason: 'unavailable' };
  }

  // Only meaningful for providers that use PKCE; undefined for GitHub/Discord.
  storePkce(res.pkceCodeVerifier);
  assign(res.urlWithQueryParams);
  return { ok: true };
}

/**
 * Step 2: the provider has redirected back to /auth/callback/<provider>.
 * Exchange the code for a session.
 *
 * Returns { ok: true } once the session cookies are set, or
 * { ok: false, provider, reason } for the login screen to render.
 */
export async function completeSuperTokensLogin({
  pathname = window.location.pathname,
  search = window.location.search,
  origin = window.location.origin,
} = {}) {
  const provider = callbackProviderFromPath(pathname);
  if (!provider) return { ok: false, provider: null, reason: 'failed' };

  const params = new URLSearchParams(search);

  // The provider itself refused or the player cancelled. There is no code to
  // exchange, and POSTing anyway turns a clear "you cancelled" into an opaque
  // server error.
  const providerError = params.get('error');
  if (providerError) {
    return {
      ok: false,
      provider,
      reason: providerError === 'access_denied' ? 'denied' : 'failed',
    };
  }
  if (!params.get('code')) return { ok: false, provider, reason: 'failed' };

  const redirectURIQueryParams = {};
  for (const [key, value] of params.entries()) redirectURIQueryParams[key] = value;

  const pkceCodeVerifier = takePkce();

  // redirectURIInfo, never oAuthTokens. Submitting tokens directly is refused
  // server-side by rejectRawOAuthTokens: accepting caller-supplied tokens as
  // proof of identity was an account-takeover bypass, because GitHub's
  // validateAccessToken never runs (providers/github.js replaces getUserInfo
  // wholesale).
  const res = await requestJSON('/auth/signinup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      thirdPartyId: provider,
      redirectURIInfo: {
        // Must be byte-identical to the value sent to /auth/authorisationurl:
        // the provider echoes it back and SuperTokens compares them.
        redirectURIOnProviderDashboard: `${origin}${CALLBACK_PREFIX}${provider}`,
        redirectURIQueryParams,
        ...(pkceCodeVerifier ? { pkceCodeVerifier } : {}),
      },
    }),
  });

  if (res.error) {
    // rejectRawOAuthTokens and any other server-side refusal land here.
    return { ok: false, provider, reason: 'failed' };
  }

  switch (res.status) {
    case 'OK':
      return { ok: true, provider, user: res.user };
    case 'SIGN_IN_UP_NOT_ALLOWED':
      return { ok: false, provider, reason: 'not_allowed' };
    case 'NO_EMAIL_GIVEN_BY_PROVIDER':
      // Should be unreachable: providers.js sets requireEmail:false for
      // Discord precisely so the narrowed 'identify' scope cannot trip this.
      // Handled anyway, because the alternative is a blank screen.
      return { ok: false, provider, reason: 'no_email' };
    default:
      return { ok: false, provider, reason: 'failed' };
  }
}

// Human-readable text for the login screen. Kept next to the reasons that
// produce it so the two cannot drift.
export function loginErrorMessage(provider, reason) {
  const name = provider === 'github' ? 'GitHub' : provider === 'discord' ? 'Discord' : 'the provider';
  switch (reason) {
    case 'denied':
      return `Sign-in with ${name} was cancelled.`;
    case 'unavailable':
      return `${name} sign-in is not available on this server right now.`;
    case 'not_allowed':
      return `This account is not allowed to sign in with ${name}.`;
    case 'no_email':
      return `${name} did not share an email address, which this server requires.`;
    default:
      return `Login with ${name} failed. Try again.`;
  }
}
