// The v1.8 identity mapping - the mechanism the whole release hinges on.
//
// SuperTokens mints its own opaque internal user id for every third-party
// login. RackStack's `users.id` is the literal string `provider:providerId`
// (e.g. `github:37058311`) and is the target of three foreign keys, every
// save row, and every value an operator has put in SUPER_ADMIN_IDS. Those two
// ids must be reconciled, and only in one direction: SuperTokens' id is
// mapped ONTO ours. `users.id` never changes.
//
// The reconciliation is `createUserIdMapping`, which lives in the SuperTokens
// CORE, not the SDK. Once a mapping exists, the core rewrites the user id in
// every response it sends - including the response to session creation. That
// is the entire reason ordering is load-bearing:
//
//     mapping created -> session created  =>  session.getUserId() === 'github:37058311'
//     session created -> mapping created  =>  session.getUserId() === '<st-uuid>'
//
// In the second case every route resolves a user id that matches no save, no
// role and no SUPER_ADMIN_IDS entry, so a returning player silently lands on a
// brand-new empty save. There is no error, no log line, and no way back for a
// player who then plays on that empty save.
//
// This is why the override belongs on the RECIPE FUNCTION (`signInUp`) and not
// on the API (`signInUpPOST`): SuperTokens creates the session in the API
// layer, AFTER the recipe function returns. Overriding the API function puts
// our code on the wrong side of the session. See design section 5.3, and
// tests/supertokens.mapping.test.js, which asserts the ordering directly
// rather than asserting the end state (the end state is identical either way).
//
// A second consequence of the same ordering: `createUserIdMapping` refuses to
// map a SuperTokens user that already has data associated with it unless
// `force: true` is passed. Running before session creation means there is no
// such data yet, so no force is needed - and no force SHOULD be used, because
// it would paper over exactly the mismatch this module throws on.

import {
  getIdentity as dbGetIdentity,
  upsertUser as dbUpsertUser,
  setSupertokensUserId as dbSetSupertokensUserId,
} from '../db/index.js';

/**
 * The default database dependency set. Injected rather than imported directly
 * at the call sites below so the mapping logic can be exercised against fakes
 * without standing up a driver, and - more importantly - so the ordering test
 * can instrument every call this module makes.
 */
const defaultDb = {
  getIdentity: dbGetIdentity,
  upsertUser: dbUpsertUser,
  setSupertokensUserId: dbSetSupertokensUserId,
};

/**
 * Best-effort display name for a brand-new player, mirroring what passport
 * stores today so a player who signs up through either stack gets the same
 * name.
 *
 * `passport-github2` uses the profile's `login`; `passport-discord` uses
 * `username`. Both are present in SuperTokens' `rawUserInfoFromProvider
 * .fromUserInfoAPI`, which is the provider's raw user JSON. The fallbacks
 * exist because `upsertUser` writes this into a NOT-cosmetic column and a
 * blank name would surface as an empty row in the admin list - never because
 * a name is expected to be missing.
 *
 * Only ever used for players who do not exist yet. A returning player's
 * username is untouched by this module (see resolveExternalUserId).
 */
export function deriveUsername({ thirdPartyId, thirdPartyUserId, rawUserInfoFromProvider = {}, email }) {
  const raw = rawUserInfoFromProvider.fromUserInfoAPI ?? {};
  const candidate = raw.login ?? raw.username ?? raw.global_name ?? raw.name;
  if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  if (typeof email === 'string' && email.includes('@')) return email.split('@')[0];
  return `${thirdPartyId}-${thirdPartyUserId}`;
}

/** Avatar URL from the provider's raw user JSON, or null. */
export function deriveAvatarUrl({ rawUserInfoFromProvider = {} }) {
  const raw = rawUserInfoFromProvider.fromUserInfoAPI ?? {};
  if (typeof raw.avatar_url === 'string' && raw.avatar_url) return raw.avatar_url;
  // Discord returns a bare avatar hash, and building the CDN URL from it needs
  // the user id too. Same shape passport-discord's profile carries.
  if (typeof raw.avatar === 'string' && raw.avatar && typeof raw.id === 'string') {
    return `https://cdn.discordapp.com/avatars/${raw.id}/${raw.avatar}.png`;
  }
  return null;
}

/**
 * Resolves the RackStack `users.id` for a third-party login, creating the
 * player only if they are genuinely new.
 *
 * The lookup is by `(thirdPartyId, thirdPartyUserId)`, which is exactly the
 * `(provider, provider_id)` pair `identities` is keyed on - that equality is
 * the reason an existing passport player is recognised rather than duplicated.
 *
 * An EXISTING identity resolves to its `user_id` and writes nothing. That is
 * deliberate: `upsertUser` would also refresh the username from the profile,
 * and if this module's `deriveUsername` ever disagreed with what passport
 * stored, every returning player would be silently renamed on their first
 * SuperTokens login. Read-only here is the migration-safe choice, and the only
 * thing given up is a `last_login_at` bump, which nothing currently reads.
 */
