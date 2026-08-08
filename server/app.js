import express from 'express';
import passport from 'passport';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { configurePassport } from './auth.js';
import { resolveAuthMode, isSuperTokensEnabled } from './authMode.js';
import { initSuperTokens } from './supertokens/init.js';
import apiRouter from './routes/api.js';
import { createAuthRouter } from './routes/authRoutes.js';
import './db.js'; // ensures tables exist on boot

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * The SuperTokens endpoints RackStack actually uses.
 *
 * Exact paths (or a prefix, for the provider callbacks), relative to the
 * `/auth` API base path.
 */
export const SUPERTOKENS_ALLOWED_PATHS = Object.freeze([
  '/auth/authorisationurl', // start a third-party login
  '/auth/signinup', //         complete it (redirect flow only - see rejectRawOAuthTokens)
  '/auth/session/refresh', //  renew an access token
]);
const SUPERTOKENS_ALLOWED_PREFIXES = Object.freeze([
  '/auth/callback/', //        the provider redirect target, e.g. /auth/callback/github
]);

/**
 * Lets SuperTokens' middleware see ONLY the endpoints we use, and 404s the
 * rest of its surface.
 *
 * An allowlist rather than a denylist, because the surface is not what
 * `recipeList` implies. `supertokens.init()` auto-adds multitenancy,
 * usermetadata, oauth2provider, openid, jwt and accountlinking alongside the
 * two recipes we ask for - 13 extra live endpoints. Two of them mattered:
 *
 *   - `POST /auth/oauth/logout` revokes the session BEFORE validating its
 *     challenge, so an authenticated call with any value kills the SuperTokens
 *     session and leaves the legacy JWT cookie behind - `requireAuth` then
 *     re-authenticates the "logged out" user. That is the exact half-logout
 *     `disableStockSignOut` was written to close, reached by a second door.
 *   - `GET /auth/.well-known/openid-configuration` answered unauthenticated,
 *     advertising RackStack as an OAuth2 authorization server it has no
 *     intention of being.
 *
 * Disabling them one by one is whack-a-mole against a dependency that adds
 * endpoints on its own schedule; the next `supertokens-node` minor could add
 * another and nothing here would notice. An allowlist fails closed instead: a
 * new endpoint is simply not reachable until someone adds it here on purpose.
 *
 * Non-matching paths call `next()` rather than responding, so our own
 * `/auth/github`, `/auth/discord`, the passport callbacks and `/auth/logout`
 * (registered later, in authRoutes.js) still work, and anything else falls
 * through to the SPA exactly as it did before v1.8.
 */
export function gateSuperTokensPaths(supertokensMiddleware) {
  return function supertokensGate(req, res, next) {
    const path = req.path;
    const allowed = SUPERTOKENS_ALLOWED_PATHS.includes(path)
      || SUPERTOKENS_ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
    if (!allowed) return next();
    return supertokensMiddleware(req, res, next);
  };
}

/**
 * Builds and returns a fully-configured Express app (middleware + routes +
 * static client + SPA fallback), without binding a port. Factored out of
 * index.js so tests can exercise the app with supertest directly.
 *
 * Async since v1.8: SuperTokens' middleware can only be mounted after
 * supertokens.init() has run, and init imports the SDK dynamically so that
 * the default `passport` mode never loads it. In `passport` mode this
 * function does exactly what it did before - same middleware, same order,
 * nothing extra on the stack.
 */
export async function buildApp({ env = process.env } = {}) {
  const app = express();
  const mode = resolveAuthMode(env);

  configurePassport();
  app.use(passport.initialize());
  app.use(cookieParser());
  app.use(express.json({ limit: '256kb' }));

  // SuperTokens' middleware must sit BEFORE the API router: it serves the
  // /auth/* endpoints (including the OAuth callbacks) that the router would
  // otherwise fall through on, and it is what populates the session the auth
  // chain reads. Its errorHandler goes after the router, below.
  if (isSuperTokensEnabled(mode)) {
    await initSuperTokens({ env, mode });
    const { middleware } = await import('supertokens-node/framework/express');
    app.use(gateSuperTokensPaths(middleware()));
  }

  // Built per app rather than imported as a singleton: these are the only
  // routes whose registration depends on the mode, so two apps built in the
  // same process with different modes must not share them.
  app.use('/', createAuthRouter({ mode }));
  app.use('/', apiRouter);

  if (isSuperTokensEnabled(mode)) {
    // Translates SuperTokens' own errors (expired session, unauthorised,
    // token theft) into its documented responses. Registered after the
    // router so it only sees what the router did not handle, and never in
    // passport mode - where an extra error handler on the stack could change
    // how existing errors surface.
    const { errorHandler } = await import('supertokens-node/framework/express');
    app.use(errorHandler());
  }

  // Serve the built client (client/dist, produced by `npm run build` in client/)
  const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(CLIENT_DIST));
  app.get('*', (req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });

  return app;
}
