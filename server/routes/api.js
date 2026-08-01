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
  listEvents, getEvent, getActiveEvent, putEvent, setEventStatus, deleteEvent,
  listParticipation, listLeaderboard, setLeaderboardOptOut,
  getToursCompleted, setToursCompleted,
} from '../db.js';
import {
  getConfig, getEffectiveConfig, updateConfig, rollbackConfig, getHistory, invalidateEffectiveConfig,
} from '../configService.js';
import {
  activateEvent, endEvent, resolvePlayerEvents, inClaimGrace,
} from '../eventService.js';
import { loadAndEvaluate, loadEvaluateAndSchedule, applyActions } from '../stateService.js';
import { getLeaderboards, invalidateLeaderboards } from '../leaderboardService.js';
import { minigameWafers } from '../../shared/gameRules.js';
import { USERNAME_RE } from '../../shared/validation.js';
import {
  validateModifiers, validateLadder, validateRecurrence, rungProgress,
} from '../../shared/events.js';
import { TOUR_IDS, ONBOARDING_TOUR_ID, isValidTourId } from '../../shared/tours.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 90 * 24 * 3600 * 1000,
};

const MINIGAMES = ['rush', 'debug', 'match', 'balance'];

// Event ids are coordinator-authored slugs (matches the seeded seasonal
// events' style, e.g. 'summer-surge') - lowercase alphanumerics, hyphen-
// separated, no leading/trailing/doubled hyphens.
const EVENT_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
function isValidEventSlug(id) {
  return typeof id === 'string' && id.length >= 3 && id.length <= 60 && EVENT_SLUG_RE.test(id);
}

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

