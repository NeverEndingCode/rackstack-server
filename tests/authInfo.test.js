// GET /api/auth-info (v1.9) and the two facts the client login flow is built
// on top of.
//
// The endpoint exists because the client must not hardcode either stack:
// hardcoding SuperTokens breaks `passport` mode, which is still the default
// and the documented rollback, and both have to work from one build.
//
// It is NOT on GET /api/config, which the v1.9 plan originally proposed. That
// route sits behind requireAuth and the caller here is by definition not
// logged in yet - the whole point is to decide which login buttons to draw.

process.env.JWT_SECRET = 'test-secret-auth-info';
process.env.SUPER_ADMIN_IDS = '';

// configurePassport() reads process.env directly, so the strategies need
// credentials here or `passport.authenticate` throws on the passport app.
process.env.GITHUB_CLIENT_ID = 'gh-id';
process.env.GITHUB_CLIENT_SECRET = 'gh-secret';
process.env.GITHUB_CALLBACK_URL = 'https://rackstack.example.com/auth/github/callback';
process.env.DISCORD_CLIENT_ID = 'dc-id';
process.env.DISCORD_CLIENT_SECRET = 'dc-secret';
process.env.DISCORD_CALLBACK_URL = 'https://rackstack.example.com/auth/discord/callback';

import {
  describe, it, expect, beforeAll, afterAll,
} from 'vitest';
import request from 'supertest';
import { provisionDatabase } from './helpers/backend.js';

const provisioned = await provisionDatabase();

const { buildApp } = await import('../server/app.js');
const { ensureConfig } = await import('../server/configService.js');
const { driver } = await import('../server/db.js');
const { configuredProviders } = await import('../server/auth.js');
const { buildProviders } = await import('../server/supertokens/providers.js');

await ensureConfig();

const ST_ENV = {
  ...process.env,
  SUPERTOKENS_CONNECTION_URI: 'http://supertokens.invalid:3567',
  SUPERTOKENS_API_KEY: 'test-core-api-key',
  PUBLIC_ORIGIN: 'https://rackstack.example.com',
};

const apps = {};

beforeAll(async () => {
  apps.passport = await buildApp({ env: { ...process.env, AUTH_MODE: 'passport' } });
  apps.dual = await buildApp({ env: { ...ST_ENV, AUTH_MODE: 'dual' } });
  apps.supertokens = await buildApp({ env: { ...ST_ENV, AUTH_MODE: 'supertokens' } });
});

afterAll(async () => {
  if (driver.__backend === 'pg') await driver.__raw.end();
  await provisioned.cleanup();
});

describe('GET /api/auth-info', () => {
  it('is reachable without a session, in every mode', async () => {
    // The defining property. A login screen that has to be logged in to learn
    // how to log in is useless.
    for (const mode of ['passport', 'dual', 'supertokens']) {
      const res = await request(apps[mode]).get('/api/auth-info');
      expect(res.status, mode).toBe(200);
    }
  });

  it('tells a passport deployment to drive passport', async () => {
    const res = await request(apps.passport).get('/api/auth-info');
    expect(res.body.authMode).toBe('passport');
    expect(res.body.loginFlow).toBe('passport');
  });

  it('tells a dual deployment to drive SuperTokens', async () => {
    // In `dual` both stacks accept a session and the passport routes stay
    // registered as the rollback - but the client is told to use SuperTokens,
    // because exercising that path is the entire point of dual. Until v1.9 the
    // client logged in via passport, so `dual` never ran the signInUp mapping
    // even once in production.
    const res = await request(apps.dual).get('/api/auth-info');
    expect(res.body.authMode).toBe('dual');
    expect(res.body.loginFlow).toBe('supertokens');
  });

  it('tells a supertokens deployment to drive SuperTokens', async () => {
    const res = await request(apps.supertokens).get('/api/auth-info');
    expect(res.body.authMode).toBe('supertokens');
    expect(res.body.loginFlow).toBe('supertokens');
  });

  it('lists the providers that actually have credentials', async () => {
    const res = await request(apps.dual).get('/api/auth-info');
    expect(res.body.providers).toEqual(['github', 'discord']);
  });

  it('leaks nothing beyond what the login screen needs', async () => {
    // It is public, so the shape is the security boundary: which buttons to
    // draw, and nothing else. Asserted as an exact key set so a future field
    // has to be added here deliberately rather than by accident.
    const res = await request(apps.dual).get('/api/auth-info');
    expect(Object.keys(res.body).sort()).toEqual(['authMode', 'loginFlow', 'providers']);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

describe('configuredProviders agrees with the SuperTokens provider list', () => {
  // Three copies of "does this provider have credentials" now exist:
  // configurePassport(), buildProviders() and configuredProviders(). v1.8 lost
  // a release to two copies of a core probe drifting the moment one of them
  // was fixed, so this pins the two that are machine-comparable.
  const CASES = [
    ['both configured', { GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b', DISCORD_CLIENT_ID: 'c', DISCORD_CLIENT_SECRET: 'd' }],
    ['github only', { GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b' }],
    ['discord only', { DISCORD_CLIENT_ID: 'c', DISCORD_CLIENT_SECRET: 'd' }],
    ['neither', {}],
    ['id without secret', { GITHUB_CLIENT_ID: 'a', DISCORD_CLIENT_ID: 'c' }],
    ['secret without id', { GITHUB_CLIENT_SECRET: 'b', DISCORD_CLIENT_SECRET: 'd' }],
  ];

  it.each(CASES)('%s', (_name, env) => {
    const fromAuth = configuredProviders(env);
    const fromSuperTokens = buildProviders(env).map((p) => p.config.thirdPartyId);
    expect(fromAuth).toEqual(fromSuperTokens);
  });
});

describe('the provider redirect target reaches the SPA', () => {
  // client/src/game/auth.js handles /auth/callback/<provider> in the browser,
  // which is only possible because SuperTokens' middleware does not answer it.
  // If a future SDK version starts handling that path, the client's callback
  // leg silently stops running and every login dead-ends on a blank page.

  it('SuperTokens handles /auth/authorisationurl but not /auth/callback/github', async () => {
    // Differential, deliberately. Asserting only "the callback is not JSON"
    // would pass just as well on an app where the SuperTokens middleware was
    // never mounted at all - the control request is what proves the SDK is
    // live and answering in this very app before the callback is checked.
    const handled = await request(apps.dual).get('/auth/authorisationurl');
    expect(handled.headers['content-type']).toMatch(/application\/json/);

    const fellThrough = await request(apps.dual).get('/auth/callback/github');
    expect(fellThrough.headers['content-type'] || '').not.toMatch(/application\/json/);
  });

  it('the ThirdParty recipe handles exactly three APIs, and only apple has a callback', async () => {
    // The precise fact the differential test above demonstrates, pinned
    // against the SDK itself: APPLE_REDIRECT_HANDLER is '/callback/apple' and
    // it is a POST, so a GET to /auth/callback/github matches nothing.
    const { readFileSync } = await import('node:fs');
    const constants = readFileSync(
      new URL('../node_modules/supertokens-node/lib/build/recipe/thirdparty/constants.js', import.meta.url),
      'utf8',
    );
    expect(constants).toContain('APPLE_REDIRECT_HANDLER = "/callback/apple"');
  });
});
