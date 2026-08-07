process.env.JWT_SECRET = 'test-secret-st-init';

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildProviders, resolvePublicOrigin, PROVIDER_IDS } from '../server/supertokens/providers.js';
import {
  initSuperTokens, __isInitialised, __resetForTests, isLoopback,
} from '../server/supertokens/init.js';

const CREDS = {
  GITHUB_CLIENT_ID: 'gh-id',
  GITHUB_CLIENT_SECRET: 'gh-secret',
  DISCORD_CLIENT_ID: 'dc-id',
  DISCORD_CLIENT_SECRET: 'dc-secret',
  PUBLIC_ORIGIN: 'https://rackstack.example.com',
  SUPERTOKENS_CONNECTION_URI: 'http://supertokens:3567',
  // The core is not on loopback here, so a key is mandatory - see the
  // 'refuses a non-loopback core with no API key' test below.
  SUPERTOKENS_API_KEY: 'test-core-api-key',
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
    // v1.8 existed.
    //
    // This used to assert `layerNames` did not contain 'middleware' or
    // 'errorHandler' - which could never fail, because SuperTokens' express
    // bindings are ANONYMOUS functions and appear on the stack as
    // '<anonymous>'. The assertion passed whether or not they were mounted,
    // i.e. it tested nothing at all. Found while fixing the mutation-detected
    // gap that nothing asserted the POSITIVE case either
    // (tests/supertokens.middleware.test.js now does, by count and by HTTP).
    //
    // Counting layers is the honest version: the two SuperTokens layers are
    // exactly the difference between the two modes.
    const { buildApp } = await import('../server/app.js');
    const app = await buildApp({ env: { ...process.env, AUTH_MODE: 'passport' } });

    const names = app._router.stack.map((l) => l.name);
    // Recorded explicitly so an accidental `app.use` shows up as a diff here
    // rather than passing silently.
    expect(names).toEqual([
      'query', 'expressInit', 'initialize', 'cookieParser', 'jsonParser',
      'router', 'router', 'serveStatic', 'bound dispatch',
    ]);
  });
});

describe('the SDK actually loads on this runtime', () => {
  // Deliberately separate from the containment tests above, and deliberately
  // NOT redundant with them.
  //
  // Every other test in this file either runs in passport mode or hits a
  // config error that throws before init.js reaches its dynamic import - so
  // without this, the suite would be fully green on a runtime where
  // supertokens-node cannot even be loaded. That is precisely how v1.7
  // shipped four commits of silently-red CI: the failing import was on a path
  // no green test exercised.
  //
  // CI runs Node 20 to match the production image, so this is the check that
  // makes CI meaningful for the dependency, rather than merely passing.
  //
  // Loading the SDK here does not weaken the containment assertions above:
  // those are source-level (init.js must contain no static import), not
  // module-registry-level, and vitest isolates by file.

  it('imports supertokens-node and both recipes without throwing', async () => {
    const [core, session, thirdparty] = await Promise.all([
      import('supertokens-node').then((m) => m.default ?? m),
      import('supertokens-node/recipe/session').then((m) => m.default ?? m),
      import('supertokens-node/recipe/thirdparty').then((m) => m.default ?? m),
    ]);
    expect(typeof core.init).toBe('function');
    expect(typeof session.init).toBe('function');
    expect(typeof thirdparty.init).toBe('function');
  });

  it('exposes the express framework bindings app.js mounts', async () => {
    const { middleware, errorHandler } = await import('supertokens-node/framework/express');
    expect(typeof middleware).toBe('function');
    expect(typeof errorHandler).toBe('function');
  });

  it('exposes the two user-id-mapping functions the signInUp override calls', async () => {
    // The mapping override is tested against a fake core, which is what makes
    // its ordering assertions possible - but a fake will happily answer to any
    // method name, so nothing there would notice if the real SDK renamed or
    // dropped these. This is the only check that the object init.js actually
    // hands to buildSignInUpOverride carries the functions it will call.
    //
    // Worth pinning precisely because of how it would fail otherwise: an
    // absent createUserIdMapping means no mapping is created, and no mapping
    // means a returning player silently lands on an empty save. There is no
    // error at the moment it happens.
    const core = await import('supertokens-node').then((m) => m.default ?? m);
    expect(typeof core.createUserIdMapping).toBe('function');
    expect(typeof core.getUserIdMapping).toBe('function');
  });

  it("takes the mapping parameter spelled with a capital T, as mapping.js sends it", async () => {
    // `superTokensUserId`, not `supertokensUserId`. The lowercase spelling is
    // accepted silently as undefined - no throw, no log, no mapping - so the
    // typo fails as the invisible wrong-save bug rather than as an error.
    // Asserted against the shipped type declaration, which is the only
    // machine-readable statement of the key the SDK reads.
    const { readFileSync } = await import('node:fs');
    const dts = readFileSync(
      new URL('../node_modules/supertokens-node/lib/build/index.d.ts', import.meta.url),
      'utf8',
    );
    const signature = dts.slice(dts.indexOf('static createUserIdMapping'));
    expect(signature).toContain('superTokensUserId');
    expect(signature.slice(0, 200)).not.toContain('supertokensUserId:');
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

  it('refuses a non-loopback core with no API key', async () => {
    // Review-found: the shipped compose file ran the core with no API_KEYS and
    // published its port. A core without a key serves its whole API open, and
    // POST /recipe/session mints a session for ANY userId - which the id
    // mapping then turns into a real RackStack session for any SUPER_ADMIN_IDS
    // value, without a single request reaching Express.
    const { SUPERTOKENS_API_KEY: _omit, ...env } = CREDS;
    await expect(initSuperTokens({
      env: { ...env, SUPERTOKENS_CONNECTION_URI: 'http://supertokens.example.com:3567' },
      mode: 'dual',
    })).rejects.toThrow(/SUPERTOKENS_API_KEY/);
  });

  it('allows a loopback core without a key, since only this host can reach it', async () => {
    // Requiring one there would only teach people to set a dummy value, which
    // is worse than an exemption that is explained.
    const { SUPERTOKENS_API_KEY: _omit, ...env } = CREDS;
    await expect(initSuperTokens({
      env: { ...env, SUPERTOKENS_CONNECTION_URI: 'http://127.0.0.1:3567' },
      mode: 'dual',
    })).resolves.toBe(true);
    __resetForTests();
  });

  it('does not treat a lookalike hostname as loopback', async () => {
    // A substring check for '127.0.0.1' would wave through
    // http://127.0.0.1.evil.com - the classic way this exemption goes wrong.
    expect(isLoopback('http://127.0.0.1.evil.com:3567')).toBe(false);
    expect(isLoopback('http://localhost.attacker.net:3567')).toBe(false);
    expect(isLoopback('http://127.0.0.1:3567')).toBe(true);
    expect(isLoopback('http://localhost:3567')).toBe(true);
    expect(isLoopback('not a url')).toBe(false);
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
