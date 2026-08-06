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
        // The override is on `functions` (the recipe function), NOT `apis`.
        // SuperTokens creates the session in the API layer after the recipe
        // function returns, so an `apis` override would run too late to get
        // the user id mapping in place first - and a session carrying
        // SuperTokens' internal id resolves to no save at all. See
        // ./mapping.js and design section 5.3.
        override: { functions: buildSignInUpOverride({ supertokens }) },
      }),
      Session.init(),
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
