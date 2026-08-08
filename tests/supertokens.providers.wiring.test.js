// Does the provider list buildProviders() returns actually REACH the recipe?
//
// This file exists because v1.8 tested both halves of that question and never
// the seam between them: supertokens.init.test.js asserts buildProviders()
// returns the right list, and separately asserts init refuses to start when
// the list is empty - so both were green while init.js handed the list to
// ThirdParty.init under `signInUpFeature`, a key the SDK does not read.
//
// The failure mode is total and silent. `signInAndUpFeature` is optional in
// the SDK's TypeInput and JavaScript has no excess-property check at runtime,
// so the misspelled key is dropped without a throw, a warning or a log line.
// The stack initialises, every existing test stays green, and the only symptom
// is at the HTTP edge: every /auth/authorisationurl answers
//   400 {"message":"the provider github could not be found in the configuration"}
// which is exactly what production returned throughout the v1.8 `dual` rollout.
// It went unnoticed because the client still logged in via passport, so
// nothing ever drove the SuperTokens flow.
//
// The assertion below deliberately runs the captured config through the SDK's
// OWN normaliser rather than checking the key name by hand. Checking the name
// would only restate the fix; running the normaliser tests the property that
// actually matters - that the providers survive into the recipe - and so it
// also fails if a future SDK version renames or restructures the key.

process.env.JWT_SECRET = 'test-secret-st-provider-wiring';

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Captures the config object init.js passes to ThirdParty.init, then calls
// through to the real implementation so supertokens.init() still receives a
// genuine recipe. init.js imports this module dynamically; vi.mock intercepts
// dynamic imports too.
let capturedConfig;

vi.mock('supertokens-node/recipe/thirdparty', async (importOriginal) => {
  const actual = await importOriginal();
  const real = actual.default ?? actual;
  return {
    ...actual,
    default: {
      init: (config) => {
        capturedConfig = config;
        return real.init(config);
      },
    },
  };
});

const { initSuperTokens, __resetForTests } = await import('../server/supertokens/init.js');

// The SDK's own normaliser - the single source of truth for which key it
// reads. Deep-imported from the build output, the same way the capital-T
// mapping test in supertokens.init.test.js pins createUserIdMapping's
// signature against the shipped declaration file.
const { validateAndNormaliseUserInput } = await import(
  'supertokens-node/lib/build/recipe/thirdparty/utils.js'
);

const CREDS = {
  GITHUB_CLIENT_ID: 'gh-id',
  GITHUB_CLIENT_SECRET: 'gh-secret',
  DISCORD_CLIENT_ID: 'dc-id',
  DISCORD_CLIENT_SECRET: 'dc-secret',
  PUBLIC_ORIGIN: 'https://rackstack.example.com',
  // `.invalid` is reserved (RFC 2606) and fails DNS resolution immediately.
  // A plausible-looking hostname makes init's core probes sit on a connect
  // timeout instead, which cost this file 8 seconds per init.
  SUPERTOKENS_CONNECTION_URI: 'http://supertokens.invalid:3567',
  SUPERTOKENS_API_KEY: 'test-core-api-key',
};

beforeEach(() => {
  __resetForTests();
  capturedConfig = undefined;
});

describe('the configured providers reach the ThirdParty recipe', () => {
  it('survives the SDK\'s own normalisation, rather than being silently dropped', async () => {
    await initSuperTokens({ env: { ...CREDS, AUTH_MODE: 'dual' }, mode: 'dual' });

    expect(capturedConfig, 'ThirdParty.init was never called').toBeDefined();

    const normalised = validateAndNormaliseUserInput(undefined, capturedConfig);
    const ids = normalised.signInAndUpFeature.providers.map((p) => p.config.thirdPartyId);

    // Both configured providers must be present. An empty array here is the
    // production bug: init succeeded, no provider is reachable.
    expect(ids).toEqual(['github', 'discord']);
  });

  it('registers providers under the ids stored in the identities table', async () => {
    // The thirdPartyId is what the signInUp override looks identities up by,
    // so a provider that arrives under the wrong id is as bad as one that does
    // not arrive at all - every existing player would be treated as new.
    await initSuperTokens({ env: { ...CREDS, AUTH_MODE: 'supertokens' }, mode: 'supertokens' });

    const normalised = validateAndNormaliseUserInput(undefined, capturedConfig);
    const ids = normalised.signInAndUpFeature.providers.map((p) => p.config.thirdPartyId);

    expect(ids).toContain('github');
    expect(ids).toContain('discord');
  });

  it('omits a provider whose credentials are absent, all the way through', async () => {
    const { DISCORD_CLIENT_ID: _id, DISCORD_CLIENT_SECRET: _secret, ...github } = CREDS;
    await initSuperTokens({ env: { ...github, AUTH_MODE: 'dual' }, mode: 'dual' });

    const normalised = validateAndNormaliseUserInput(undefined, capturedConfig);
    const ids = normalised.signInAndUpFeature.providers.map((p) => p.config.thirdPartyId);

    expect(ids).toEqual(['github']);
  });

  it('documents the trap: the misspelled key normalises to no providers at all', () => {
    // Not a test of our code - a test of the claim this whole file rests on,
    // so that the comment above cannot rot into a plausible-sounding lie.
    const providers = [{ config: { thirdPartyId: 'github', clients: [] } }];

    const wrong = validateAndNormaliseUserInput(undefined, { signInUpFeature: { providers } });
    expect(wrong.signInAndUpFeature.providers).toEqual([]);

    const right = validateAndNormaliseUserInput(undefined, { signInAndUpFeature: { providers } });
    expect(right.signInAndUpFeature.providers).toHaveLength(1);
  });
});
