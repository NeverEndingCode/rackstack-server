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
