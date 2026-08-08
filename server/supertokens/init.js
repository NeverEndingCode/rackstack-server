// SuperTokens initialisation, kept entirely behind the AUTH_MODE guard.
//
// Every import of supertokens-node in this file is DYNAMIC and happens
// inside initSuperTokens(), after the mode check. That is a hard requirement,
// not a style preference:
//
//   1. In the default `passport` mode the SDK must not be loaded at all, so
//      that upgrading to v1.8 cannot change behaviour, startup time, or
//      memory footprint for operators who never opt in.
//   2. supertokens-node pulls in a large transitive tree (nodemailer, twilio,
//      libphonenumber-js) that exists only to serve recipes this project
//      never initialises. v1.7 shipped CI that was silently red for four
//      commits because a top-level import pulled in a package that could not
//      load on the runtime's Node version. A static import here would put
//      that whole tree on the boot path of every deployment, opted in or not.
//
// We ASK for ThirdParty and Session only. That is not the same as those being
// the only recipes present, and the difference is load-bearing enough to state
// plainly: `supertokens.init()` auto-adds multitenancy, usermetadata,
// oauth2provider, openid, jwt and accountlinking regardless of what
// `recipeList` says, contributing 13 further live HTTP endpoints. An earlier
// version of this comment claimed "ThirdParty and Session ONLY", which was
// simply false and is why `POST /auth/oauth/logout` - carrying the same
// half-logout bug as the signout endpoint - went unnoticed until the v1.8
// fix-verification review.
//
// The HTTP surface is therefore constrained in app.js by an allowlist
// (`gateSuperTokensPaths`) rather than by what we requested here. Do not
// reintroduce the assumption that recipeList bounds the endpoints.
//
// The nodemailer advisory in the dependency tree does remain unreachable, but
// for a narrower reason than "only two recipes": none of the auto-added
// recipes constructs an SMTP delivery service either. nodemailer is referenced
// solely by emailpassword / emailverification / passwordless / webauthn, and
// none of those is initialised. Adding any of them makes the advisory live.

import { isSuperTokensEnabled } from '../authMode.js';
import { buildProviders, resolvePublicOrigin } from './providers.js';
import { buildSignInUpOverride } from './mapping.js';
import { probeAuthedEndpoint, isRefused } from './coreProbe.js';

// SuperTokens' own default API base path. It is also why the runbook widens
// the GitHub OAuth registration to /auth: SuperTokens serves its callbacks at
// `${apiBasePath}/callback/<provider>`, i.e. /auth/callback/github, while
// passport uses /auth/github/callback. Both are subdirectories of /auth.
export const API_BASE_PATH = '/auth';

let initialised = false;

/**
 * Closes an authentication bypass in SuperTokens' stock `signInUpPOST`.
 *
 * THE HOLE. The stock API accepts EITHER `redirectURIInfo` (the browser
 * authorization-code flow) OR a caller-supplied `oAuthTokens` object, and
 * treats the latter as proof of identity:
 *
 *   recipe/thirdparty/api/signinup.js
 *     else if (bodyParams.oAuthTokens !== undefined) { oAuthTokens = ... }
 *
 * The audience check that should make that safe does not run for GitHub. The
 * SDK's GitHub provider DEFINES `config.validateAccessToken` - which asks
 * `POST api.github.com/applications/{client_id}/token` whether the token was
 * minted for this OAuth app - but that function is only ever invoked from the
 * GENERIC `getUserInfo` in providers/custom.js. providers/github.js then
 * REPLACES `getUserInfo` wholesale in its own override, and the override is
 * applied last, so the check is dead code. GitHub's replacement calls
 * api.github.com/user directly with `Bearer <token>` and asks nothing about
 * where the token came from.
 *
 * Net effect, unpatched: an unauthenticated
 *   POST /auth/signinup {"thirdPartyId":"github","oAuthTokens":{"access_token":"..."}}
 * with ANY GitHub token that can read /user - one from an unrelated OAuth app
 * the victim authorised, or a leaked PAT - resolves to that victim's
 * `thirdPartyUserId`, and our mapping faithfully turns it into their
 * `users.id`. Account takeover, and full admin if the victim is in
 * SUPER_ADMIN_IDS, whose values are deterministic and effectively public.
 *
 * This is a regression against the passport stack rather than a pre-existing
 * flaw: passport-github2 only ever obtains a token by exchanging an
 * authorization code with our own client secret, so a foreign token can never
 * be replayed at it.
 *
 * THE FIX. RackStack is browser-only and has no native or mobile client, so
 * the token-submission flow has no legitimate caller here. Reject it and keep
 * only the redirect flow, where the token is obtained by exchanging a code
 * using our own client secret and is therefore bound to this application.
 */
