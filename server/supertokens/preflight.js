#!/usr/bin/env node
// Phase 2 preflight: `npm run supertokens:check`.
//
// Verifies that a SuperTokens core is configured correctly BEFORE anyone sets
// AUTH_MODE. That ordering is the whole point - every check below is one an
// operator would otherwise only discover by flipping the switch and watching
// what breaks, and one of them (an unauthenticated core) is not something that
// breaks visibly at all.
//
// Deliberately does NOT read AUTH_MODE, and deliberately does not import
// server/db/index.js. It is a read-only diagnostic that must be safe to run at
// any point, including on a box still happily serving the legacy stack.
//
// Companion to `npm run shadow:check`, which gates the DATA half of the
// cutover. This gates the DEPLOYMENT half.

import { buildProviders, resolvePublicOrigin, PROVIDER_IDS } from './providers.js';
import { isLoopback } from './init.js';

const PASS = 'PASS';
const FAIL = 'FAIL';
const WARN = 'WARN';

/** A single check result. `fatal` marks a FAIL that must block the cutover. */
function result(status, name, detail) {
  return { status, name, detail };
}

/**
 * An endpoint that requires an API key when one is configured.
 *
 * NOT `/hello` - that answers unauthenticated by design as a health check, so
 * a 200 there proves nothing about whether the core is locked down.
 */
const AUTHED_ENDPOINT = '/recipe/users/count';

async function probe(url, { apiKey, fetchImpl, timeoutMs = 5000 }) {
  const headers = { 'api-version': '3.0' };
  if (apiKey) headers['api-key'] = apiKey;
  return fetchImpl(url, { method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs) });
}

/**
 * Runs every deployment check and returns the results.
 *
 * Injected `fetchImpl` and `pgConnect` so the whole thing is testable without a
 * core or a database; both default to the real implementations.
 */
