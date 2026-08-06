// SuperTokens ThirdParty provider configuration, built from the SAME
// environment variables passport already uses.
//
// Reusing the credentials is deliberate: during the `dual` rollout both
// stacks talk to the same GitHub and Discord OAuth apps, and an operator
// juggling two sets of client secrets for one provider is an outage waiting
// to happen. The only thing that differs between the stacks is the redirect
// path, which is why the runbook's Part A widens the registered callback
// rather than replacing it.
//
// The `thirdPartyId` values below are load-bearing. They must equal the
// `provider` values already stored in the `identities` table ('github',
// 'discord'), because the signInUp override looks identities up by
// (provider, provider_id) to resolve an existing player's users.id. A
// mismatch here means every existing player is treated as brand new and
// lands on an empty save - the exact failure the rollout exists to avoid.

/**
 * Whether the id SuperTokens computes for a provider is the same string
 * passport stored as `provider_id`. Verified against both SDKs at the
 * versions pinned in package.json:
 *
 *   github  - supertokens-node's built-in provider sets
 *             thirdPartyUserId = `${user.id}` (stringified numeric id);
 *             passport-github2 sets profile.id = String(json.id).
 *             Same source field, same stringification.
 *   discord - supertokens-node maps userInfoMap.fromUserInfoAPI.userId
 *             to 'id' (the snowflake, already a string); passport-discord
 *             passes Discord's raw user JSON through, so profile.id is that
 *             same 'id'.
 *
 * This is strong evidence, not proof: what ultimately matters is the values
 * actually sitting in the owner's `identities` rows, which may predate
 * either library version. Shadow mode (Task 5) is what closes that gap, and
 * cutover stays gated on it.
 */
export const PROVIDER_IDS = Object.freeze(['github', 'discord']);

/**
 * Builds the ProviderInput list for ThirdParty.init from `env`.
 *
 * A provider with no credentials is omitted rather than half-configured,
 * mirroring configurePassport()'s behaviour exactly - an operator who runs
 * Discord-only today must not suddenly be required to supply GitHub
 * credentials to enable SuperTokens.
 */
export function buildProviders(env = process.env) {
  const providers = [];

  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.push({
      config: {
        thirdPartyId: 'github',
        clients: [{
          clientId: env.GITHUB_CLIENT_ID,
          clientSecret: env.GITHUB_CLIENT_SECRET,
        }],
      },
    });
  }

  if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    providers.push({
      config: {
        thirdPartyId: 'discord',
        clients: [{
          clientId: env.DISCORD_CLIENT_ID,
          clientSecret: env.DISCORD_CLIENT_SECRET,
          // 'identify' alone matches what passport-discord requests today.
          // SuperTokens' built-in Discord provider defaults to also asking
          // for 'email'; requesting a scope the existing OAuth app's users
          // have not consented to would re-prompt every returning player for
          // new permissions mid-rollout, which looks exactly like a phishing
          // attempt and would tank trust in the migration.
          scope: ['identify'],
        }],
      },
    });
  }

  return providers;
}

/**
 * The origin SuperTokens needs for apiDomain/websiteDomain.
 *
 * Derived from the callback URLs the operator has already configured rather
 * than demanding a new variable, because those are mandatory today and are
 * guaranteed to carry the public origin. An explicit PUBLIC_ORIGIN wins when
 * set, for deployments behind a proxy where the two legitimately differ.
 *
 * Returns undefined when nothing is configured - the caller decides whether
 * that is fatal, which depends on the auth mode.
 */
export function resolvePublicOrigin(env = process.env) {
  if (env.PUBLIC_ORIGIN) return stripTrailingSlash(env.PUBLIC_ORIGIN);

  for (const key of ['GITHUB_CALLBACK_URL', 'DISCORD_CALLBACK_URL']) {
    const raw = env[key];
    if (!raw) continue;
    try {
      return new URL(raw).origin;
    } catch {
      // A malformed callback URL is the operator's problem to fix, but it
      // must not take out origin resolution when the other provider's URL is
      // perfectly good.
    }
  }
  return undefined;
}

function stripTrailingSlash(s) {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
