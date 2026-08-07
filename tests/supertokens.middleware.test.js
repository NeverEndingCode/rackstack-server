// The authentication chain across all three AUTH_MODE values.
//
// The guarantee users would actually notice is the one this file spends most
// of its assertions on: a legacy JWT cookie issued BEFORE the switch keeps
// working in `dual` AND in `supertokens` mode. That is the no-forced-logout
// promise and the thing that makes the documented rollback real - a mode flip
// in either direction must never invalidate a cookie that has up to 90 days
// left on it.
//
// SuperTokens is initialised for real here (supertokens.init() is offline - it
// stores config and contacts nothing), so the chain under test is the real
// one. Only the single `Session.getSession` call is stubbed, and only for the
// tests that need a session to exist; everything else exercises the genuine
// "no SuperTokens session present" path, which is exactly what a mid-rollout
// request from an existing player looks like.

process.env.JWT_SECRET = 'test-secret-for-middleware';
process.env.SUPER_ADMIN_IDS = '';

// configurePassport() reads process.env directly rather than buildApp's `env`
// override, so the OAuth credentials have to live here for the passport
// strategies to register at all. Without them `passport.authenticate('github')`
// throws "Unknown authentication strategy" and the route 500s - which would
// make the "not registered in supertokens mode" test below pass for entirely
// the wrong reason.
process.env.GITHUB_CLIENT_ID = 'gh-id';
process.env.GITHUB_CLIENT_SECRET = 'gh-secret';
process.env.GITHUB_CALLBACK_URL = 'https://rackstack.example.com/auth/github/callback';
process.env.DISCORD_CLIENT_ID = 'dc-id';
process.env.DISCORD_CLIENT_SECRET = 'dc-secret';
process.env.DISCORD_CALLBACK_URL = 'https://rackstack.example.com/auth/discord/callback';

import {
  describe, it, expect, afterAll, beforeAll, vi,
} from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { provisionDatabase } from './helpers/backend.js';

const provisioned = await provisionDatabase();

const { buildApp } = await import('../server/app.js');
const { ensureConfig } = await import('../server/configService.js');
const { upsertUser, putSave, driver } = await import('../server/db.js');
const { COOKIE_NAME } = await import('../server/auth.js');
const { loadSessionRecipe, isSuperTokensReady } = await import('../server/supertokens/init.js');

await ensureConfig();

// A complete SuperTokens configuration. The connection URI is never dialled:
// init() is offline, and getSession with no session tokens on the request
// short-circuits before any network call.
const ST_ENV = {
  ...process.env,
  SUPERTOKENS_CONNECTION_URI: 'http://supertokens.invalid:3567',
  // Required for a non-loopback core - an unauthenticated one lets anyone who
  // can reach it mint a session for any user id, SUPER_ADMIN_IDS included.
  SUPERTOKENS_API_KEY: 'test-core-api-key',
  PUBLIC_ORIGIN: 'https://rackstack.example.com',
};

const apps = {};
let player;

beforeAll(async () => {
  player = await upsertUser({
    provider: 'github', providerId: 'chain-1', username: 'chainuser', avatarUrl: null,
  });
  await putSave(player.id, { wafers: 77, marker: 'chain' }, 1);

  // Built passport-first so the passport app is constructed before any
  // SuperTokens state exists in this process - the closest a single process
  // can get to "what a passport-only deployment builds".
  apps.passport = await buildApp({ env: { ...process.env, AUTH_MODE: 'passport' } });
  apps.dual = await buildApp({ env: { ...ST_ENV, AUTH_MODE: 'dual' } });
  apps.supertokens = await buildApp({ env: { ...ST_ENV, AUTH_MODE: 'supertokens' } });
});

afterAll(async () => {
  if (driver.__backend === 'pg') await driver.__raw.end();
  await provisioned.cleanup();
});

function legacyCookie(user) {
  const token = jwt.sign(
    { sub: user.id, username: user.username, avatarUrl: user.avatar_url },
    process.env.JWT_SECRET,
    { expiresIn: '90d' },
  );
  return `${COOKIE_NAME}=${token}`;
}