router.get('/api/me', requireAuth, async (req, res, next) => {
  try {
    const dbUser = await getUserById(req.user.sub);
    res.json({
      id: req.user.sub,
      username: req.user.username,
      avatarUrl: req.user.avatarUrl,
      memberSince: dbUser ? dbUser.created_at : null,
      roles: await getEffectiveRoles(req.user.sub),
      isOwner: isOwner(req.user.sub),
      toursCompleted: await getToursCompleted(req.user.sub),
    });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// State & actions (server-authoritative economy)
// ---------------------------------------------------------------------------

router.get('/api/state', requireAuth, async (req, res, next) => {
  try {
    const now = Date.now();
    const { state, gained, activeEvent, unlockedAchievements } = await loadAndEvaluate(req.user.sub, now);
    const { version } = await getConfig();
    const { current } = await resolvePlayerEvents(state);
    const claimable = current && inClaimGrace(current.progress, now) ? current.event : null;
    res.json({
      run: state.run,
      meta: state.meta,
      server: state.server,
      offlineGain: gained,
      configVersion: version,
      serverTime: now,
      // The event THIS player can still see/claim against, which is not the
      // same thing as `activeEvent` below: `activeEvent` is the globally
      // active row and goes null the instant an event ends, while a player's
      // own 48h claim grace (spec §5.3) can outlive that by two days.
      // Resolved from their own meta.eventProgress, so the client can seed its
      // ladder from a page load made entirely within grace - previously the
      // ladder existed only in memory and a single reload stranded every
      // outstanding Claim button.
      claimableEvent: claimable ? {
        id: claimable.id,
        name: claimable.name,
        description: claimable.description,
        theme: claimable.theme,
        ladder: claimable.ladder,
        startsAt: claimable.starts_at,
        endsAt: claimable.ends_at,
      } : null,
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
      // Social (v1.5): achievements the load-path sweep unlocked on THIS
      // request - typically thresholds crossed by offline accrual since the
      // player was last seen. The client toasts them; meta.achievements above
      // is the durable record either way.
      unlockedAchievements,
    });
  } catch (e) { next(e); }
});

router.post('/api/actions', requireAuth, async (req, res, next) => {
  try {
    const { actions } = req.body || {};
    if (!Array.isArray(actions) || actions.length > 100) {
      return res.status(400).json({ error: 'actions must be an array of at most 100 items' });
    }
    const now = Date.now();
    const { state, results, unlockedAchievements } = await applyActions(req.user.sub, actions, now);
    res.json({ state, results, serverTime: now, unlockedAchievements });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Config (tunables) - read for everyone signed in, write for admins
// ---------------------------------------------------------------------------

// The GAMEPLAY config read. Serves getEffectiveConfig() - the admin baseline
// with the currently active event's modifiers merged on top - because that is
// what the server itself evaluates with (stateService.loadEvaluateAndSchedule).
// Serving the un-overlaid baseline here meant the client ran the entire game
// on different numbers than the server: with a gridMult:3 event live the
// headline rate stayed at the baseline and every reconcile snapped the
// counter forward, and - far worse - Summer Surge's shipped
// `heat.capacity: 4000` modifier made the client cross ITS 2000-heat cap and
// pop the "Overheated!" meltdown modal, freezing the overclock lane locally,
// while the server considered the rack perfectly healthy.
//
// Admin tooling must NOT read this route: AdminBalancing PUTs back whatever
// document it loaded, so an admin save while an event was active would bake
// that event's modifiers into the STORED config permanently. GET
// /api/admin/config below is the baseline read, and is what the Balancing tab
// loads and writes against.
//
// `activeEventId` is the missing half of the client's cache key: the config
// VERSION does not change when an event flips active/ended, so a client
// watching `version` alone would never notice the overlay appearing or
// disappearing underneath it.
router.get('/api/config', requireAuth, async (req, res, next) => {
  try {
    const { version, data, eventId } = await getEffectiveConfig();
    res.json({ version, activeEventId: eventId, data: stripRuntimeFields(data) });
  } catch (e) { next(e); }
});

// Runtime-only fields (`__activeEvent`, and anything else prefixed `__`) are
// attached to the effective config for the reducer's benefit and are not part
// of the tunables schema - validateConfig() rejects them, and the client has
// no use for them. Strips them onto a shallow copy; the source object is
// configService's shared cache and must never be mutated here.
function stripRuntimeFields(data) {
  const out = {};
  for (const key of Object.keys(data)) {
    if (key.startsWith('__')) continue;
    out[key] = data[key];
  }
  return out;
}

// The admin BASELINE read: getConfig(), never the event overlay. This is the
// document the Balancing tab edits and PUTs back to /api/admin/config, so it
// has to be the stored, admin-authored one - the stored config document is
// never written with event modifiers merged in.
router.get('/api/admin/config', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { version, data } = await getConfig();
    res.json({ version, data });
  } catch (e) { next(e); }
});

router.put('/api/admin/config', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { data } = req.body || {};
    const result = await updateConfig(data, req.user.sub);
    if (!result.ok) return res.status(400).json({ errors: result.errors });
    res.json({ version: result.version });
  } catch (e) { next(e); }
});

router.get('/api/admin/config/history', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    res.json({ history: await getHistory() });
  } catch (e) { next(e); }
});

router.post('/api/admin/config/rollback', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const { version } = req.body || {};
    if (typeof version !== 'number') return res.status(400).json({ error: 'version required' });
    const result = await rollbackConfig(version, req.user.sub);
    if (!result.ok) {
      return res.status(400).json(result.errors ? { errors: result.errors } : { error: result.error });
    }
    res.json({ version: result.version });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

router.get('/api/admin/roles', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await getAllUsersWithSaves();
    const users = await Promise.all(rows.map(async (row) => ({
      id: row.id,
      username: row.username,
      roles: await getEffectiveRoles(row.id),
      isOwner: isOwner(row.id),
    })));
    res.json({ users });
  } catch (e) { next(e); }
});