export function rejectRawOAuthTokens(originalImplementation) {
  return {
    ...originalImplementation,
    signInUpPOST: originalImplementation.signInUpPOST === undefined
      ? undefined
      : async function signInUpPOST(input) {
        if (input.redirectURIInfo === undefined) {
          // GENERAL_ERROR rather than a thrown Error. Throwing here reached
          // Express's default handler as a 500, which is both less precise and
          // actively misleading: a 500 reads as transient, so a client would
          // retry a request that can never succeed. (No internals leaked - the
          // shipped image sets NODE_ENV=production - but a bare-metal
          // `npm start` without it would have returned the stack.)
          // GENERAL_ERROR is the SDK's own contract for "refused, do not
          // retry", and it carries the reason to the caller.
          return {
            status: 'GENERAL_ERROR',
            message:
              'signInUp requires the redirect-URI flow. Submitting oAuthTokens directly is '
              + 'not accepted: RackStack cannot verify that such a token was issued to this '
              + 'application, so honouring it would let any third-party token authenticate as '
              + 'its owner.',
          };
        }
        return originalImplementation.signInUpPOST(input);
      },
  };
}

/**
 * Whether a connection URI points at this host only.
 *
 * Parsed rather than string-matched, so `http://127.0.0.1.evil.com:3567` is
 * correctly treated as remote - a substring check for '127.0.0.1' would wave
 * it through, which is the classic way this kind of exemption goes wrong.
 */
export function isLoopback(uri) {
  try {
    const { hostname } = new URL(uri);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
      || hostname === '[::1]';
  } catch {
    // Unparseable means we cannot establish it is local, so treat it as remote
    // and require the key. Failing towards "more authentication" is correct.
    return false;
  }
}

/**
 * Confirms the core actually refuses unauthenticated callers.
 *
 * Throws ONLY on a confirmed-open core - an endpoint we know exists answering
 * an unkeyed request with 200. Every other outcome warns and lets the boot
 * proceed, because this guard sits on the startup path and a wrong answer here
 * does not print a scary line, it stops the container.
 *
 * That distinction was missing in v1.8.2: this probed a single hardcoded path
 * that core 12 does not implement, and treated the resulting 404 as proof the
 * core was open - so setting AUTH_MODE=dual against a perfectly well-secured
 * core would have refused to start, blaming the operator for a URL this code
 * got wrong. The probe now lives in ./coreProbe.js and is shared with the
 * preflight, so the two cannot drift again.
 */
export async function assertCoreRejectsAnonymous({ connectionURI, hasKey, fetchImpl = fetch }) {
  let probe;
  try {
    probe = await probeAuthedEndpoint({ connectionURI, fetchImpl });
  } catch (e) {
    // Unreachable, DNS failure, timeout. Cannot establish anything; the core
    // may simply still be starting. Warn rather than refuse.
    console.warn(
      `[auth] could not verify that the SuperTokens core at ${connectionURI} requires `
      + `authentication (${e.message}). If it is running without API_KEYS, anyone who can `
      + 'reach it can mint a session for any user id.',
    );
    return 'unverified';
  }

  if (isRefused(probe.status)) return 'closed';

  if (probe.status === 200) {
    throw new Error(
      `The SuperTokens core at ${connectionURI} answered an unauthenticated request to `
      + `${probe.path} with HTTP 200, which means it is running without API_KEYS. Anyone who `
      + 'can reach it can mint a session for any user id, including every value in '
      + 'SUPER_ADMIN_IDS, without any request reaching RackStack. Set API_KEYS on the core to '
      + `the same value as SUPERTOKENS_API_KEY here${hasKey ? '' : ' (which is also unset)'}, `
      + 'and do not publish its port.',
    );
  }

  // A 404 from every candidate, or any other unexpected status, says our URL
  // is wrong for this core version - not that the core is open. Refusing to
  // boot on that would be punishing the operator for our own mistake.
  console.warn(
    `[auth] could not verify that the SuperTokens core at ${connectionURI} requires `
    + `authentication (${probe.status === null ? 'no known endpoint answered' : `unexpected HTTP ${probe.status}`}). `
    + 'This is NOT evidence that it is open, but do check it by hand.',
  );
  return 'unverified';
}