const MODES = ['passport', 'dual', 'supertokens'];

describe('the auth chain in every mode', () => {
  it.each(MODES)('%s: a legacy JWT cookie authenticates and resolves the right save', async (mode) => {
    // In `dual` and `supertokens` this is the no-forced-logout guarantee: a
    // cookie issued before the switch still works afterwards. Asserted on the
    // save, not just on a 200, because a 200 for the WRONG user is the
    // failure this release exists to prevent.
    const res = await request(apps[mode]).get('/api/me').set('Cookie', legacyCookie(player));
    expect(res.status).toBe(200);
    expect(res.body.id ?? res.body.sub).toBe('github:chain-1');

    const state = await request(apps[mode]).get('/api/state').set('Cookie', legacyCookie(player));
    expect(state.status).toBe(200);
  });

  it.each(MODES)('%s: an unauthenticated request gets 401, not 500', async (mode) => {
    const res = await request(apps[mode]).get('/api/me');
    expect(res.status).toBe(401);
  });

  it.each(MODES)('%s: a garbage cookie gets 401, not 500', async (mode) => {
    const res = await request(apps[mode]).get('/api/me').set('Cookie', `${COOKIE_NAME}=not-a-jwt`);
    expect(res.status).toBe(401);
  });

  it.each(MODES)('%s: a cookie signed with the wrong secret is rejected', async (mode) => {
    const forged = jwt.sign({ sub: player.id, username: 'x' }, 'wrong-secret', { expiresIn: '90d' });
    const res = await request(apps[mode]).get('/api/me').set('Cookie', `${COOKIE_NAME}=${forged}`);
    expect(res.status).toBe(401);
  });
});

describe('passport route gating', () => {
  it.each(['passport', 'dual'])('%s: the passport OAuth routes are registered', async (mode) => {
    // 302 to the provider is what passport.authenticate does on success.
    const gh = await request(apps[mode]).get('/auth/github');
    expect(gh.status).toBe(302);
    expect(gh.headers.location).toContain('github.com');

    const dc = await request(apps[mode]).get('/auth/discord');
    expect(dc.status).toBe(302);
    expect(dc.headers.location).toContain('discord.com');
  });

  it('supertokens: the passport OAuth routes are not registered at all', async () => {
    // Not registered, not merely failing - the request must fall through to
    // the SPA fallback rather than reach passport. A route that exists and
    // errors would still send a player to a broken GitHub redirect.
    for (const path of ['/auth/github', '/auth/discord']) {
      const res = await request(apps.supertokens).get(path);
      expect(res.status, `${path} should not redirect to a provider`).not.toBe(302);
    }
  });

  it.each(MODES)('%s: logout is available and clears the legacy cookie', async (mode) => {
    // Registered in every mode. In `supertokens` mode especially: a player can
    // still be carrying a pre-cutover cookie, and that cookie is exactly what
    // the chain's fallback branch would otherwise keep accepting.
    const res = await request(apps[mode]).post('/auth/logout').set('Cookie', legacyCookie(player));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const cleared = (res.headers['set-cookie'] ?? []).join(';');
    expect(cleared).toContain(COOKIE_NAME);
  });
});

