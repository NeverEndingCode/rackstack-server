import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { rejectRawOAuthTokens } from '../server/supertokens/init.js';
import { buildProviders } from '../server/supertokens/providers.js';

// Regressions for two defects found by a security review of the v1.8 branch,
// before any cutover. Both live in the seam between our configuration and
// supertokens-node's own defaults, which is exactly where nothing else looks.

describe('rejectRawOAuthTokens (authentication bypass guard)', () => {
  // THE HOLE. SuperTokens' stock signInUpPOST accepts EITHER redirectURIInfo
  // (the browser authorization-code flow) OR a caller-supplied oAuthTokens
  // object, and treats the latter as proof of identity:
  //
  //   recipe/thirdparty/api/signinup.js
  //     else if (bodyParams.oAuthTokens !== undefined) { oAuthTokens = ... }
  //
  // For GitHub the audience check that would make that safe is dead code.
  // providers/github.js DEFINES config.validateAccessToken - which asks
  // api.github.com whether the token was minted for this OAuth app - but that
  // is only ever invoked from the GENERIC getUserInfo in providers/custom.js,
  // and github.js then REPLACES getUserInfo wholesale in an override applied
  // last. Its replacement calls api.github.com/user with `Bearer <token>` and
  // asks nothing about the token's origin.
  //
  // Unpatched, an unauthenticated
  //   POST /auth/signinup {"thirdPartyId":"github","oAuthTokens":{...}}
  // carrying ANY GitHub token able to read /user - one minted for an unrelated
  // OAuth app the victim authorised, or a leaked PAT - resolves to that
  // victim's thirdPartyUserId, and our mapping faithfully turns it into their
  // users.id. Account takeover; full admin when the victim is in
  // SUPER_ADMIN_IDS, whose values are deterministic and effectively public.
  //
  // A regression against the passport stack rather than a pre-existing flaw:
  // passport-github2 only ever obtains a token by exchanging an authorization
  // code with our own client secret, so a foreign token cannot be replayed.
  //
  // Asserted against the guard directly rather than through a live core,
  // because the behaviour being guarded lives inside the SDK.

  const passThrough = { signInUpPOST: async (input) => ({ status: 'OK', echoed: input }) };

  it('rejects a request that submits raw oAuthTokens', async () => {
    // GENERAL_ERROR, not a thrown Error. A throw reached Express's default
    // handler as a 500, which reads as transient - so a client would retry a
    // request that can never succeed. GENERAL_ERROR is the SDK's own contract
    // for "refused, do not retry". What matters either way is that the stock
    // implementation is never reached.
    const guarded = rejectRawOAuthTokens(passThrough);
    const res = await guarded.signInUpPOST({
      oAuthTokens: { access_token: 'gho_stolen_from_another_app' },
    });
    expect(res.status).toBe('GENERAL_ERROR');
    expect(res.status).not.toBe('OK');
    expect(res.echoed).toBeUndefined();
    expect(res.message).toMatch(/redirect-URI flow/);
  });

  it('names why, not merely that it refused', async () => {
    const guarded = rejectRawOAuthTokens(passThrough);
    const res = await guarded.signInUpPOST({ oAuthTokens: { access_token: 'x' } });
    expect(res.message).toMatch(/issued to this application/);
  });

  it('refuses to boot against a core that answers unauthenticated callers', async () => {
    // The env check alone is one-sided: it proves WE hold a key, not that the
    // core demands one. Compose cannot diverge (both read the same variable),
    // but Unraid is two hand-configured containers, and a key set here with
    // API_KEYS blank on the core satisfies the env check while leaving the
    // core open to everyone else on the network.
    const { assertCoreRejectsAnonymous } = await import('../server/supertokens/init.js');
    const openCore = async () => ({ status: 200 });

    await expect(assertCoreRejectsAnonymous({
      connectionURI: 'http://supertokens.example.com:3567', hasKey: true, fetchImpl: openCore,
    })).rejects.toThrow(/without API_KEYS/);
  });

  it('accepts a core that rejects unauthenticated callers', async () => {
    const { assertCoreRejectsAnonymous } = await import('../server/supertokens/init.js');
    const closedCore = async () => ({ status: 401 });

    await expect(assertCoreRejectsAnonymous({
      connectionURI: 'http://supertokens.example.com:3567', hasKey: true, fetchImpl: closedCore,
    })).resolves.toBe('closed');
  });

  it('warns rather than refuses when the core cannot be reached', async () => {
    // A core that is simply not up yet is an ordering hiccup during a
    // simultaneous container start; refusing there would turn it into an
    // outage. Only a CONFIRMED-open core is fatal.
    const { assertCoreRejectsAnonymous } = await import('../server/supertokens/init.js');
    const unreachable = async () => { throw new Error('ECONNREFUSED'); };

    await expect(assertCoreRejectsAnonymous({
      connectionURI: 'http://supertokens.example.com:3567', hasKey: true, fetchImpl: unreachable,
    })).resolves.toBe('unverified');
  });

  it('does not probe /hello, which answers unauthenticated by design', async () => {
    // Probing the health endpoint would prove nothing - it is meant to answer
    // without a key, so a 200 there is not evidence the core is open.
    const { assertCoreRejectsAnonymous } = await import('../server/supertokens/init.js');
    let probed;
    await assertCoreRejectsAnonymous({
      connectionURI: 'http://core:3567',
      hasKey: true,
      fetchImpl: async (url) => { probed = url; return { status: 401 }; },
    });
    expect(probed).not.toContain('/hello');
    expect(probed).toContain('/recipe/');
  });

  it('refuses to boot against a core too old for this SDK', async () => {
    // The SDK does catch this, but only from inside a request - so without a
    // boot check the container starts healthy, passes its health check, and
    // fails every login. This is the difference between "the container will
    // not start, and here is why" and a player reporting they cannot sign in.
    const { assertCoreSpeaksOurProtocol } = await import('../server/supertokens/init.js');
    const oldCore = async () => ({ status: 200, json: async () => ({ versions: ['5.0', '5.1', '5.2'] }) });

    await expect(assertCoreSpeaksOurProtocol({
      connectionURI: 'http://core:3567', fetchImpl: oldCore,
    })).rejects.toThrow(/core-driver-interface/);
    await expect(assertCoreSpeaksOurProtocol({
      connectionURI: 'http://core:3567', fetchImpl: oldCore,
    })).rejects.toThrow(/failing every login/);
  });

  it('accepts a core that offers a version the SDK speaks', async () => {
    const { assertCoreSpeaksOurProtocol } = await import('../server/supertokens/init.js');
    const { cdiSupported } = await import('supertokens-node/lib/build/version.js');
    // Built from the SDK's own declared support, so upgrading the SDK moves
    // this test with it instead of leaving a stale literal behind.
    const goodCore = async () => ({ status: 200, json: async () => ({ versions: ['2.7', ...cdiSupported] }) });

    await expect(assertCoreSpeaksOurProtocol({
      connectionURI: 'http://core:3567', fetchImpl: goodCore,
    })).resolves.toEqual(cdiSupported);
  });

  it('warns rather than refuses when the core cannot be reached', async () => {
    // Same reasoning as the API-key probe: a core that is still starting must
    // not turn a boot-ordering hiccup into an outage.
    const { assertCoreSpeaksOurProtocol } = await import('../server/supertokens/init.js');
    const unreachable = async () => { throw new Error('ECONNREFUSED'); };

    await expect(assertCoreSpeaksOurProtocol({
      connectionURI: 'http://core:3567', fetchImpl: unreachable,
    })).resolves.toBe('unverified');
  });

  it('lets the legitimate redirect-URI flow through untouched', async () => {
    // The guard must not break real logins. In this flow the token is obtained
    // by exchanging an authorization code with our own client secret, so it is
    // bound to this application and there is nothing to replay.
    const guarded = rejectRawOAuthTokens(passThrough);
    const info = { redirectURIOnProviderDashboard: 'https://x.example.com/auth/callback/github' };
    await expect(guarded.signInUpPOST({ redirectURIInfo: info }))
      .resolves.toMatchObject({ status: 'OK' });
  });

  it('takes the safe path when a request carries both', async () => {
    // The guard keys on the presence of redirectURIInfo, so a request
    // supplying both still goes through the redirect flow. Asserted because
    // the SDK's own precedence between the two is an implementation detail we
    // should not be depending on silently.
    const guarded = rejectRawOAuthTokens(passThrough);
    const info = { redirectURIOnProviderDashboard: 'https://x.example.com/cb' };
    await expect(guarded.signInUpPOST({
      redirectURIInfo: info,
      oAuthTokens: { access_token: 'x' },
    })).resolves.toMatchObject({ status: 'OK' });
  });

  it('preserves the other apis the SDK exposes', async () => {
    // An override that dropped its siblings would silently disable
    // authorisationurl and the Apple redirect handler.
    const original = {
      signInUpPOST: async () => ({ status: 'OK' }),
      authorisationUrlGET: async () => ({ status: 'OK', urlWithQueryParams: 'https://x' }),
      appleRedirectHandlerPOST: async () => ({ status: 'OK' }),
    };
    const guarded = rejectRawOAuthTokens(original);
    expect(typeof guarded.authorisationUrlGET).toBe('function');
    expect(typeof guarded.appleRedirectHandlerPOST).toBe('function');
    await expect(guarded.authorisationUrlGET()).resolves.toMatchObject({ status: 'OK' });
  });

  it('tolerates the api being disabled entirely', async () => {
    // SuperTokens lets an api be set to undefined to switch it off. Wrapping
    // that in a function would resurrect a deliberately disabled endpoint.
    const guarded = rejectRawOAuthTokens({ signInUpPOST: undefined });
    expect(guarded.signInUpPOST).toBeUndefined();
  });

  it('is actually wired into ThirdParty.init', () => {
    // The guard is worthless if it is never installed, and the wiring is the
    // half a unit test of the function cannot see. Source-level because
    // asserting it live would need a running core.
    const src = readFileSync(new URL('../server/supertokens/init.js', import.meta.url), 'utf8');
    expect(src).toMatch(/apis:\s*rejectRawOAuthTokens/);
  });
});

