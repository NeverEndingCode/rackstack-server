// The test the v1.8 release hinges on.
//
// What has to be true is not "a user id mapping exists once login finishes" -
// that is true whether the mapping was created before or after the session, and
// it is the wrong thing either way. What has to be true is that the mapping is
// created BEFORE the session, because the SuperTokens core rewrites user ids in
// its responses using the mapping, so a session created first carries
// SuperTokens' internal id forever and resolves to no save at all.
//
// So this file does not test against the real SDK's end state. It models the
// core's actual behaviour - a mapping table, and a session endpoint that
// translates through it at the moment it is called - and then asserts on the
// observed call order. The final test is a negative control: it wires the same
// mapping logic the WRONG way round (after session creation, as an `apis`
// override would) and proves that the assertions in this file fail for it. An
// ordering assertion that passes for both orderings is not an ordering
// assertion, and this file would be worthless without that control.

import {
  describe, it, expect, afterAll, beforeEach,
} from 'vitest';
import { randomUUID } from 'node:crypto';
import { provisionDatabase } from './helpers/backend.js';

// Provision before importing the facade - see tests/db.identities.test.js for
// why the import below must be dynamic.
const provisioned = await provisionDatabase();

const dbMod = await import('../server/db.js');
const {
  driver, upsertUser, getSave, putSave, getUserById, listIdentities, getIdentity,
} = dbMod;

const {
  buildSignInUpOverride, resolveExternalUserId, linkExternalUserId,
  deriveUsername, deriveAvatarUrl, readSupertokensUserId,
} = await import('../server/supertokens/mapping.js');

afterAll(async () => {
  if (driver.__backend === 'pg') await driver.__raw.end();
  await provisioned.cleanup();
});

/**
 * A stand-in for the SuperTokens core.
 *
 * The one behaviour that matters is modelled exactly: `createNewSession`
 * resolves the id it is handed THROUGH the mapping table, at call time. If no
 * mapping exists yet, the session keeps the internal id - which is precisely
 * the production failure mode, reproduced rather than described.
 */
function createFakeCore() {
  const mappings = new Map(); // supertokens id -> external id
  const knownUsers = new Set(); // supertokens ids the core has minted
  const calls = [];

  // The real core is a network hop. Every call below crosses a macrotask
  // boundary to model that, and it is load-bearing rather than decorative: an
  // instantly-resolving fake lets a fire-and-forget `linkExternalUserId(...)`
  // - a dropped `await`, one of the easiest bugs to introduce here - still win
  // the race against session creation, so the ordering assertions would pass
  // for code that is only accidentally correct and would fail in production
  // the moment the core took longer than zero milliseconds to answer. Verified
  // by mutation: with this tick in place, deleting the `await` in
  // buildSignInUpOverride fails the ordering test; without it, it does not.
  const hop = () => new Promise((resolve) => { setImmediate(resolve); });

  return {
    calls,
    mappings,
    registerUser(id) { knownUsers.add(id); },
    externalFor(id) { return mappings.get(id); },

    async createUserIdMapping({ superTokensUserId, externalUserId }) {
      await hop();
      calls.push({ op: 'createUserIdMapping', superTokensUserId, externalUserId });
      // Models the SDK reading the capital-T key: a `supertokensUserId` typo
      // arrives here as undefined rather than as an error.
      if (!superTokensUserId || !knownUsers.has(superTokensUserId)) {
        return { status: 'UNKNOWN_SUPERTOKENS_USER_ID_ERROR' };
      }
      if (mappings.has(superTokensUserId)) {
        return {
          status: 'USER_ID_MAPPING_ALREADY_EXISTS_ERROR',
          doesSuperTokensUserIdExist: true,
          doesExternalUserIdExist: true,
        };
      }
      mappings.set(superTokensUserId, externalUserId);
      return { status: 'OK' };
    },

    async getUserIdMapping({ userId }) {
      await hop();
      calls.push({ op: 'getUserIdMapping', userId });
      if (mappings.has(userId)) {
        return { status: 'OK', superTokensUserId: userId, externalUserId: mappings.get(userId) };
      }
      for (const [st, ext] of mappings) {
        if (ext === userId) return { status: 'OK', superTokensUserId: st, externalUserId: ext };
      }
      return { status: 'UNKNOWN_MAPPING_ERROR' };
    },

    // The core's session endpoint. Translation happens HERE, at call time -
    // which is what makes the ordering observable.
    async createNewSession(recipeUserId) {
      await hop();
      calls.push({ op: 'createNewSession', recipeUserId });
      const userId = mappings.get(recipeUserId) ?? recipeUserId;
      return { getUserId: () => userId };
    },
  };
}