describe('the SuperTokens middleware is actually mounted', () => {
  // Mutation-found gap: deleting `middleware()` or `errorHandler()` from
  // app.js passed the ENTIRE suite. The only related assertion was one-sided -
  // passport mode must NOT have them - with no positive counterpart, and no
  // test anywhere issued a request against a SuperTokens endpoint. Meanwhile
  // the runbook and authentication-methods.md both assert "the server side is
  // complete, the middleware serves /auth/authorisationurl and
  // /auth/signinup". Since the client never calls those, a broken mount would
  // also be invisible in production.

  it('adds exactly two layers over passport mode - the middleware and the error handler', () => {
    // Counted, not matched by name: both are anonymous functions on the stack,
    // so the pre-existing `expect(layerNames).not.toContain('middleware')`
    // assertion in supertokens.init.test.js could never have failed - it was
    // vacuous in the strongest sense. The delta is what pins errorHandler
    // specifically, since the behavioural assertions below only exercise the
    // middleware.
    expect(apps.dual._router.stack.length).toBe(apps.passport._router.stack.length + 2);
  });

  it('serves /auth/authorisationurl as JSON in dual mode - the endpoint the docs promise', async () => {
    // Content-type is the signal, not the status. Offline (no core reachable)
    // this answers 400 rather than 200, but a JSON body at all proves
    // SuperTokens handled the request; an unmounted middleware falls through
    // to the SPA, which answers 200 text/html - a status check alone would
    // therefore have read the BROKEN case as healthier than the working one.
    const res = await request(apps.dual).get('/auth/authorisationurl?thirdPartyId=github');
    expect(res.headers['content-type'] ?? '').toContain('application/json');
  });

  it('serves the Session recipe endpoints in dual mode', async () => {
    // A second, independent endpoint from a different recipe, so the mount is
    // not proven by ThirdParty alone.
    const res = await request(apps.dual).post('/auth/session/refresh');
    expect(res.headers['content-type'] ?? '').toContain('application/json');
    expect(res.status).toBe(401);
  });

  it('serves neither in passport mode', async () => {
    // Containment: both must fall through to the SPA or 404, never JSON.
    const auth = await request(apps.passport).get('/auth/authorisationurl?thirdPartyId=github');
    expect(auth.headers['content-type'] ?? '').not.toContain('application/json');

    const refresh = await request(apps.passport).post('/auth/session/refresh');
    expect(refresh.headers['content-type'] ?? '').not.toContain('application/json');
  });

  it('removes the stock POST /auth/signout, which would half-log-out a dual-stack user', async () => {
    // The Session recipe registers /auth/signout automatically. It revokes the
    // SuperTokens session and leaves the legacy JWT cookie, so requireAuth's
    // fallback re-authenticates the "logged out" user on the next request -
    // exactly the half-logout authRoutes.js exists to prevent, and the default
    // path the SuperTokens frontend SDK's signOut() would have used.
    const res = await request(apps.dual)
      .post('/auth/signout')
      .set('Cookie', legacyCookie(player));

    expect(res.status).toBe(404);

    // And the cookie is untouched by it, which is why leaving it registered
    // would have been unsafe.
    const stillWorks = await request(apps.dual).get('/api/me').set('Cookie', legacyCookie(player));
    expect(stillWorks.status).toBe(200);
  });
});

describe('the SuperTokens HTTP surface is an allowlist', () => {
  // supertokens.init() auto-adds multitenancy, usermetadata, oauth2provider,
  // openid, jwt and accountlinking whatever `recipeList` says - 13 extra live
  // endpoints. Disabling them one at a time is whack-a-mole against a
  // dependency that adds endpoints on its own schedule, so app.js gates the
  // middleware behind an allowlist. These tests are what stop that allowlist
  // silently widening again.

  it('does not expose POST /auth/oauth/logout - a second half-logout', async () => {
    // The one that matters most: oauth2provider revokes the session BEFORE
    // validating the logout challenge, so an authenticated call with any value
    // kills the SuperTokens session and leaves the legacy cookie - and
    // requireAuth then re-authenticates the "logged out" user. Exactly the bug
    // disableStockSignOut closes, reached by another door.
    const res = await request(apps.dual)
      .post('/auth/oauth/logout')
      .set('Cookie', legacyCookie(player))
      .send({ logoutChallenge: 'anything' });

    // 404, NOT merely "not JSON". Ungated, this request genuinely reaches
    // oauth2provider's logoutPOST and dies in the querier with "No SuperTokens
    // core available" - a 500, which is also not JSON. A content-type check
    // therefore passes whether the endpoint is blocked or reached-and-broken,
    // and was vacuous here until a mutation run exposed it. 404 means nothing
    // handled the request at all: the gate called next(), and the SPA fallback
    // is GET-only so a POST falls off the end of the stack. SuperTokens never
    // saw it.
    expect(res.status).toBe(404);

    // And the legacy cookie still authenticates, i.e. nothing was half-revoked.
    const after = await request(apps.dual).get('/api/me').set('Cookie', legacyCookie(player));
    expect(after.status).toBe(200);
  });

  it('does not advertise RackStack as an OAuth2 authorization server', async () => {
    const res = await request(apps.dual).get('/auth/.well-known/openid-configuration');
    expect(res.headers['content-type'] ?? '').not.toContain('application/json');
  });

  it('blocks the rest of the auto-added recipe surface', async () => {
    // A representative sweep rather than an exhaustive one - the allowlist is
    // the guarantee; this checks it is actually in force.
    const blocked = [
      ['get', '/auth/jwt/jwks.json'],
      ['get', '/auth/oauth/auth'],
      ['post', '/auth/oauth/token'],
      ['get', '/auth/oauth/userinfo'],
      ['post', '/auth/user/metadata'],
      ['get', '/auth/loginmethods'],
    ];
    for (const [method, path] of blocked) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(apps.dual)[method](path);
      expect(
        res.headers['content-type'] ?? '',
        `${method.toUpperCase()} ${path} was served by SuperTokens`,
      ).not.toContain('application/json');
    }
  });

  it('still serves the endpoints we do use', async () => {
    // The allowlist must not have closed the door on ourselves.
    const authUrl = await request(apps.dual).get('/auth/authorisationurl?thirdPartyId=github');
    expect(authUrl.headers['content-type'] ?? '').toContain('application/json');

    const refresh = await request(apps.dual).post('/auth/session/refresh');
    expect(refresh.headers['content-type'] ?? '').toContain('application/json');
  });

  it('leaves our own passport routes reachable through the gate', async () => {
    // The gate calls next() rather than responding, so /auth/* paths it does
    // not own must still reach authRoutes.js.
    const gh = await request(apps.dual).get('/auth/github');
    expect(gh.status).toBe(302);

    const logout = await request(apps.dual).post('/auth/logout');
    expect(logout.status).toBe(200);
  });
});