/**
 * Removes the Session recipe's stock `POST /auth/signout`.
 *
 * The Session recipe registers that endpoint automatically, and it revokes the
 * SuperTokens session while leaving RackStack's legacy JWT cookie untouched.
 * `requireAuth`'s fallback branch then re-authenticates the supposedly
 * logged-out user on the very next request: the UI says signed out, the server
 * disagrees, and on a shared machine that is account exposure rather than a
 * cosmetic bug.
 *
 * It is exactly the half-logout `server/routes/authRoutes.js` was written to
 * prevent - the guarantee was simply enforced on `/auth/logout`, the route the
 * current client happens to call, while the SDK quietly published a second
 * door. The SuperTokens frontend SDK's `signOut()` targets `/auth/signout`, so
 * this would have become the DEFAULT path the moment the planned Phase 5
 * frontend work landed.
 *
 * Removed rather than patched: `/auth/logout` already clears both stacks, and
 * one logout route that is known to be complete beats two that must be kept in
 * agreement forever. A client calling `/auth/signout` gets a 404, which is
 * loud - and a logout that fails loudly is strictly better than one that half
 * works.
 */
/**
 * Confirms the core speaks a protocol version this SDK understands.
 *
 * `supertokens-node` pins an exact set of core-driver-interface versions - at
 * the time of writing, exactly one - and the core must offer it. The
 * compatible window is therefore narrow, and a core upgrade can leave it.
 *
 * The SDK does detect this, but only from inside a request: `getAPIVersion` is
 * called by the request helpers, so a mismatch surfaces on the first LOGIN
 * ATTEMPT, not at startup. The container looks healthy, the health check
 * passes, and the first you hear of it is a player saying they cannot log in.
 * Checking at boot converts that into a container that refuses to start and
 * says why - which is the difference between a five-minute fix and an
 * afternoon.
 *
 * Unreachable is a warning, not a failure, for the same reason as the API-key
 * probe: the core may legitimately still be starting.
 */
export async function assertCoreSpeaksOurProtocol({ connectionURI, apiKey, fetchImpl = fetch }) {
  const { cdiSupported } = await import('supertokens-node/lib/build/version.js');
  const headers = { 'api-version': '3.0' };
  if (apiKey) headers['api-key'] = apiKey;

  let offered;
  try {
    const res = await fetchImpl(`${connectionURI.replace(/\/$/, '')}/apiversion`, {
      method: 'GET', headers, signal: AbortSignal.timeout(5000),
    });
    const body = typeof res.json === 'function' ? await res.json() : {};
    offered = body?.versions;
  } catch (e) {
    console.warn(
      `[auth] could not verify the SuperTokens core's protocol version (${e.message}). `
      + `This SDK requires core-driver-interface ${cdiSupported.join(' or ')}.`,
    );
    return 'unverified';
  }

  if (!Array.isArray(offered) || offered.length === 0) {
    console.warn('[auth] the SuperTokens core did not report its core-driver-interface versions.');
    return 'unverified';
  }

  const shared = cdiSupported.filter((v) => offered.includes(v));
  if (shared.length > 0) return shared;

  throw new Error(
    `The SuperTokens core at ${connectionURI} speaks core-driver-interface `
    + `${offered[offered.length - 1]} at newest, but this SDK requires `
    + `${cdiSupported.join(' or ')}. The core would start and answer health checks while `
    + 'failing every login. Use a core image new enough for that interface - '
    + 'supertokens/supertokens-postgresql:12 or later at the time of writing.',
  );
}

export function disableStockSignOut(originalImplementation) {
  return { ...originalImplementation, signOutPOST: undefined };
}