/**
 * A stand-in for the built-in ThirdParty recipe implementation. Mints a stable
 * internal id per (provider, providerId), and - like the real core - reports
 * the EXTERNAL id back once a mapping exists, which is what makes the
 * returning-login path different from the first one.
 */
function createFakeRecipe(core) {
  const minted = new Map();
  return {
    async signInUp(input) {
      const key = `${input.thirdPartyId}|${input.thirdPartyUserId}`;
      let stId = minted.get(key);
      const createdNewRecipeUser = !stId;
      if (!stId) {
        stId = `st-${randomUUID()}`;
        minted.set(key, stId);
        core.registerUser(stId);
      }
      const visible = core.externalFor(stId) ?? stId;
      return {
        status: 'OK',
        createdNewRecipeUser,
        recipeUserId: { getAsString: () => visible },
        user: { id: visible },
      };
    },
  };
}

/**
 * Mimics SuperTokens' real API layer: call the (overridden) recipe function,
 * then create the session from what it returned. The override under test is
 * installed on the recipe function, so it runs strictly inside step one.
 */
function createHarness() {
  const core = createFakeCore();
  const original = createFakeRecipe(core);
  const overridden = buildSignInUpOverride({ supertokens: core })(original);

  async function signInUpPOST(input) {
    const response = await overridden.signInUp(input);
    const session = await core.createNewSession(response.recipeUserId.getAsString());
    return { response, session };
  }

  return { core, original, overridden, signInUpPOST };
}

function loginInput(thirdPartyId, thirdPartyUserId, extra = {}) {
  return {
    thirdPartyId,
    thirdPartyUserId,
    email: `${thirdPartyUserId}@example.com`,
    isVerified: true,
    oAuthTokens: {},
    rawUserInfoFromProvider: { fromUserInfoAPI: {} },
    tenantId: 'public',
    userContext: {},
    ...extra,
  };
}

const opsOf = (core) => core.calls.map((c) => c.op);

