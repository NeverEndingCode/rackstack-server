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
    app.use(middleware());
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