export async function runPreflight({
  env = process.env,
  fetchImpl = fetch,
  pgConnect = defaultPgConnect,
} = {}) {
  const checks = [];
  const connectionURI = (env.SUPERTOKENS_CONNECTION_URI || '').replace(/\/$/, '');
  const apiKey = env.SUPERTOKENS_API_KEY;

  // ---- 1. Is there anything to check? -------------------------------------
  if (!connectionURI) {
    checks.push(result(
      FAIL, 'SUPERTOKENS_CONNECTION_URI',
      'Not set. Point it at the core, e.g. http://192.168.1.10:3567 - and not at '
      + 'localhost from inside a container, where that means the container itself.',
    ));
    return checks; // Nothing else is meaningful without it.
  }
  checks.push(result(PASS, 'SUPERTOKENS_CONNECTION_URI', connectionURI));

  // ---- 2. Public origin ----------------------------------------------------
  const origin = resolvePublicOrigin(env);
  checks.push(origin
    ? result(PASS, 'public origin', origin)
    : result(
      FAIL, 'public origin',
      'Cannot be determined. Set PUBLIC_ORIGIN, or configure GITHUB_CALLBACK_URL / '
      + 'DISCORD_CALLBACK_URL as you would for passport. The server refuses to start '
      + 'in dual/supertokens without it.',
    ));

  // ---- 3. Providers --------------------------------------------------------
  const providers = buildProviders(env).map((p) => p.config.thirdPartyId);
  if (providers.length === 0) {
    checks.push(result(
      FAIL, 'OAuth providers',
      `None configured. Set GITHUB_CLIENT_ID/SECRET and/or DISCORD_CLIENT_ID/SECRET, `
      + `or SuperTokens would start with no way for anyone to log in. Known: ${PROVIDER_IDS.join(', ')}.`,
    ));
  } else {
    checks.push(result(PASS, 'OAuth providers', providers.join(', ')));
    if (origin) {
      // The redirect URLs the operator must have registered. Printed rather
      // than probed - we cannot ask GitHub what is registered - but getting
      // them wrong is the single most common way the first login fails, so
      // spelling them out beats leaving it to a doc lookup.
      for (const id of providers) {
        checks.push(result(
          PASS, `${id} redirect to register`,
          `${origin}/auth/callback/${id}`
          + (id === 'github' ? `  (register the PARENT path ${origin}/auth - GitHub allows one URL and matches subdirectories)` : ''),
        ));
      }
    }
  }

  // ---- 4. Is the core reachable? ------------------------------------------
  let reachable = false;
  try {
    const hello = await probe(`${connectionURI}/hello`, { fetchImpl });
    reachable = hello.status === 200;
    checks.push(reachable
      ? result(PASS, 'core reachable', `${connectionURI}/hello answered 200`)
      : result(FAIL, 'core reachable', `${connectionURI}/hello answered ${hello.status}, expected 200`));
  } catch (e) {
    checks.push(result(
      FAIL, 'core reachable',
      `${connectionURI} did not answer (${e.message}). Check the container is running, and that `
      + 'the host is not `localhost` if RackStack runs in a different container.',
    ));
  }

  if (!reachable) return checks;

  // ---- 5. THE ONE THAT MATTERS: is the core locked down? -------------------
  //
  // A core with no API_KEYS serves its whole API unauthenticated, and that API
  // mints a session for ANY user id. Because the id mapping makes
  // session.getUserId() return `github:37058311` verbatim, anyone who can reach
  // it can mint a RackStack session for any SUPER_ADMIN_IDS value without a
  // single request touching RackStack. Nothing about this fails visibly, which
  // is exactly why it is checked here rather than left to be noticed.
  try {
    const anon = await probe(`${connectionURI}${AUTHED_ENDPOINT}`, { fetchImpl });
    if (anon.status === 401) {
      checks.push(result(PASS, 'core requires authentication', 'anonymous request rejected (401)'));
    } else {
      checks.push(result(
        FAIL, 'core requires authentication',
        `An anonymous request got HTTP ${anon.status}. The core is running without API_KEYS: `
        + 'anyone who can reach it can mint a login session for any user id, including every '
        + 'value in SUPER_ADMIN_IDS. Set API_KEYS on the core (openssl rand -hex 32), set the '
        + "same value as SUPERTOKENS_API_KEY here, and do not publish the core's port.",
      ));
    }
  } catch (e) {
    checks.push(result(WARN, 'core requires authentication', `could not verify (${e.message})`));
  }

  // ---- 5a. Does the core speak a protocol version the SDK understands? ----
  //
  // supertokens-node pins an exact set of core-driver-interface versions, and
  // the core must offer one of them. Get this wrong and the core is reachable,
  // authenticated, healthy - and every single request fails on a version
  // mismatch. Nothing about "the container is running" tells you.
  //
  // This check exists because the runbook originally pinned core 9.3, which
  // tops out at CDI 5.2 while supertokens-node@24 requires 5.4. That would
  // have been a working-looking deployment that could not log anyone in.
  try {
    const { cdiSupported } = await import('supertokens-node/lib/build/version.js');
    const res = await probe(`${connectionURI}/apiversion`, { apiKey, fetchImpl });
    const body = typeof res.json === 'function' ? await res.json() : {};
    const offered = body?.versions ?? [];
    const shared = cdiSupported.filter((v) => offered.includes(v));

    if (shared.length > 0) {
      checks.push(result(PASS, 'core protocol version', `core and SDK share CDI ${shared.join(', ')}`));
    } else if (offered.length === 0) {
      checks.push(result(WARN, 'core protocol version', 'the core did not report its CDI versions'));
    } else {
      checks.push(result(
        FAIL, 'core protocol version',
        `The SDK speaks CDI ${cdiSupported.join(', ')} but this core offers up to `
        + `${offered[offered.length - 1]}. The container will run and answer health checks, `
        + 'but every request fails on a version mismatch. Use a newer core image '
        + `(supertokens/supertokens-postgresql:12.0 or later supports ${cdiSupported.join(', ')}).`,
      ));
    }
  } catch (e) {
    checks.push(result(WARN, 'core protocol version', `could not verify (${e.message})`));
  }

  // ---- 6. Does OUR key actually work? -------------------------------------
  if (!apiKey) {
    checks.push(result(
      isLoopback(connectionURI) ? WARN : FAIL, 'SUPERTOKENS_API_KEY',
      isLoopback(connectionURI)
        ? 'Not set. Tolerated because the core is on loopback and only this host can reach it.'
        : 'Not set, and the core is not on loopback. The server will refuse to start in '
          + 'dual/supertokens mode until this matches API_KEYS on the core.',
    ));
  } else {
    try {
      const authed = await probe(`${connectionURI}${AUTHED_ENDPOINT}`, { apiKey, fetchImpl });
      checks.push(authed.status === 200
        ? result(PASS, 'SUPERTOKENS_API_KEY', 'accepted by the core')
        : result(
          FAIL, 'SUPERTOKENS_API_KEY',
          `The core rejected it (HTTP ${authed.status}). It must be byte-identical to a value in `
          + "the core's API_KEYS. A mismatch here fails every login once AUTH_MODE is set.",
        ));
    } catch (e) {
      checks.push(result(WARN, 'SUPERTOKENS_API_KEY', `could not verify (${e.message})`));
    }
  }

  // ---- 7. Does the core have its OWN database? ----------------------------
  //
  // SuperTokens manages its own schema. Pointed at the rackstack database it
  // would create its tables alongside the game's - which is not immediately
  // fatal, but entangles two schemas that have to be backed up, migrated and
  // rolled back independently. Detected by looking for SuperTokens' tables
  // inside RackStack's own database.
  if (env.DATABASE_URL) {
    try {
      const stray = await pgConnect(env.DATABASE_URL);
      checks.push(stray.length === 0
        ? result(PASS, 'core has its own database', "no SuperTokens tables in RackStack's database")
        : result(
          FAIL, 'core has its own database',
          `Found SuperTokens tables inside RackStack's own database (${stray.join(', ')}). The core's `
          + 'POSTGRESQL_CONNECTION_URI must point at a SEPARATE database on the same server - '
          + 'e.g. CREATE DATABASE supertokens OWNER <your role> - never at the rackstack one.',
        ));
    } catch (e) {
      checks.push(result(WARN, 'core has its own database', `could not check (${e.message})`));
    }
  }

  return checks;
}