describe('logout revokes both stacks', () => {
  it('revokes the SuperTokens session, not just the legacy cookie', async () => {
    // Mutation-found gap: wrapping the revocation in `if (false)` passed
    // everything. The plan's Task 4 Step 2 is explicit that logout must clear
    // BOTH, and the unverified half was the security-relevant one - a logout
    // that leaves a live session is worse than one that fails loudly.
    const Session = await loadSessionRecipe();
    let revoked = false;
    const spy = vi.spyOn(Session, 'getSession').mockResolvedValue({
      getUserId: () => 'github:chain-1',
      revokeSession: async () => { revoked = true; },
    });

    try {
      const res = await request(apps.dual).post('/auth/logout').set('Cookie', legacyCookie(player));
      expect(res.status).toBe(200);
      expect(revoked, 'logout did not revoke the SuperTokens session').toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('still clears the legacy cookie when revocation throws', async () => {
    // Best-effort by design: a SuperTokens session that cannot even be read is
    // not one this request can revoke, and failing the whole logout would
    // leave the user MORE logged in than reporting success does.
    const Session = await loadSessionRecipe();
    const spy = vi.spyOn(Session, 'getSession').mockRejectedValue(new Error('core unreachable'));

    try {
      const res = await request(apps.dual).post('/auth/logout').set('Cookie', legacyCookie(player));
      expect(res.status).toBe(200);
      expect((res.headers['set-cookie'] ?? []).join(';')).toContain(COOKIE_NAME);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the SuperTokens branch of the chain', () => {
  it('is live once SuperTokens is initialised', () => {
    // Guards every stub below: if init had silently not happened, the stubs
    // would never be consulted and the tests would pass by testing the JWT
    // path twice.
    expect(isSuperTokensReady()).toBe(true);
  });

  it('authenticates from a SuperTokens session, with users.id as the subject', async () => {
    const Session = await loadSessionRecipe();
    const spy = vi.spyOn(Session, 'getSession').mockResolvedValue({
      // The mapping created in Task 3 is what makes this our id rather than
      // SuperTokens' internal one.
      getUserId: () => 'github:chain-1',
    });

    try {
      // No cookie at all - the only thing authenticating this request is the
      // SuperTokens session.
      const res = await request(apps.dual).get('/api/me');
      expect(res.status).toBe(200);
      expect(res.body.id ?? res.body.sub).toBe('github:chain-1');
      expect(res.body.username).toBe('chainuser');
    } finally {
      spy.mockRestore();
    }
  });

  it('falls through to the JWT cookie when the SuperTokens session throws', async () => {
    // THE mid-rollout failure mode. A user in `dual` mode carrying a stale or
    // malformed SuperTokens session plus a good legacy cookie must be logged
    // in by the cookie, not 500'd by the session. Getting this wrong takes
    // down logins for everyone mid-migration.
    const Session = await loadSessionRecipe();
    const spy = vi.spyOn(Session, 'getSession').mockRejectedValue(new Error('TRY_REFRESH_TOKEN'));

    try {
      const res = await request(apps.dual).get('/api/me').set('Cookie', legacyCookie(player));
      expect(res.status).toBe(200);
      expect(res.body.id ?? res.body.sub).toBe('github:chain-1');
    } finally {
      spy.mockRestore();
    }
  });

  it('401s rather than 500s when the SuperTokens session throws and there is no cookie', async () => {
    const Session = await loadSessionRecipe();
    const spy = vi.spyOn(Session, 'getSession').mockRejectedValue(new Error('TRY_REFRESH_TOKEN'));

    try {
      const res = await request(apps.dual).get('/api/me');
      expect(res.status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a session whose subject matches no user row', async () => {
    // Would mean the id mapping resolved to something `users` has never heard
    // of. Treating that as authenticated would hand a request context a `sub`
    // matching no save, no role and no SUPER_ADMIN_IDS entry - the silent
    // empty-save outcome. It must not fall back into a half-valid session.
    const Session = await loadSessionRecipe();
    const spy = vi.spyOn(Session, 'getSession').mockResolvedValue({
      getUserId: () => 'github:does-not-exist',
    });

    try {
      const res = await request(apps.dual).get('/api/me');
      expect(res.status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  it('prefers the SuperTokens session over a legacy cookie for a different user', async () => {
    // Pins the chain's ORDER. If the branches were swapped, a user holding
    // both would resolve to the cookie's subject instead - which during a
    // cutover means their session silently reverts to whoever the old cookie
    // was for.
    const other = await upsertUser({
      provider: 'github', providerId: 'chain-2', username: 'otheruser', avatarUrl: null,
    });
    const Session = await loadSessionRecipe();
    const spy = vi.spyOn(Session, 'getSession').mockResolvedValue({
      getUserId: () => 'github:chain-1',
    });

    try {
      const res = await request(apps.dual).get('/api/me').set('Cookie', legacyCookie(other));
      expect(res.status).toBe(200);
      expect(res.body.id ?? res.body.sub).toBe('github:chain-1');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('requireRole across both stacks', () => {
  it('derives roles from req.user.sub regardless of which stack authenticated', async () => {
    // requireRole reads req.user.sub and goes to the database and env on every
    // request - it never trusts a cached role. Since both branches of the
    // chain populate the identical `sub`, it needs no change in v1.8, and this
    // asserts that rather than leaving it as a claim in a comment.
    const { setRoles } = await import('../server/db.js');
    await setRoles('github:chain-1', ['admin']);

    const viaCookie = await request(apps.dual).get('/api/admin/config').set('Cookie', legacyCookie(player));
    expect(viaCookie.status).toBe(200);

    const Session = await loadSessionRecipe();
    const spy = vi.spyOn(Session, 'getSession').mockResolvedValue({
      getUserId: () => 'github:chain-1',
    });
    try {
      const viaSession = await request(apps.dual).get('/api/admin/config');
      expect(viaSession.status).toBe(200);
    } finally {
      spy.mockRestore();
    }

    await setRoles('github:chain-1', []);
  });

  it('403s a non-admin through either stack', async () => {
    const Session = await loadSessionRecipe();
    const spy = vi.spyOn(Session, 'getSession').mockResolvedValue({
      getUserId: () => 'github:chain-2',
    });
    try {
      const viaSession = await request(apps.dual).get('/api/admin/config');
      expect(viaSession.status).toBe(403);
    } finally {
      spy.mockRestore();
    }
  });
});
