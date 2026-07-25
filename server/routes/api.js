import express from 'express';
import passport from 'passport';
import { requireAuth, issueToken, COOKIE_NAME } from '../auth.js';
import { getSave, putSave, deleteSave, getUserById } from '../db.js';
import { applyOfflineProgress } from '../gameLogic.js';

const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 90 * 24 * 3600 * 1000,
};

function finishLogin(req, res) {
  const token = issueToken(req.user);
  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
  res.redirect('/');
}

router.get('/auth/discord', passport.authenticate('discord', { session: false }));
router.get(
  '/auth/discord/callback',
  passport.authenticate('discord', { session: false, failureRedirect: '/?authError=discord' }),
  finishLogin,
);

router.get('/auth/github', passport.authenticate('github', { session: false }));
router.get(
  '/auth/github/callback',
  passport.authenticate('github', { session: false, failureRedirect: '/?authError=github' }),
  finishLogin,
);

router.post('/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/api/me', requireAuth, (req, res) => {
  const dbUser = getUserById(req.user.sub);
  res.json({
    id: req.user.sub,
    username: req.user.username,
    avatarUrl: req.user.avatarUrl,
    memberSince: dbUser ? dbUser.created_at : null,
  });
});

// Loads the save, applies any offline production since last_save (capped at
// 72h server-side), persists the caught-up state, and returns it.
router.get('/api/save', requireAuth, (req, res) => {
  const row = getSave(req.user.sub);
  if (!row) {
    return res.json({ run: null, meta: null, offlineGain: 0 });
  }
  let saved;
  try {
    saved = JSON.parse(row.data);
  } catch (e) {
    return res.status(500).json({ error: 'corrupt save' });
  }
  const now = Date.now();
  const { run: newRun, gained } = applyOfflineProgress(saved.run, saved.meta, row.last_save, now);
  putSave(req.user.sub, { run: newRun, meta: saved.meta }, now);
  res.json({ run: newRun, meta: saved.meta, offlineGain: gained });
});

router.post('/api/save', requireAuth, (req, res) => {
  const { run, meta } = req.body || {};
  if (!run || !meta) return res.status(400).json({ error: 'run and meta are required' });
  putSave(req.user.sub, { run, meta }, Date.now());
  res.json({ ok: true });
});

router.delete('/api/save', requireAuth, (req, res) => {
  deleteSave(req.user.sub);
  res.json({ ok: true });
});

export default router;
