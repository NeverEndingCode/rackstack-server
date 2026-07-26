import express from 'express';
import passport from 'passport';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { configurePassport } from './auth.js';
import apiRouter from './routes/api.js';
import './db.js'; // ensures tables exist on boot

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Builds and returns a fully-configured Express app (middleware + routes +
 * static client + SPA fallback), without binding a port. Factored out of
 * index.js so tests can exercise the app with supertest directly.
 */
export function buildApp() {
  const app = express();

  configurePassport();
  app.use(passport.initialize());
  app.use(cookieParser());
  app.use(express.json({ limit: '256kb' }));

  app.use('/', apiRouter);

  // Serve the built client (client/dist, produced by `npm run build` in client/)
  const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(CLIENT_DIST));
  app.get('*', (req, res) => {
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });

  return app;
}