/** Looks for SuperTokens-owned tables inside RackStack's own database. */
async function defaultPgConnect(url) {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const { rows } = await client.query(`
      SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND (table_name LIKE 'supertokens%' OR table_name IN
              ('all_auth_recipe_users', 'session_info', 'thirdparty_users', 'key_value'))
       ORDER BY table_name
    `);
    await client.query('COMMIT');
    return rows.map((r) => r.table_name);
  } finally {
    await client.end();
  }
}

export function formatPreflight(checks) {
  const width = Math.max(...checks.map((c) => c.name.length), 0);
  const lines = ['=== SuperTokens deployment preflight ==='];
  for (const c of checks) {
    lines.push(`[${c.status.padEnd(4)}] ${c.name.padEnd(width)}  ${c.detail}`);
  }

  const failed = checks.filter((c) => c.status === FAIL);
  const warned = checks.filter((c) => c.status === WARN);
  lines.push('');
  if (failed.length > 0) {
    lines.push(
      `PREFLIGHT: FAIL - ${failed.length} problem(s). Do NOT set AUTH_MODE yet; `
      + 'each line above says what to change.',
    );
  } else if (warned.length > 0) {
    lines.push(
      `PREFLIGHT: PASS with ${warned.length} warning(s). Nothing blocks the cutover, but read them.`,
    );
  } else {
    lines.push('PREFLIGHT: PASS - the deployment side is ready for AUTH_MODE=dual.');
  }
  lines.push('Run `npm run shadow:check` too: this gates the deployment, that gates the data.');
  return lines.join('\n');
}

export function preflightPassed(checks) {
  return checks.length > 0 && !checks.some((c) => c.status === FAIL);
}

async function main() {
  const checks = await runPreflight();
  console.log(formatPreflight(checks));
  process.exitCode = preflightPassed(checks) ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith('preflight.js')) {
  main().catch((e) => {
    console.error('[preflight] failed to run:', e);
    process.exitCode = 2;
  });
}
