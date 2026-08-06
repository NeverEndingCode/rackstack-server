process.env.JWT_SECRET = 'test-secret-st-init';

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildProviders, resolvePublicOrigin, PROVIDER_IDS } from '../server/supertokens/providers.js';
import { initSuperTokens, __isInitialised, __resetForTests } from '../server/supertokens/init.js';

const CREDS = {
  GITHUB_CLIENT_ID: 'gh-id',
  GITHUB_CLIENT_SECRET: 'gh-secret',
  DISCORD_CLIENT_ID: 'dc-id',
  DISCORD_CLIENT_SECRET: 'dc-secret',
  PUBLIC_ORIGIN: 'https://rackstack.example.com',
  SUPERTOKENS_CONNECTION_URI: 'http://supertokens:3567',
};

beforeEach(() => { __resetForTests(); });

describe('buildProviders', () => {
  it('uses the same thirdPartyId strings stored in the identities table', () => {
    // The whole migration hinges on this: signInUp looks identities up by
    // (provider, provider_id), and `provider` is 'github'/'discord' as
    // written by passport. A different id here makes every existing player
    // look brand new.
    const ids = buildProviders(CREDS).map((p) => p.config.thirdPartyId);
    expect(ids.sort()).toEqual(['discord', 'github']);
    for (const id of ids) expect(PROVIDER_IDS).toContain(id);
  });

  it('omits a provider with no credentials, mirroring configurePassport', () => {
    const githubOnly = buildProviders({
      GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'y',
    });
    expect(githubOnly.map((p) => p.config.thirdPartyId)).toEqual(['github']);

    const discordOnly = buildProviders({
      DISCORD_CLIENT_ID: 'x', DISCORD_CLIENT_SECRET: 'y',
    });
    expect(discordOnly.map((p) => p.config.thirdPartyId)).toEqual(['discord']);
  });

  it('omits a provider with an id but no secret, rather than half-configuring it', () => {
    expect(buildProviders({ GITHUB_CLIENT_ID: 'x' })).toEqual([]);
    expect(buildProviders({ GITHUB_CLIENT_SECRET: 'y' })).toEqual([]);
  });

  it('returns an empty list when nothing is configured', () => {
    expect(buildProviders({})).toEqual([]);
  });

  it('carries the credentials through unchanged', () => {
    const [gh] = buildProviders({ GITHUB_CLIENT_ID: 'abc', GITHUB_CLIENT_SECRET: 'def' });
    expect(gh.config.clients).toEqual([{ clientId: 'abc', clientSecret: 'def' }]);
  });

  it('requests only the identify scope for Discord', () => {
    // SuperTokens' built-in Discord provider would also ask for 'email'.
    // Requesting a scope existing players never consented to re-prompts them
    // for new permissions mid-rollout, which looks like a phishing attempt.
    const [dc] = buildProviders({ DISCORD_CLIENT_ID: 'a', DISCORD_CLIENT_SECRET: 'b' });
    expect(dc.config.clients[0].scope).toEqual(['identify']);
  });
});

describe('resolvePublicOrigin', () => {
  it('prefers an explicit PUBLIC_ORIGIN', () => {
    expect(resolvePublicOrigin({
      PUBLIC_ORIGIN: 'https://explicit.example.com',
      GITHUB_CALLBACK_URL: 'https://other.example.com/auth/github/callback',
    })).toBe('https://explicit.example.com');
  });

  it('strips a trailing slash from PUBLIC_ORIGIN', () => {
    expect(resolvePublicOrigin({ PUBLIC_ORIGIN: 'https://x.example.com/' }))
      .toBe('https://x.example.com');
  });

  it('falls back to the origin of an existing callback URL', () => {
    // Avoids demanding a new mandatory variable from operators who already
    // have these configured for passport.
    expect(resolvePublicOrigin({
      GITHUB_CALLBACK_URL: 'https://rackstack.example.com/auth/github/callback',
    })).toBe('https://rackstack.example.com');

    expect(resolvePublicOrigin({
      DISCORD_CALLBACK_URL: 'https://rackstack.example.com/auth/discord/callback',
    })).toBe('https://rackstack.example.com');
  });

  it('skips a malformed callback URL and uses the other provider\'s', () => {
    expect(resolvePublicOrigin({
      GITHUB_CALLBACK_URL: 'not a url',
      DISCORD_CALLBACK_URL: 'https://good.example.com/auth/discord/callback',
    })).toBe('https://good.example.com');
  });

  it('returns undefined when nothing is configured', () => {
    expect(resolvePublicOrigin({})).toBeUndefined();
  });
});

