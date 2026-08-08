// The Phase 2 preflight gates the DEPLOYMENT half of the cutover, the way
// shadow:check gates the data half.
//
// The check that earns its keep is "core requires authentication". An
// unauthenticated SuperTokens core mints a session for ANY user id, and the id
// mapping turns that into a real RackStack session for any SUPER_ADMIN_IDS
// value without a request ever reaching Express - so it is invisible from
// inside the app, and nothing else in the system would ever surface it.

import { describe, it, expect } from 'vitest';

const {
  runPreflight, formatPreflight, preflightPassed,
} = await import('../server/supertokens/preflight.js');

const BASE_ENV = {
  SUPERTOKENS_CONNECTION_URI: 'http://core.example.com:3567',
  SUPERTOKENS_API_KEY: 'a-real-key',
  PUBLIC_ORIGIN: 'https://rackstack.example.com',
  GITHUB_CLIENT_ID: 'gh', GITHUB_CLIENT_SECRET: 'ghs',
  DISCORD_CLIENT_ID: 'dc', DISCORD_CLIENT_SECRET: 'dcs',
};

/** A fake core. `open: true` models one running with no API_KEYS. */
function fakeCore({ open = false, keyAccepted = true, reachable = true } = {}) {
  return async (url, { headers } = {}) => {
    if (!reachable) throw new Error('ECONNREFUSED');
    if (url.endsWith('/hello')) return { status: 200 };
    const hasKey = Boolean(headers && headers['api-key']);
    if (!hasKey) return { status: open ? 200 : 401 };
    return { status: keyAccepted ? 200 : 401 };
  };
}

const noStrayTables = async () => [];
const byName = (checks, name) => checks.find((c) => c.name === name);

describe('the preflight catches an open core', () => {
  it('FAILS when an anonymous request is answered', async () => {
    const checks = await runPreflight({
      env: BASE_ENV, fetchImpl: fakeCore({ open: true }), pgConnect: noStrayTables,
    });
    const auth = byName(checks, 'core requires authentication');
    expect(auth.status).toBe('FAIL');
    expect(auth.detail).toMatch(/without API_KEYS/);
    expect(auth.detail).toMatch(/SUPER_ADMIN_IDS/);
    expect(preflightPassed(checks)).toBe(false);
    expect(formatPreflight(checks)).toContain('PREFLIGHT: FAIL');
  });

  it('PASSES when the core rejects anonymous callers', async () => {
    const checks = await runPreflight({
      env: BASE_ENV, fetchImpl: fakeCore(), pgConnect: noStrayTables,
    });
    expect(byName(checks, 'core requires authentication').status).toBe('PASS');
    expect(preflightPassed(checks)).toBe(true);
    expect(formatPreflight(checks)).toContain('PREFLIGHT: PASS');
  });

  it('does not probe /hello for the auth check', async () => {
    // /hello answers unauthenticated by design, so a 200 there proves nothing.
    // If the auth check ever moved to it, an open core would read as healthy.
    const probed = [];
    await runPreflight({
      env: BASE_ENV,
      fetchImpl: async (url, opts) => {
        probed.push({ url, keyed: Boolean(opts?.headers?.['api-key']) });
        return url.endsWith('/hello') ? { status: 200 } : { status: opts?.headers?.['api-key'] ? 200 : 401 };
      },
      pgConnect: noStrayTables,
    });
    const anonProbes = probed.filter((p) => !p.keyed && !p.url.endsWith('/hello'));
    expect(anonProbes.length).toBeGreaterThan(0);
    expect(anonProbes.every((p) => p.url.includes('/recipe/'))).toBe(true);
  });
});

describe('the preflight catches a key mismatch', () => {
  it('FAILS when the core rejects our key', async () => {
    const checks = await runPreflight({
      env: BASE_ENV, fetchImpl: fakeCore({ keyAccepted: false }), pgConnect: noStrayTables,
    });
    const key = byName(checks, 'SUPERTOKENS_API_KEY');
    expect(key.status).toBe('FAIL');
    expect(key.detail).toMatch(/byte-identical/);
    expect(preflightPassed(checks)).toBe(false);
  });

  it('FAILS on a missing key for a remote core, but only WARNs on loopback', async () => {
    const { SUPERTOKENS_API_KEY: _drop, ...noKey } = BASE_ENV;

    const remote = await runPreflight({
      env: noKey, fetchImpl: fakeCore(), pgConnect: noStrayTables,
    });
    expect(byName(remote, 'SUPERTOKENS_API_KEY').status).toBe('FAIL');

    const local = await runPreflight({
      env: { ...noKey, SUPERTOKENS_CONNECTION_URI: 'http://127.0.0.1:3567' },
      fetchImpl: fakeCore(),
      pgConnect: noStrayTables,
    });
    expect(byName(local, 'SUPERTOKENS_API_KEY').status).toBe('WARN');
    expect(preflightPassed(local)).toBe(true);
  });
});