// Granting/revoking 'admin' requires owner; 'event_coordinator' requires
// admin-or-owner (the requireRole('admin') gate below already covers that
// half - owner passes it too since 'admin' is one of an owner's effective
// roles). An owner id's own roles are env-derived, not DB-stored, so there
// is nothing to grant/revoke on them - reject outright.
router.post('/api/admin/roles', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
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

    const current = new Set(await getRoles(userId));
    if (op === 'grant') current.add(role); else current.delete(role);
    await setRoles(userId, [...current]);
    res.json({ ok: true, roles: await getEffectiveRoles(userId) });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Username
// ---------------------------------------------------------------------------

router.put('/api/me/username', requireAuth, async (req, res, next) => {
  try {
    const { username } = req.body || {};
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'invalid_username' });
    }
    const result = await setUsername(req.user.sub, username);
    if (!result.ok) return res.status(409).json({ error: result.error });
    res.json({ ok: true, username });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Minigames
// ---------------------------------------------------------------------------

router.post('/api/minigame/start', requireAuth, async (req, res, next) => {
  try {
    const { game } = req.body || {};
    if (!MINIGAMES.includes(game)) return res.status(400).json({ error: 'unknown_game' });

    const now = Date.now();
    const { state } = await loadAndEvaluate(req.user.sub, now);
    const cooldownUntil = state.server.gameCooldowns[game] || 0;
    if (now < cooldownUntil) {
      return res.status(429).json({ error: 'cooldown_active', retryAt: cooldownUntil });
    }

    // Block a second concurrently-open session for the same game: without
    // this, a burst of back-to-back starts (none finished yet, so none has
    // set the cooldown) could each be redeemed independently once opened,
    // multiplying payouts far past the intended ~1 win per winCooldownMs.
    const { data: config } = await getConfig();
    const gameConf = config.minigames[game];
    const minStartedAt = now - (gameConf.durationSec * 1000 + 10000);
    const openSession = await getOpenMinigameSession(req.user.sub, game, minStartedAt);
    if (openSession) {
      return res.status(409).json({ error: 'session_open' });
    }

    const session = await createMinigameSession(req.user.sub, game);
    res.json({ sessionId: session.id });
  } catch (e) { next(e); }
});

router.post('/api/minigame/finish', requireAuth, async (req, res, next) => {
  try {
    const { sessionId, metric } = req.body || {};
    if (typeof metric !== 'number' || !Number.isFinite(metric)) {
      return res.status(400).json({ error: 'invalid_metric' });
    }

    const session = await getMinigameSession(sessionId);
    if (!session || session.user_id !== req.user.sub) return res.status(404).json({ error: 'not_found' });
    if (session.finished_at !== null) return res.status(410).json({ error: 'gone' });

    const now = Date.now();
    const { data: config } = await getConfig();
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
    const { state } = await loadEvaluateAndSchedule(req.user.sub, now);

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

    await putSave(req.user.sub, state, now);
    await finishMinigameSession(sessionId, clamped);

    if (onCooldown) {
      return res.status(429).json({ error: 'cooldown_active' });
    }
    res.json({ state, wafers });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Live Events (v1.4)
// ---------------------------------------------------------------------------

// Player-facing view of the currently active event (null if none), this
// user's own progress against it, and the (opt-out-filtered) leaderboard.
// Reuses loadAndEvaluate - same join-on-login path GET /api/state drives -
// so hitting this route on its own is enough to join a freshly-activated
// event, exactly like GET /api/state.
function eventView(event) {
  return {
    id: event.id,
    name: event.name,
    description: event.description,
    theme: event.theme,
    ladder: event.ladder,
  };
}

function progressView(event, progress, meta) {
  const ladder = Array.isArray(event.ladder) ? event.ladder : [];
  return {
    joinedAt: progress.joinedAt,
    endsAt: progress.endsAt,
    rungsClaimed: progress.rungsClaimed,
    // Superseded windows render their FROZEN set (see supersedeEventProgress),
    // not a ladder still climbing against live meta - otherwise the UI offers
    // Claim buttons the reducer will reject with not_met.
    rungs: ladder.map((rung, i) => {
      const live = rungProgress(rung, meta, progress.baseline);
      const frozen = Array.isArray(progress.claimableRungs);
      return {
        ...live,
        met: frozen ? progress.claimableRungs.includes(i) : live.met,
        claimed: progress.rungsClaimed.includes(i),
      };
    }),
  };
}

router.get('/api/event', requireAuth, async (req, res, next) => {
  try {
    const now = Date.now();
    const { state } = await loadAndEvaluate(req.user.sub, now);

    // Resolved from the PLAYER's own save, not from getActiveEvent(). Gating
    // this route on "is an event globally active" is what made spec §5.3's 48h
    // claim grace unreachable: the response flipped to event:null the instant
    // the event ended globally, and since the client's only copy of the ladder
    // was in-memory React state seeded at boot, a player who closed the tab and
    // reopened it inside their grace window got no ladder and no Claim buttons
    // at all - their rewards expired unclaimable - even though posting the
    // identical claim straight to /api/actions still succeeded.
    const { current, pending } = await resolvePlayerEvents(state);
    const live = current && inClaimGrace(current.progress, now) ? current : null;

    // Windows force-ended early by a newer event activating, still inside
    // their own grace (spec §5.2 ends the window, §5.3 keeps the claim open).
    const pendingClaims = pending
      .filter((p) => inClaimGrace(p.progress, now))
      .map((p) => ({ event: eventView(p.event), progress: progressView(p.event, p.progress, state.meta) }));

    if (!live) {
      return res.json({ event: null, progress: null, leaderboard: [], pendingClaims });
    }

    res.json({
      event: eventView(live.event),
      progress: progressView(live.event, live.progress, state.meta),
      // Hard requirement 1 (Task 4 review carry-forward): listLeaderboard
      // live-joins users.leaderboard_opt_out rather than trusting
      // event_participation.opted_out's join-time snapshot, so a user who
      // opts out after joining disappears from this list immediately.
      leaderboard: await listLeaderboard(live.event.id, 50),
      pendingClaims,
    });
  } catch (e) { next(e); }
});

// Mirrors the opt-out to the durable users.leaderboard_opt_out column (the
// column listLeaderboard above actually filters on - hard requirement 1),
// and also replays it through the normal action path so
// meta.leaderboardOptOut (client-display-only, shared/reducer.js) stays in
// sync without a second client round trip.
router.put('/api/me/leaderboard-opt-out', requireAuth, async (req, res, next) => {
  try {
    const { optOut } = req.body || {};
    if (typeof optOut !== 'boolean') return res.status(400).json({ error: 'invalid_request' });

    await setLeaderboardOptOut(req.user.sub, optOut);
    await applyActions(req.user.sub, [{ type: 'setLeaderboardOptOut', optOut }], Date.now());

    // v1.5: the global boards are served from a ~60s in-memory cache, so
    // without this a player who just asked to be hidden would keep appearing on
    // them for up to a minute. The per-event leaderboard has always been
    // immediate (it live-joins users.leaderboard_opt_out on every read - v1.4's
    // "hard requirement 1"), and this control must not quietly mean something
    // weaker just because the newer boards are cache-fronted. Opting out is a
    // deliberate, low-frequency action, so paying for one rebuild is free.
    invalidateLeaderboards();

    res.json({ ok: true, optOut });
  } catch (e) { next(e); }
});

// v1.6 guided tours. A pure UI preference: unlike the leaderboard opt-out
// above it is NOT mirrored into the save document and has no reducer action,
// because it has no game-state implications.
//
// `completed: false` is the replay path (Profile -> Tutorials -> Replay).
// Ids the current build doesn't know about are preserved rather than dropped:
// a rolled-back deployment must not erase a completion recorded by a newer one.
router.put('/api/me/tours', requireAuth, async (req, res, next) => {
  try {
    const { tourId, completed } = req.body || {};
    if (!isValidTourId(tourId) || typeof completed !== 'boolean') {
      return res.status(400).json({ error: 'invalid_request' });
    }

    const current = new Set(await getToursCompleted(req.user.sub));
    if (completed) {
      // Spec §4.7: onboarding is always a superset of the feature tours, so
      // finishing (or skipping) it clears the whole queue.
      if (tourId === ONBOARDING_TOUR_ID) for (const id of TOUR_IDS) current.add(id);
      else current.add(tourId);
    } else {
      current.delete(tourId);
    }

    const toursCompleted = [...current];
    await setToursCompleted(req.user.sub, toursCompleted);
    res.json({ ok: true, toursCompleted });
  } catch (e) { next(e); }
});

// --- Coordinator CRUD (requireRole('event_coordinator') - 'admin' implies
// it via getEffectiveRoles, owners hold every role) -------------------------

router.get('/api/admin/events', requireAuth, requireRole('event_coordinator'), async (req, res, next) => {
  try {
    const events = await Promise.all((await listEvents()).map(async (event) => ({
      ...event,
      participationCount: (await listParticipation(event.id)).length,
    })));
    res.json({ events });
  } catch (e) { next(e); }
});

router.post('/api/admin/events', requireAuth, requireRole('event_coordinator'), async (req, res, next) => {
  try {
    const {
      id, name, description, theme, modifiers = [], ladder, recurrence,
    } = req.body || {};

    if (!isValidEventSlug(id)) {
      return res.status(400).json({ errors: ['id must be a 3-60 char lowercase, hyphen-separated slug'] });
    }
    if (await getEvent(id)) return res.status(409).json({ error: 'id_taken' });
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ errors: ['name is required'] });
    }

    const modResult = validateModifiers(modifiers);
    if (!modResult.ok) return res.status(400).json({ errors: modResult.errors });
    const ladderResult = validateLadder(ladder);
    if (!ladderResult.ok) return res.status(400).json({ errors: ladderResult.errors });
    // An unvalidated recurrence is not merely cosmetic: `{}` or `"weekly"`
    // makes the scheduler materialize a NaN window, promoting the event to
    // 'scheduled' with no usable window and no way out (DELETE is draft-only,
    // activate answers not_scheduled), and `durationDays: -5` materializes
    // endsAt < startsAt, handing every joiner an instantly-expired personal
    // window. Both are permanent, both are silent.
    const recurrenceResult = validateRecurrence(recurrence);
    if (!recurrenceResult.ok) return res.status(400).json({ errors: recurrenceResult.errors });

    const event = await putEvent({
      id,
      name,
      description: description ?? null,
      theme: theme ?? null,
      modifiers,
      ladder,
      status: 'draft',
      recurrence: recurrence ?? null,
      createdAt: Date.now(),
      createdBy: req.user.sub,
    });
    res.status(201).json({ event });
  } catch (e) { next(e); }
});

// Name/description/theme/window edits are always allowed. ladder/modifiers
// edits are rejected outright (409) while the event is active - mutating
// either mid-run would invalidate every participant's already-claimed
// rungsClaimed indices (ladder) or silently reshape the effective config
// underneath an in-progress run (modifiers). Drafts/scheduled/ended events
// may have their ladder/modifiers freely edited.
router.put('/api/admin/events/:id', requireAuth, requireRole('event_coordinator'), async (req, res, next) => {
  try {
    const existing = await getEvent(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });

    const body = req.body || {};
    const touchesLadderOrModifiers = Object.prototype.hasOwnProperty.call(body, 'ladder')
      || Object.prototype.hasOwnProperty.call(body, 'modifiers');
    if (existing.status === 'active' && touchesLadderOrModifiers) {
      return res.status(409).json({ error: 'event_active' });
    }

    const next = {
      ...existing,
      name: body.name !== undefined ? body.name : existing.name,
      description: body.description !== undefined ? body.description : existing.description,
      theme: body.theme !== undefined ? body.theme : existing.theme,
      modifiers: body.modifiers !== undefined ? body.modifiers : existing.modifiers,
      ladder: body.ladder !== undefined ? body.ladder : existing.ladder,
      startsAt: body.startsAt !== undefined ? body.startsAt : existing.starts_at,
      endsAt: body.endsAt !== undefined ? body.endsAt : existing.ends_at,
    };

    if (typeof next.name !== 'string' || !next.name.trim()) {
      return res.status(400).json({ errors: ['name is required'] });
    }
    const modResult = validateModifiers(next.modifiers);
    if (!modResult.ok) return res.status(400).json({ errors: modResult.errors });
    const ladderResult = validateLadder(next.ladder);
    if (!ladderResult.ok) return res.status(400).json({ errors: ladderResult.errors });
    if (typeof next.startsAt === 'number' && typeof next.endsAt === 'number' && next.endsAt <= next.startsAt) {
      return res.status(400).json({ errors: ['endsAt must be after startsAt'] });
    }

    const saved = await putEvent({ ...next, id: existing.id, status: existing.status });

    // Hard requirement 3 (Task 4 review carry-forward): getEffectiveConfig()
    // caches on (configVersion, activeEventId) - editing the CONTENTS of the
    // currently-active event (window, name, ...) doesn't change that cache
    // key, so without an explicit invalidation the cached
    // config.__activeEvent.endsAt (read by claimEventRung's 48h grace math)
    // would go stale. Called on every successful edit of an active event, not
    // just window edits, in case a future field gets added to __activeEvent.
    if (existing.status === 'active') {
      invalidateEffectiveConfig();
    }

    res.json({ event: saved });
  } catch (e) { next(e); }
});