export async function resolveExternalUserId(input, db = defaultDb) {
  const { thirdPartyId, thirdPartyUserId } = input;
  if (!thirdPartyId || !thirdPartyUserId) {
    throw new Error(
      `SuperTokens signInUp supplied an incomplete identity (thirdPartyId=${thirdPartyId}, `
      + `thirdPartyUserId=${thirdPartyUserId}); refusing to map it to a user id.`,
    );
  }

  const identity = await db.getIdentity(thirdPartyId, thirdPartyUserId);
  if (identity) return { externalUserId: identity.user_id, created: false };

  const user = await db.upsertUser({
    provider: thirdPartyId,
    providerId: thirdPartyUserId,
    username: deriveUsername(input),
    avatarUrl: deriveAvatarUrl(input),
  });
  return { externalUserId: user.id, created: true };
}

/**
 * Registers the SuperTokens-internal user id against our `users.id` in the
 * core, and records the linkage on our side.
 *
 * Idempotent by construction, because it runs on EVERY login, not just the
 * first. The existing-mapping check comes first rather than treating
 * `createUserIdMapping`'s error statuses as the happy path, because on a
 * returning login the core has already translated the id and hands us back the
 * EXTERNAL one - at which point `createUserIdMapping` would report
 * `UNKNOWN_SUPERTOKENS_USER_ID_ERROR` for what is actually the fully-correct
 * steady state.
 *
 * A mapping that exists but points somewhere else is fatal and throws. That
 * means the core believes this login belongs to a different player than
 * `identities` does, and continuing would serve one player another player's
 * save - the precise outcome this release exists to prevent. Failing the login
 * is recoverable; serving the wrong save is not.
 */
export async function linkExternalUserId(
  { supertokensUserId, externalUserId, thirdPartyId, thirdPartyUserId },
  { db = defaultDb, supertokens },
) {
  const existing = await supertokens.getUserIdMapping({
    userId: supertokensUserId, userIdType: 'ANY',
  });

  if (existing.status === 'OK') {
    if (existing.externalUserId !== externalUserId) {
      throw new Error(
        `SuperTokens user id mapping conflict for ${thirdPartyId}:${thirdPartyUserId} - `
        + `the core maps it to '${existing.externalUserId}' but identities resolves it to `
        + `'${externalUserId}'. Refusing to issue a session rather than serve the wrong save.`,
      );
    }
  } else {
    const result = await supertokens.createUserIdMapping({
      superTokensUserId: supertokensUserId,
      externalUserId,
    });

    // Note the capital T in `superTokensUserId` above. The SDK reads exactly
    // that key; a `supertokensUserId` typo is accepted silently as `undefined`
    // and the mapping is simply never created - which fails as the invisible
    // wrong-save bug, not as an error.
    if (result.status !== 'OK') {
      if (result.status === 'USER_ID_MAPPING_ALREADY_EXISTS_ERROR') {
        // Lost a race with a concurrent login for the same player. Harmless if
        // and only if the mapping that won points where ours would have.
        const raced = await supertokens.getUserIdMapping({
          userId: supertokensUserId, userIdType: 'ANY',
        });
        if (raced.status === 'OK' && raced.externalUserId === externalUserId) {
          return externalUserId;
        }
      }
      throw new Error(
        `Failed to map SuperTokens user '${supertokensUserId}' onto '${externalUserId}' `
        + `for ${thirdPartyId}:${thirdPartyUserId} (status: ${result.status}). Refusing to `
        + 'issue a session that would resolve to the wrong save.',
      );
    }
  }

  // Our-side bookkeeping, deliberately last: the core-side mapping is what
  // governs the session, and this column only records that it happened.
  await db.setSupertokensUserId(thirdPartyId, thirdPartyUserId, supertokensUserId);
  return externalUserId;
}

/**
 * Pulls the SuperTokens user id out of a `signInUp` response.
 *
 * `recipeUserId` is a RecipeUserId wrapper, not a string. On a returning login
 * this is already the EXTERNAL id, because the core translates before
 * responding - `linkExternalUserId` handles that case rather than this one.
 */
export function readSupertokensUserId(response) {
  const fromRecipe = response?.recipeUserId?.getAsString?.();
  if (typeof fromRecipe === 'string' && fromRecipe) return fromRecipe;
  const fromUser = response?.user?.id;
  if (typeof fromUser === 'string' && fromUser) return fromUser;
  throw new Error('SuperTokens signInUp returned no usable user id; cannot create a user id mapping.');
}

/**
 * The ThirdParty recipe-function override.
 *
 * Everything below runs inside `signInUp`, i.e. strictly before SuperTokens'
 * API layer creates the session. Do not move it to `signInUpPOST`.
 */
export function buildSignInUpOverride({ db = defaultDb, supertokens } = {}) {
  return (originalImplementation) => ({
    ...originalImplementation,

    async signInUp(input) {
      const response = await originalImplementation.signInUp(input);
      // SIGN_IN_UP_NOT_ALLOWED / LINKING_TO_SESSION_USER_FAILED - nothing was
      // created, so there is nothing to map and no session will be issued.
      if (response.status !== 'OK') return response;

      const supertokensUserId = readSupertokensUserId(response);
      const { externalUserId } = await resolveExternalUserId(input, db);

      await linkExternalUserId({
        supertokensUserId,
        externalUserId,
        thirdPartyId: input.thirdPartyId,
        thirdPartyUserId: input.thirdPartyUserId,
      }, { db, supertokens });

      return response;
    },
  });
}