describe('the preflight catches a shared database', () => {
  it('FAILS when SuperTokens tables sit in RackStack\'s own database', async () => {
    const checks = await runPreflight({
      env: { ...BASE_ENV, DATABASE_URL: 'postgresql://u@h:5432/rackstack' },
      fetchImpl: fakeCore(),
      pgConnect: async () => ['all_auth_recipe_users', 'session_info'],
    });
    const db = byName(checks, 'core has its own database');
    expect(db.status).toBe('FAIL');
    expect(db.detail).toMatch(/SEPARATE database/);
    expect(preflightPassed(checks)).toBe(false);
  });

  it('PASSES when they are separate', async () => {
    const checks = await runPreflight({
      env: { ...BASE_ENV, DATABASE_URL: 'postgresql://u@h:5432/rackstack' },
      fetchImpl: fakeCore(),
      pgConnect: noStrayTables,
    });
    expect(byName(checks, 'core has its own database').status).toBe('PASS');
  });
});

describe('the preflight on an incomplete configuration', () => {
  it('stops early, and usefully, with no connection URI', async () => {
    const checks = await runPreflight({ env: {}, fetchImpl: fakeCore(), pgConnect: noStrayTables });
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('FAIL');
    expect(checks[0].detail).toMatch(/localhost/);
    expect(preflightPassed(checks)).toBe(false);
  });

  it('FAILS when the core cannot be reached, and does not pretend to know more', async () => {
    const checks = await runPreflight({
      env: BASE_ENV, fetchImpl: fakeCore({ reachable: false }), pgConnect: noStrayTables,
    });
    expect(byName(checks, 'core reachable').status).toBe('FAIL');
    // No auth verdict should be invented for a core we never spoke to.
    expect(byName(checks, 'core requires authentication')).toBeUndefined();
  });

  it('FAILS with no OAuth provider configured', async () => {
    const checks = await runPreflight({
      env: { SUPERTOKENS_CONNECTION_URI: BASE_ENV.SUPERTOKENS_CONNECTION_URI, PUBLIC_ORIGIN: BASE_ENV.PUBLIC_ORIGIN },
      fetchImpl: fakeCore(),
      pgConnect: noStrayTables,
    });
    expect(byName(checks, 'OAuth providers').status).toBe('FAIL');
  });

  it('FAILS when the public origin cannot be determined', async () => {
    const { PUBLIC_ORIGIN: _drop, ...noOrigin } = BASE_ENV;
    const checks = await runPreflight({
      env: noOrigin, fetchImpl: fakeCore(), pgConnect: noStrayTables,
    });
    expect(byName(checks, 'public origin').status).toBe('FAIL');
  });
});

describe('the preflight tells the operator what to register', () => {
  it('prints the exact redirect URLs, and the GitHub parent-path caveat', async () => {
    const checks = await runPreflight({
      env: BASE_ENV, fetchImpl: fakeCore(), pgConnect: noStrayTables,
    });
    const gh = byName(checks, 'github redirect to register');
    const dc = byName(checks, 'discord redirect to register');

    expect(gh.detail).toContain('https://rackstack.example.com/auth/callback/github');
    // GitHub allows one URL and matches subdirectories, so the PARENT path is
    // what gets registered - getting this wrong breaks every existing login.
    expect(gh.detail).toContain('https://rackstack.example.com/auth');
    expect(gh.detail).toMatch(/subdirector/i);
    expect(dc.detail).toContain('https://rackstack.example.com/auth/callback/discord');
  });

  it('does not claim PASS on an empty run', async () => {
    expect(preflightPassed([])).toBe(false);
  });

  it('points at the other half of the gate', async () => {
    const checks = await runPreflight({
      env: BASE_ENV, fetchImpl: fakeCore(), pgConnect: noStrayTables,
    });
    expect(formatPreflight(checks)).toContain('shadow:check');
  });
});
