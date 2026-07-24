import 'dotenv/config';
import express from 'express';
import passport from 'passport';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { configurePassport } from './auth.js';
import apiRouter from './routes/api.js';
import './db.js'; // ensures tables exist on boot

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RACKSTACK server listening on :${PORT}`);
});
