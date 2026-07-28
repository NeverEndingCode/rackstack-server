import express from 'express';
import passport from 'passport';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  requireAuth, requireRole, issueToken, COOKIE_NAME,
  isOwner, getEffectiveRoles,
} from '../auth.js';
import {
  getUserById, getAllUsersWithSaves, getRoles, setRoles, setUsername,
  createMinigameSession, getMinigameSession, getOpenMinigameSession,
  finishMinigameSession, putSave,
} from '../db.js';
import { getConfig, updateConfig, rollbackConfig, getHistory } from '../configService.js';
import { loadAndEvaluate, loadEvaluateAndSchedule, applyActions } from '../stateService.js';
import { minigameWafers } from '../../shared/gameRules.js';
import { USERNAME_RE } from '../../shared/validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 90 * 24 * 3600 * 1000,
};

const MINIGAMES = ['rush', 'debug', 'match', 'balance'];

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
    roles: getEffectiveRoles(req.user.sub),
    isOwner: isOwner(req.user.sub),
  });
});

// ---------------------------------------------------------------------------
// State & actions (server-authoritative economy)
// ---------------------------------------------------------------------------

router.get('/api/state', requireAuth, (req, res) => {
  const now = Date.now();
  const { state, gained, activeEvent } = loadAndEvaluate(req.user.sub, now);
  const { version } = getConfig();
  res.json({
    run: state.run,
    meta: state.meta,
    server: state.server,
    offlineGain: gained,
    configVersion: version,
    serverTime: now,
    // Live Events (v1.4): a client-friendly view of the currently active
    // event (null when none) and this user's own progress against it -
    // eventProgress is also nested at state.meta.eventProgress (it's part
    // of canonical state), duplicated at the top level here purely for
    // client convenience (Task 7 reads both `activeEvent` and
    // `eventProgress` directly off this response).
    activeEvent: activeEvent ? {
      id: activeEvent.id,
      name: activeEvent.name,
      description: activeEvent.description,
      theme: activeEvent.theme,
      ladder: activeEvent.ladder,
      startsAt: activeEvent.starts_at,
      endsAt: activeEvent.ends_at,
    } : null,
    eventProgress: state.meta.eventProgress,
  });
});

router.post('/api/actions', requireAuth, (req, res) => {
  const { actions } = req.body || {};
  if (!Array.isArray(actions) || actions.length > 100) {
    return res.status(400).json({ error: 'actions must be an array of at most 100 items' });
  }
  const now = Date.now();
  const { state, results } = applyActions(req.user.sub, actions, now);
  res.json({ state, results, serverTime: now });
});

// ---------------------------------------------------------------------------
// Config (tunables) - read for everyone signed in, write for admins
// ---------------------------------------------------------------------------

router.get('/api/config', requireAuth, (req, res) => {
  const { version, data } = getConfig();
  res.json({ version, data });
});

router.put('/api/admin/config', requireAuth, requireRole('admin'), (req, res) => {
  const { data } = req.body || {};
  const result = updateConfig(data, req.user.sub);
  if (!result.ok) return res.status(400).json({ errors: result.errors });
  res.json({ version: result.version });
});

router.get('/api/admin/config/history', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ history: getHistory() });
});

router.post('/api/admin/config/rollback', requireAuth, requireRole('admin'), (req, res) => {
  const { version } = req.body || {};
  if (typeof version !== 'number') return res.status(400).json({ error: 'version required' });
  const result = rollbackConfig(version, req.user.sub);
  if (!result.ok) {
    return res.status(400).json(result.errors ? { errors: result.errors } : { error: result.error });
  }
  res.json({ version: result.version });
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

router.get('/api/admin/roles', requireAuth, requireRole('admin'), (req, res) => {
  const rows = getAllUsersWithSaves();
  const users = rows.map((row) => ({
    id: row.id,
    username: row.username,
    roles: getEffectiveRoles(row.id),
    isOwner: isOwner(row.id),
  }));
  res.json({ users });
});

// Granting/revoking 'admin' requires owner; 'event_coordinator' requires
// admin-or-owner (the requireRole('admin') gate below already covers that
// half - owner passes it too since 'admin' is one of an owner's effective
// roles). An owner id's own roles are env-derived, not DB-stored, so there
// is nothing to grant/revoke on them - reject outright.
router.post('/api/admin/roles', requireAuth, requireRole('admin'), (req, res) => {
  const { userId, role, op } = req.body || {};
  if (!userId || !['admin', 'event_coordinator'].includes(role) || !['grant', 'revoke'].includes(op)) {
    return res.status(400).json({ error: 'invalid_request' });
  }
  if (role === 'admin' && !isOwner(req.user.sub)) {
    return res.status(403).json({ error: 'owner_required' });
  }
  if (isOwner(userId)) {
    return res.status(400).json({ error: 'cannot_modify_owner' });
  }

  const current = new Set(getRoles(userId));
  if (op === 'grant') current.add(role); else current.delete(role);
  setRoles(userId, [...current]);
  res.json({ ok: true, roles: getEffectiveRoles(userId) });
});

// ---------------------------------------------------------------------------
// Username
// ---------------------------------------------------------------------------

router.put('/api/me/username', requireAuth, (req, res) => {
  const { username } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'invalid_username' });
  }
  const result = setUsername(req.user.sub, username);
  if (!result.ok) return res.status(409).json({ error: result.error });
  res.json({ ok: true, username });
});