/**
 * Initialises SuperTokens if the mode calls for it.
 *
 * Returns true when SuperTokens is now active, false when the mode means it
 * should stay dormant. Idempotent: calling twice is a no-op rather than a
 * double-init error, because buildApp() is called per-test as well as once at
 * boot, and a second call throwing would make the app untestable.
 */
export async function initSuperTokens({ env = process.env, mode } = {}) {
  if (!isSuperTokensEnabled(mode)) return false;
  if (initialised) return true;

  const connectionURI = env.SUPERTOKENS_CONNECTION_URI;
  if (!connectionURI) {
    throw new Error(
      `AUTH_MODE='${mode}' requires SUPERTOKENS_CONNECTION_URI to be set `
      + '(the SuperTokens core, e.g. http://supertokens:3567). '
      + "Set AUTH_MODE=passport to run without SuperTokens.",
    );
  }

  const origin = resolvePublicOrigin(env);
  if (!origin) {
    throw new Error(
      `AUTH_MODE='${mode}' needs to know this server's public origin. `
      + 'Set PUBLIC_ORIGIN (e.g. https://rackstack.example.com), or configure '
      + 'GITHUB_CALLBACK_URL / DISCORD_CALLBACK_URL as you would for passport.',
    );
  }

  const providers = buildProviders(env);
  if (providers.length === 0) {
    throw new Error(
      `AUTH_MODE='${mode}' but no OAuth provider is configured. Set `
      + 'GITHUB_CLIENT_ID/SECRET and/or DISCORD_CLIENT_ID/SECRET - otherwise '
      + 'SuperTokens would start with no way for anyone to log in.',
    );
  }

  // Last gate before anything is loaded, and deliberately after the plain
  // configuration errors above - an operator with three things wrong should
  // hear about the missing origin before the security posture.
  //
  // A SuperTokens core with no API key serves its whole API unauthenticated,
  // and that API is the trust root: POST /recipe/session mints a session for
  // ANY userId, and the user-id mapping makes session.getUserId() return
  // `github:37058311` verbatim - so anyone who can reach the core can mint a
  // session for any SUPER_ADMIN_IDS value, which are deterministic and
  // effectively public. No request to the Express app is involved, so none of
  // the guards in this codebase apply to it.
  //
  // Enforced here rather than in docker-compose.yml because Compose
  // interpolates the whole file before filtering by profile: a required
  // variable there would break `docker compose up` for every deployment that
  // never enables SuperTokens. Here it fires only for operators who opted in.
  //
  // Loopback is exempt: such a core is reachable only from this host, which is
  // the normal shape for a local development run, and demanding a key there
  // would only teach people to set a dummy one.
  if (!env.SUPERTOKENS_API_KEY && !isLoopback(connectionURI)) {
    throw new Error(
      `AUTH_MODE='${mode}' requires SUPERTOKENS_API_KEY when the SuperTokens core is not on `
      + `loopback (got ${connectionURI}). An unauthenticated core lets anyone who can reach `
      + 'it mint a session for any user id, including every value in SUPER_ADMIN_IDS. '
      + 'Generate one with `openssl rand -hex 32`, set it as API_KEYS on the core and '
      + "SUPERTOKENS_API_KEY here, and do not publish the core's port to the network.",
    );
  }

  const [supertokens, Session, ThirdParty] = await Promise.all([
    import('supertokens-node').then((m) => m.default ?? m),
    import('supertokens-node/recipe/session').then((m) => m.default ?? m),
    import('supertokens-node/recipe/thirdparty').then((m) => m.default ?? m),
  ]);

  supertokens.init({
    supertokens: { connectionURI, apiKey: env.SUPERTOKENS_API_KEY || undefined },
    appInfo: {
      appName: 'RackStack',
      apiDomain: origin,
      websiteDomain: origin,
      apiBasePath: API_BASE_PATH,
      websiteBasePath: '/',
    },
    recipeList: [
      ThirdParty.init({
        // `signInAndUpFeature`, NOT `signInUpFeature`. The key is optional in
        // the SDK's TypeInput and there is no excess-property check at
        // runtime, so the wrong spelling is dropped in silence:
        // validateAndNormaliseSignInAndUpConfig reads only this key and falls
        // back to `providers: []`. The result is a SuperTokens stack that
        // initialises cleanly, passes every containment and config test, and
        // then answers every /auth/authorisationurl with
        // "the provider <id> could not be found in the configuration" - which
        // is what production did until v1.9. Note that buildProviders' own
        // "no OAuth provider is configured" guard above cannot catch it: the
        // list is non-empty, it just never reaches the recipe.
        signInAndUpFeature: { providers },
        override: {
          // The IDENTITY MAPPING override is on `functions` (the recipe
          // function), NOT `apis`. SuperTokens creates the session in the API
          // layer after the recipe function returns, so putting it in `apis`
          // would run too late to get the user id mapping in place first -
          // and a session carrying SuperTokens' internal id resolves to no
          // save at all. See ./mapping.js and design section 5.3.
          functions: buildSignInUpOverride({ supertokens }),
          // The `apis` override exists for a different reason entirely: to
          // close an authentication bypass in the stock signInUpPOST. See
          // rejectRawOAuthTokens below.
          apis: rejectRawOAuthTokens,
        },
      }),
      Session.init({ override: { apis: disableStockSignOut } }),
    ],
  });

  // The env check above proves only that WE hold a key, not that the core
  // demands one. Compose cannot diverge (both sides read the same variable),
  // but Unraid - the documented primary deployment - is two hand-configured
  // containers, and setting SUPERTOKENS_API_KEY on RackStack while leaving
  // API_KEYS blank on the core satisfies the guard while leaving the core
  // wide open to everyone else on the network. So ask the core directly.
  //
  // Fails closed only on a CONFIRMED-open core: an unreachable one is warned
  // about, not fatal, because the core legitimately may not be up yet during a
  // simultaneous container start, and refusing there would turn an ordering
  // hiccup into an outage.
  await assertCoreRejectsAnonymous({ connectionURI, hasKey: Boolean(env.SUPERTOKENS_API_KEY) });

  // Fail fast on a core too old (or too new) for this SDK. Without this the
  // mismatch only surfaces on the first login attempt, because the SDK checks
  // the version from inside a request - so the container would look healthy
  // right up until a player reported they could not sign in.
  await assertCoreSpeaksOurProtocol({ connectionURI, apiKey: env.SUPERTOKENS_API_KEY });

  initialised = true;
  // An operator who has just flipped AUTH_MODE needs to see that it took
  // effect, and needs to see it in the log rather than by inferring it from
  // the absence of an error. Names the mode, the core it will talk to, and
  // which providers came up - the three things that are wrong when a rollout
  // is not behaving.
  console.log(
    `[auth] SuperTokens initialised (AUTH_MODE=${mode}, core=${connectionURI}, `
    + `providers=${providers.map((p) => p.config.thirdPartyId).join(',')})`,
  );
  return true;
}