describe('supertokens identity mapping - ordering', () => {
  it('creates the user id mapping strictly before the session is created', async () => {
    const { core, signInUpPOST } = createHarness();
    await signInUpPOST(loginInput('github', 'order-1'));

    const ops = opsOf(core);
    const mappedAt = ops.indexOf('createUserIdMapping');
    const sessionAt = ops.indexOf('createNewSession');

    expect(mappedAt, 'no user id mapping was ever created').toBeGreaterThan(-1);
    expect(sessionAt, 'no session was ever created').toBeGreaterThan(-1);
    expect(mappedAt).toBeLessThan(sessionAt);
  });

  it('issues a session carrying our users.id, not SuperTokens internal id', async () => {
    // The consequence of the ordering, asserted on the value a route handler
    // would actually read.
    const { session } = await createHarness().signInUpPOST(loginInput('github', 'order-2'));
    expect(session.getUserId()).toBe('github:order-2');
    expect(session.getUserId()).not.toMatch(/^st-/);
  });

  it('NEGATIVE CONTROL: the same logic wired after session creation fails these assertions', async () => {
    // Proves the two assertions above have teeth. This wires the mapping the
    // way an `apis`/signInUpPOST override would - identical logic, identical
    // end state, one step too late - and shows both assertions catch it. If
    // this test ever starts passing the ordering assertions, they have gone
    // vacuous and the release's central guarantee is untested.
    const core = createFakeCore();
    const original = createFakeRecipe(core);

    const response = await original.signInUp(loginInput('github', 'order-3'));
    // Session FIRST - the mistake being modelled.
    const session = await core.createNewSession(response.recipeUserId.getAsString());
    // ...then exactly the same mapping work, afterwards.
    const supertokensUserId = readSupertokensUserId(response);
    const { externalUserId } = await resolveExternalUserId(loginInput('github', 'order-3'));
    await linkExternalUserId(
      {
        supertokensUserId, externalUserId, thirdPartyId: 'github', thirdPartyUserId: 'order-3',
      },
      { supertokens: core },
    );

    const ops = opsOf(core);
    expect(ops.indexOf('createUserIdMapping')).toBeGreaterThan(ops.indexOf('createNewSession'));

    // The mapping exists - an "is there a mapping at the end?" assertion would
    // pass right here, which is exactly why this file does not use one.
    expect(core.mappings.get(supertokensUserId)).toBe('github:order-3');

    // And yet the session is wrong, permanently.
    expect(session.getUserId()).toBe(supertokensUserId);
    expect(session.getUserId()).not.toBe('github:order-3');
  });
});

