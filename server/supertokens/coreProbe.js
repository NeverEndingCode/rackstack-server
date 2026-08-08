// Asking a SuperTokens core whether it requires authentication.
//
// ONE implementation, imported by both the boot-time guard (init.js) and the
// operator preflight (preflight.js). It lives in its own module because it
// previously did not: the same probe was written twice, the path was corrected
// in the preflight, and the copy in the boot path was left behind - where a
// wrong answer does not print a scary line, it stops the container from
// starting. If you add a third caller, import this; do not copy it.

/**
 * Endpoints gated by the core's API key, newest path first.
 *
 * NOT `/hello` - that answers unauthenticated by design as a health check, so
 * a 200 there proves nothing about whether the core is locked down.
 *
 * More than one because the path is tenant-scoped on modern cores
 * (`/<tenantId>/users/count`, per supertokens-node's own querier) and was not
 * on older ones. v1.8.2 shipped a single guessed path that core 12 does not
 * implement, so every probe returned 404.
 */
export const AUTHED_ENDPOINTS = Object.freeze([
  '/public/users/count', // cores with multitenancy (the default tenant)
  '/recipe/users/count', // older cores
]);

/**
 * Probes the first endpoint this core actually implements.
 *
 * Returns `{ status, path }`. `status` is `null` when every candidate 404s,
 * which means "this core exposes no path we know how to ask" - NOT "the core
 * answered". That distinction is the entire point of this module: a 404 is
 * evidence about our URL, not about the core's authentication, and inferring
 * a security verdict from one is how v1.8.2 reported a correctly-secured core
 * as running wide open.
 */
export async function probeAuthedEndpoint({
  connectionURI, apiKey, fetchImpl = fetch, timeoutMs = 5000,
}) {
  const base = connectionURI.replace(/\/$/, '');
  const headers = { 'api-version': '3.0' };
  if (apiKey) headers['api-key'] = apiKey;

  for (const path of AUTHED_ENDPOINTS) {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetchImpl(`${base}${path}`, {
      method: 'GET', headers, signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 404) return { status: res.status, path };
  }
  return { status: null, path: null };
}

/** A refusal, however the core spells it. */
export function isRefused(status) {
  return status === 401 || status === 403;
}