// Drafts only - a scheduled/active/ended event may already have
// participation rows and/or client-visible history, so it's ended (or left
// alone), never deleted.
router.delete('/api/admin/events/:id', requireAuth, requireRole('event_coordinator'), async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'not_found' });
    if (event.status !== 'draft') return res.status(409).json({ error: 'not_draft' });
    await deleteEvent(event.id);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post('/api/admin/events/:id/schedule', requireAuth, requireRole('event_coordinator'), async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'not_found' });
    if (event.status === 'active') return res.status(409).json({ error: 'event_active' });

    const { startsAt, endsAt } = req.body || {};
    if (typeof startsAt !== 'number' || typeof endsAt !== 'number' || endsAt <= startsAt) {
      return res.status(400).json({ error: 'invalid_request' });
    }

    await setEventStatus(event.id, 'scheduled', { startsAt, endsAt });
    res.json({ event: await getEvent(event.id) });
  } catch (e) { next(e); }
});

router.post('/api/admin/events/:id/activate', requireAuth, requireRole('event_coordinator'), async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'not_found' });

    // Per spec: activating while a DIFFERENT event is already active must be
    // rejected outright - the coordinator has to explicitly end it first.
    // (eventService.activateEvent itself does NOT enforce this - it happily
    // ends every other active row, because the scheduler also calls it and
    // needs that behavior. This UX/permission check is this route's job.)
    const active = await getActiveEvent();
    if (active && active.id !== event.id) {
      return res.status(409).json({ error: 'event_active' });
    }

    if (event.ends_at == null) return res.status(400).json({ error: 'not_scheduled' });

    // Hard requirement 2 (Task 4 review carry-forward): activating an event
    // whose stored window has already fully passed would hand
    // joinEventIfEligible's `endsAt = min(now + duration, ends_at + 24h)` math
    // a value before `now`, silently giving a new joiner an already-expired
    // personal window. Chosen fix: reject outright rather than shifting the
    // window forward - the coordinator-authored dates stay authoritative and
    // are never silently rewritten by an activate call; to proceed they
    // re-schedule (POST .../schedule) with a fresh window, then activate.
    const now = Date.now();
    if (event.ends_at <= now) return res.status(400).json({ error: 'invalid_target' });

    const result = await activateEvent(event.id, now);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ event: await getEvent(event.id) });
  } catch (e) { next(e); }
});

router.post('/api/admin/events/:id/end', requireAuth, requireRole('event_coordinator'), async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'not_found' });
    const result = await endEvent(event.id, Date.now());
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ event: await getEvent(event.id) });
  } catch (e) { next(e); }
});

router.get('/api/admin/events/:id/participation', requireAuth, requireRole('event_coordinator'), async (req, res, next) => {
  try {
    const event = await getEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'not_found' });
    res.json({ participation: await listParticipation(event.id) });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Leaderboards (v1.5)
// ---------------------------------------------------------------------------

// Every board at once, already ranked, opt-out-filtered and capped
// server-side. The payload is a single shared in-memory cache
// (server/leaderboardService.js), so this is cheap to poll - the client
// throttles it anyway. Respects users.leaderboard_opt_out, the same live
// column the per-event leaderboard filters on.
router.get('/api/leaderboard', requireAuth, async (req, res, next) => {
  try {
    const { generatedAt, boards } = await getLeaderboards(Date.now());
    res.json({ generatedAt, boards });
  } catch (e) { next(e); }
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
router.get('/api/admin/users', requireAuth, requireRole('admin'), async (req, res, next) => {
  try {
    const rows = await getAllUsersWithSaves();
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
  } catch (e) { next(e); }
});

export default router;