describe('initSuperTokens containment', () => {
  it('does nothing in passport mode, even with everything configured', async () => {
    await expect(initSuperTokens({ env: CREDS, mode: 'passport' })).resolves.toBe(false);
    expect(__isInitialised()).toBe(false);
  });

  it('imports the SDK only dynamically, so passport mode never loads it', () => {
    // The containment guarantee. Asserted at the source level on purpose:
    // probing Node's module registry from ESM is unreliable (there is no
    // portable way to ask "was this specifier resolved?"), and a probe that
    // silently answers "no" would make this test pass no matter what the
    // code did - the exact vacuous shape this project keeps finding.
    //
    // A static `import ... from 'supertokens-node...'` in init.js would put
    // the SDK, and its nodemailer/twilio/libphonenumber transitive tree, on
    // the boot path of every deployment including those that never opt in.
    // This fails the moment one is added.
    const src = readFileSync(new URL('../server/supertokens/init.js', import.meta.url), 'utf8');

    const staticImports = [...src.matchAll(/^\s*import\s[^\n]*?from\s+'([^']+)'/gm)]
      .map((m) => m[1]);
    expect(staticImports).not.toContain('supertokens-node');
    expect(staticImports.filter((s) => s.startsWith('supertokens-node'))).toEqual([]);

    // ...and it must still be imported dynamically somewhere, or this test
    // would also pass against a file that had dropped SuperTokens entirely.
    expect(src).toMatch(/import\('supertokens-node'\)/);
  });

  it('mounts nothing extra on the app in passport mode', async () => {
    // app.js's middleware stack in passport mode must be what it was before
    // v1.8 existed. Comparing route-layer counts is the cheapest way to see
    // an accidental extra `app.use`.
    const { buildApp } = await import('../server/app.js');
    const app = await buildApp({ env: { ...process.env, AUTH_MODE: 'passport' } });
    const layerNames = app._router.stack.map((l) => l.name);
    expect(layerNames).not.toContain('middleware');
    expect(layerNames).not.toContain('errorHandler');
  });
});

describe('initSuperTokens configuration errors', () => {
  it('refuses to start without a SuperTokens core URI', async () => {
    const { SUPERTOKENS_CONNECTION_URI: _omit, ...env } = CREDS;
    await expect(initSuperTokens({ env, mode: 'dual' }))
      .rejects.toThrow(/SUPERTOKENS_CONNECTION_URI/);
  });

  it('names the way out in the error, rather than only the problem', async () => {
    const { SUPERTOKENS_CONNECTION_URI: _omit, ...env } = CREDS;
    await expect(initSuperTokens({ env, mode: 'dual' }))
      .rejects.toThrow(/AUTH_MODE=passport/);
  });

  it('refuses when it cannot determine the public origin', async () => {
    const {
      PUBLIC_ORIGIN: _a, GITHUB_CALLBACK_URL: _b, DISCORD_CALLBACK_URL: _c, ...env
    } = CREDS;
    await expect(initSuperTokens({ env, mode: 'dual' }))
      .rejects.toThrow(/public origin/i);
  });

  it('refuses when no OAuth provider is configured', async () => {
    // Otherwise SuperTokens comes up healthy with no way for anyone to log
    // in - a failure that looks like success until a player tries.
    await expect(initSuperTokens({
      env: {
        SUPERTOKENS_CONNECTION_URI: 'http://supertokens:3567',
        PUBLIC_ORIGIN: 'https://x.example.com',
      },
      mode: 'dual',
    })).rejects.toThrow(/no OAuth provider is configured/);
  });

  it('does not mark itself initialised after a failed init', async () => {
    const { SUPERTOKENS_CONNECTION_URI: _omit, ...env } = CREDS;
    await expect(initSuperTokens({ env, mode: 'dual' })).rejects.toThrow();
    expect(__isInitialised()).toBe(false);
  });
});