// ---------------------------------------------------------------------------
// Minigames
// ---------------------------------------------------------------------------

router.post('/api/minigame/start', requireAuth, (req, res) => {
  const { game } = req.body || {};
  if (!MINIGAMES.includes(game)) return res.status(400).json({ error: 'unknown_game' });

  const now = Date.now();
  const { state } = loadAndEvaluate(req.user.sub, now);
  const cooldownUntil = state.server.gameCooldowns[game] || 0;
  if (now < cooldownUntil) {
    return res.status(429).json({ error: 'cooldown_active', retryAt: cooldownUntil });
  }

  // Block a second concurrently-open session for the same game: without
  // this, a burst of back-to-back starts (none finished yet, so none has
  // set the cooldown) could each be redeemed independently once opened,
  // multiplying payouts far past the intended ~1 win per winCooldownMs.
  const { data: config } = getConfig();
  const gameConf = config.minigames[game];
  const minStartedAt = now - (gameConf.durationSec * 1000 + 10000);
  const openSession = getOpenMinigameSession(req.user.sub, game, minStartedAt);
  if (openSession) {
    return res.status(409).json({ error: 'session_open' });
  }

  const session = createMinigameSession(req.user.sub, game);
  res.json({ sessionId: session.id });
});

router.post('/api/minigame/finish', requireAuth, (req, res) => {
  const { sessionId, metric } = req.body || {};
  if (typeof metric !== 'number' || !Number.isFinite(metric)) {
    return res.status(400).json({ error: 'invalid_metric' });
  }

  const session = getMinigameSession(sessionId);
  if (!session || session.user_id !== req.user.sub) return res.status(404).json({ error: 'not_found' });
  if (session.finished_at !== null) return res.status(410).json({ error: 'gone' });

  const now = Date.now();
  const { data: config } = getConfig();
  const gameConf = config.minigames[session.game];
  const windowEnd = session.started_at + gameConf.durationSec * 1000 + 10000;
  if (now > windowEnd) return res.status(410).json({ error: 'gone' });

  let clamped;
  let won = true;
  if (session.game === 'rush') {
    clamped = Math.min(metric, gameConf.durationSec * gameConf.maxTapsPerSec);
  } else if (session.game === 'debug') {
    clamped = Math.min(metric, (gameConf.durationSec * 1000) / gameConf.spawnMinMs);
  } else if (session.game === 'match') {
    clamped = Math.min(metric, gameConf.pairCount);
    won = clamped === gameConf.pairCount;
  } else {
    // balance
    clamped = Math.min(metric, gameConf.maxScore);
  }
  clamped = Math.max(0, clamped);

  // Single load+evaluate (not persisted yet) so wafer/stat/cooldown
  // mutations below land in one putSave, matching applyActions' pattern.
  const { state } = loadEvaluateAndSchedule(req.user.sub, now);

  // Re-check the cooldown against the freshly-evaluated state, not just at
  // start time: a burst of sessions opened concurrently for the same game
  // (each individually valid when it was opened) must not all be redeemable
  // once the first win of the batch sets the cooldown. The session is still
  // marked finished below either way, so a blocked attempt can't be replayed.
  const cooldownUntil = state.server.gameCooldowns[session.game] || 0;
  const onCooldown = now < cooldownUntil;
  const wafers = !onCooldown && won ? minigameWafers(session.game, clamped, state.meta, config) : 0;

  if (wafers > 0) {
    state.meta.wafers += wafers;
    state.meta.stats.minigamesWon += 1;
    state.meta.stats.totalWafersEarned += wafers;
    state.server.gameCooldowns[session.game] = now + config.minigames.winCooldownMs;
  }

  putSave(req.user.sub, state, now);
  finishMinigameSession(sessionId, clamped);

  if (onCooldown) {
    return res.status(429).json({ error: 'cooldown_active' });
  }
  res.json({ state, wafers });
});

// ---------------------------------------------------------------------------
// Changelog
// ---------------------------------------------------------------------------

router.get('/api/changelog', requireAuth, (req, res) => {
  const changelogPath = path.join(__dirname, '..', '..', 'CHANGELOG.md');
  fs.readFile(changelogPath, 'utf8', (err, data) => {
    res.type('text/plain');
    if (err) return res.status(200).send('No changelog available.');
    res.status(200).send(data);
  });
});

// ---------------------------------------------------------------------------
// Admin: users list
// ---------------------------------------------------------------------------

// Lists every user and their save stats. Gated on the requireRole('admin')
// middleware - never a client-trusted flag - re-checked on every request.
router.get('/api/admin/users', requireAuth, requireRole('admin'), (req, res) => {
  const rows = getAllUsersWithSaves();
  const users = rows.map((row) => {
    let meta = null;
    if (row.data) {
      try {
        meta = JSON.parse(row.data).meta || null;
      } catch (e) {
        meta = null;
      }
    }
    return {
      id: row.id,
      provider: row.provider,
      username: row.username,
      avatarUrl: row.avatar_url,
      createdAt: row.created_at,
      lastSave: row.last_save || null,
      level: meta ? meta.level : null,
      xp: meta ? meta.xp : null,
      wafers: meta ? meta.wafers : null,
      legacyCores: meta ? meta.legacyCores : null,
      singularityShards: meta ? meta.singularityShards : null,
      stats: meta ? meta.stats : null,
    };
  });
  res.json({ users });
});

export default router;
