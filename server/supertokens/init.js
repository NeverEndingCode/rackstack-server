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
// Recipes are ThirdParty and Session ONLY. The design (section 7) puts every
// other recipe out of scope, and that boundary is what keeps the nodemailer
// advisory in supertokens-node's dependency tree unreachable: nodemailer is
// referenced solely by the emailpassword / emailverification / passwordless /
// webauthn SMTP delivery services, none of which are ever constructed here.

import { isSuperTokensEnabled } from '../authMode.js';
import { buildProviders, resolvePublicOrigin } from './providers.js';
import { buildSignInUpOverride } from './mapping.js';

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
        signInUpFeature: { providers },
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