describe('supertokens identity mapping - identity outcomes', () => {
  it('resolves an existing passport player to their existing save', async () => {
    // The whole point of the release. Asserted on save CONTENTS, not just on
    // the id matching, because a matching id with an empty save would be the
    // same disaster wearing a disguise.
    await upsertUser({
      provider: 'github', providerId: 'veteran', username: 'veteran', avatarUrl: null,
    });
    await putSave('github:veteran', { wafers: 9001, marker: 'pre-existing' }, 1234);

    const { session } = await createHarness().signInUpPOST(loginInput('github', 'veteran'));

    expect(session.getUserId()).toBe('github:veteran');
    const save = await getSave(session.getUserId());
    expect(JSON.parse(save.data)).toEqual({ wafers: 9001, marker: 'pre-existing' });
    // No second account was conjured alongside the real one.
    expect(await listIdentities('github:veteran')).toHaveLength(1);
  });

  it('does not create a new user row for an existing player', async () => {
    await upsertUser({
      provider: 'discord', providerId: 'existing-1', username: 'exist1', avatarUrl: null,
    });
    const before = await getUserById('discord:existing-1');

    await createHarness().signInUpPOST(loginInput('discord', 'existing-1', {
      rawUserInfoFromProvider: { fromUserInfoAPI: { username: 'a-totally-different-name' } },
    }));

    const after = await getUserById('discord:existing-1');
    expect(after.id).toBe(before.id);
    expect(after.created_at).toBe(before.created_at);
    // A returning player is never renamed from the SuperTokens-side profile -
    // resolveExternalUserId writes nothing at all on this path.
    expect(after.username).toBe('exist1');
  });

  it('creates user, identity and mapping for a brand-new player', async () => {
    const { core, session } = await (async () => {
      const h = createHarness();
      const r = await h.signInUpPOST(loginInput('github', 'fresh-1', {
        rawUserInfoFromProvider: { fromUserInfoAPI: { login: 'freshuser', avatar_url: 'https://x/y.png' } },
      }));
      return { core: h.core, ...r };
    })();

    expect(session.getUserId()).toBe('github:fresh-1');
    const user = await getUserById('github:fresh-1');
    expect(user).toBeDefined();
    expect(user.username).toBe('freshuser');
    expect(user.avatar_url).toBe('https://x/y.png');

    const identity = await getIdentity('github', 'fresh-1');
    expect(identity.user_id).toBe('github:fresh-1');
    // The mapping the core holds points at OUR id, in that direction only.
    expect([...core.mappings.values()]).toContain('github:fresh-1');
    expect(identity.supertokens_user_id).toBe([...core.mappings.keys()][0]);
  });

  it('is idempotent across repeated logins - no duplicate identity, no unique violation', async () => {
    const h = createHarness();
    await h.signInUpPOST(loginInput('github', 'repeat-1'));
    await h.signInUpPOST(loginInput('github', 'repeat-1'));
    const third = await h.signInUpPOST(loginInput('github', 'repeat-1'));

    expect(third.session.getUserId()).toBe('github:repeat-1');
    expect(await listIdentities('github:repeat-1')).toHaveLength(1);
    // Exactly one mapping was ever created; the later logins recognised the
    // steady state instead of trying to re-create it.
    const created = h.core.calls.filter((c) => c.op === 'createUserIdMapping');
    expect(created).toHaveLength(1);
  });

  it('refuses to issue a session when the core maps this login to a different player', async () => {
    // The one case where failing the login is the correct outcome: the core
    // and identities disagree about who this is, and guessing means serving
    // someone else's save.
    const h = createHarness();
    await h.signInUpPOST(loginInput('github', 'conflict-1'));
    const stId = [...h.core.mappings.keys()].find((k) => h.core.mappings.get(k) === 'github:conflict-1');

    // Corrupt the core's view: it now believes this login is somebody else.
    h.core.mappings.set(stId, 'github:someone-else');

    await expect(h.signInUpPOST(loginInput('github', 'conflict-1'))).rejects.toThrow(/mapping conflict/i);
  });

  it('propagates a non-OK signInUp untouched, mapping nothing', async () => {
    const core = createFakeCore();
    const original = {
      async signInUp() { return { status: 'SIGN_IN_UP_NOT_ALLOWED', reason: 'nope' }; },
    };
    const overridden = buildSignInUpOverride({ supertokens: core })(original);

    const res = await overridden.signInUp(loginInput('github', 'denied-1'));
    expect(res.status).toBe('SIGN_IN_UP_NOT_ALLOWED');
    expect(core.calls).toHaveLength(0);
    expect(await getUserById('github:denied-1')).toBeUndefined();
  });

  it('refuses an incomplete identity rather than inventing a user id', async () => {
    await expect(resolveExternalUserId({ thirdPartyId: 'github', thirdPartyUserId: '' }))
      .rejects.toThrow(/incomplete identity/i);
  });
});

describe('supertokens profile derivation', () => {
  beforeEach(() => {});

  it('uses github login and discord username, matching what passport stores', () => {
    expect(deriveUsername(loginInput('github', '1', {
      rawUserInfoFromProvider: { fromUserInfoAPI: { login: 'octocat' } },
    }))).toBe('octocat');

    expect(deriveUsername(loginInput('discord', '2', {
      rawUserInfoFromProvider: { fromUserInfoAPI: { username: 'discorduser' } },
    }))).toBe('discorduser');
  });

  it('falls back through email local-part to a provider-qualified id', () => {
    expect(deriveUsername({
      thirdPartyId: 'github', thirdPartyUserId: '3', email: 'someone@example.com', rawUserInfoFromProvider: {},
    })).toBe('someone');

    expect(deriveUsername({
      thirdPartyId: 'github', thirdPartyUserId: '4', rawUserInfoFromProvider: {},
    })).toBe('github-4');
  });

  it('builds the discord CDN url from a bare avatar hash', () => {
    expect(deriveAvatarUrl({
      rawUserInfoFromProvider: { fromUserInfoAPI: { id: '123', avatar: 'abc' } },
    })).toBe('https://cdn.discordapp.com/avatars/123/abc.png');

    expect(deriveAvatarUrl({ rawUserInfoFromProvider: { fromUserInfoAPI: {} } })).toBeNull();
  });
});