describe('Discord logins must be able to complete at all', () => {
  it('sets requireEmail:false, because the pinned scope returns no email', () => {
    // Not polish - without this, every Discord login fails.
    //
    // We deliberately pin Discord to scope ['identify'] to match what
    // passport-discord already requested, so returning players are not
    // re-prompted to consent to a new permission mid-rollout. But SuperTokens'
    // API layer (recipe/thirdparty/api/implementation.js) substitutes a
    // placeholder email only when requireEmail === false; otherwise it returns
    // NO_EMAIL_GIVEN_BY_PROVIDER. Discord's built-in provider does not set it.
    //
    // So the two choices combine into a total Discord outage, and it fails in
    // the API layer - before the mapping override runs, where none of our own
    // code or tests would see it.
    //
    // Safe because RackStack never uses email: identity is
    // `provider:providerId` end to end, and upsertUser takes only provider,
    // providerId, username and avatarUrl.
    const [dc] = buildProviders({ DISCORD_CLIENT_ID: 'a', DISCORD_CLIENT_SECRET: 'b' });
    expect(dc.config.clients[0].scope).toEqual(['identify']);
    expect(dc.config.requireEmail).toBe(false);
  });

  it('leaves GitHub on its default scope, which does yield an email', () => {
    // GitHub is not pinned, so it keeps ['read:user','user:email'] and returns
    // an email - hence no requireEmail override is needed or wanted there.
    const [gh] = buildProviders({ GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b' });
    expect(gh.config.clients[0].scope).toBeUndefined();
    expect(gh.config.requireEmail).toBeUndefined();
  });
});