/**
 * Whether SuperTokens is live in this process.
 *
 * This, not AUTH_MODE, is what the auth chain in server/auth.js branches on.
 * The distinction matters: `requireAuth` is module-level middleware shared by
 * every route, while the mode is resolved per-`buildApp()` call, so reading the
 * mode there would mean guessing which app a request belongs to. Asking
 * "has init actually run?" is both simpler and strictly safer - if SuperTokens
 * is not initialised, calling into its SDK would throw, and that is exactly
 * the condition this answers.
 */
export function isSuperTokensReady() {
  return initialised;
}

/**
 * The Session recipe module, or null when SuperTokens is not initialised.
 *
 * Cached after the first load. The import stays dynamic for the same reason
 * every other one in this file does: in `passport` mode the SDK must never be
 * loaded, and `requireAuth` runs on every single request in every mode.
 */
let sessionRecipe = null;
export async function loadSessionRecipe() {
  if (!initialised) return null;
  if (!sessionRecipe) {
    const m = await import('supertokens-node/recipe/session');
    sessionRecipe = m.default ?? m;
  }
  return sessionRecipe;
}

/** Test-only: whether init has run in this process. */
export function __isInitialised() {
  return initialised;
}

/**
 * Test-only: forget that init ran.
 *
 * supertokens.init() keeps module-level state inside the SDK that cannot be
 * torn down, so this does NOT un-initialise SuperTokens - it only resets this
 * module's guard. Tests that need a genuinely clean SDK must run in their own
 * process (vitest isolates by file, which is enough).
 */
export function __resetForTests() {
  initialised = false;
  sessionRecipe = null;
}
