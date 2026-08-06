import passport from 'passport';
import { Strategy as DiscordStrategy } from 'passport-discord';
import { Strategy as GitHubStrategy } from 'passport-github2';
import jwt from 'jsonwebtoken';
import { upsertUser, getRoles, getUserById } from './db.js';
import { isSuperTokensReady, loadSessionRecipe } from './supertokens/init.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required. Generate one with: openssl rand -hex 32');
}

export const COOKIE_NAME = 'rackstack_token';

// Env-derived super-admins: comma-separated user ids (e.g. "github:37058311").
// Owners implicitly hold every role, regardless of what's stored in the DB,
// and their own role set can never be edited through the roles API (there's
// nothing to edit - it's derived from this env var, not the `roles` column).
export const SUPER_ADMIN_IDS = (process.env.SUPER_ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function isOwner(id) {
  return SUPER_ADMIN_IDS.includes(id);
}

/**
 * Effective roles for `id`: an owner holds every role outright. Otherwise
 * the DB-stored roles, with 'admin' implying 'event_coordinator' (admin is
 * a superset - we don't require both to be granted separately).
 */
export async function getEffectiveRoles(id) {
  if (isOwner(id)) return ['admin', 'event_coordinator'];
  const stored = await getRoles(id);
  const effective = new Set(stored);
  if (effective.has('admin')) effective.add('event_coordinator');
  return [...effective];
}

/**
 * Express middleware factory: 403s unless the requester's effective roles
 * include `role`. Always re-derived from the DB (and env for ownership) on
 * every request - never trusted from the client or cached on req.user.
 *
 * Express 4 does not route an async middleware's rejection to the error
 * handler, so this must catch its own.
 */
export function requireRole(role) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'not authenticated' });
    try {
      const roles = await getEffectiveRoles(req.user.sub);
      if (roles.includes(role)) return next();
      return res.status(403).json({ error: 'forbidden' });
    } catch (e) {
      return next(e);
    }
  };
}

export function configurePassport() {
  let configured = 0;

  if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
    passport.use('discord', new DiscordStrategy({
      clientID: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      callbackURL: process.env.DISCORD_CALLBACK_URL,
      scope: ['identify'],
    }, async (accessToken, refreshToken, profile, done) => {
      try {
        const user = await upsertUser({
          provider: 'discord',
          providerId: profile.id,
          username: profile.username,
          avatarUrl: profile.avatar
            ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
            : null,
        });
        done(null, user);
      } catch (e) { done(e); }
    }));
    configured++;
  }

  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    passport.use('github', new GitHubStrategy({
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: process.env.GITHUB_CALLBACK_URL,
    }, async (accessToken, refreshToken, profile, done) => {
      try {
        const user = await upsertUser({
          provider: 'github',
          providerId: profile.id,
          username: profile.username || profile.displayName,
          avatarUrl: profile.photos && profile.photos[0] ? profile.photos[0].value : null,
        });
        done(null, user);
      } catch (e) { done(e); }
    }));
    configured++;
  }

  if (configured === 0) {
    console.warn('[auth] No OAuth providers configured. Set DISCORD_CLIENT_ID/SECRET and/or GITHUB_CLIENT_ID/SECRET in .env');
  }
  return configured;
}

// We use short-lived Passport sessions only to complete the OAuth handshake
// (session: false everywhere else) then issue our own JWT cookie. This avoids
// needing a server-side session store entirely.
export function issueToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, avatarUrl: user.avatar_url },
    JWT_SECRET,
    { expiresIn: '90d' },
  );
}

/**
 * Resolves a SuperTokens session into our `req.user` shape, or null.
 *
 * Returns null - never throws - for every "no usable session" case, including
 * a malformed, expired or revoked one. That is deliberate and is the single
 * most important property of this function during a rollout: in `dual` mode a
 * user can be carrying a stale SuperTokens session AND a perfectly good legacy
 * JWT cookie, and letting the SuperTokens failure escape would 500 the request
 * instead of falling through to the cookie that would have worked. This is the
 * failure mode that would take logins down mid-migration.
 *
 * `session.getUserId()` returns our `users.id` rather than SuperTokens'
 * internal id, because the user id mapping was created before the session was
 * issued - see server/supertokens/mapping.js. The username and avatar are not
 * in the session (the legacy JWT carries them in its payload), so they come
 * from the database.
 */
async function userFromSuperTokens(req, res) {
  if (!isSuperTokensReady()) return null;
  try {
    const Session = await loadSessionRecipe();
    if (!Session) return null;
    const session = await Session.getSession(req, res, { sessionRequired: false });
    if (!session) return null;

    const sub = session.getUserId();
    if (!sub) return null;

    // A session for a user id with no row is not an authenticated user. It
    // would mean the mapping resolved to something `users` has never heard of,
    // and treating it as valid would hand out a request context whose `sub`
    // matches no save, no role and no SUPER_ADMIN_IDS entry.
    const user = await getUserById(sub);
    if (!user) return null;

    return { sub, username: user.username, avatarUrl: user.avatar_url };
  } catch (e) {
    return null;
  }
}

/**
 * The v1.8 authentication chain: SuperTokens session first, then the legacy
 * JWT cookie, then 401.
 *
 * Both paths populate the identical `req.user = { sub, username, avatarUrl }`,
 * which is why no route handler changes in this release - `req.user.sub` is
 * the only identity field the handlers read, and `requireRole` re-derives
 * roles from it on every request (see requireRole above: it takes
 * `req.user.sub` and goes to the database and env, so it needs no change and
 * cannot be fooled by whichever stack authenticated the request).
 *
 * The JWT branch runs in EVERY mode, including `supertokens`. That is what
 * makes the documented rollback real: legacy cookies stay valid for their full
 * 90-day expiry through every transition in both directions, so nobody is
 * forced to log in again by a mode change. `supertokens` mode stops *issuing*
 * legacy cookies (the passport routes are not registered); it does not start
 * rejecting the ones already in the wild.
 *
 * Async since v1.8. Express 4 does not route an async middleware's rejection
 * to the error handler, so like requireRole this catches its own.
 */
export async function requireAuth(req, res, next) {
  try {
    const stUser = await userFromSuperTokens(req, res);
    if (stUser) {
      req.user = stUser;
      return next();
    }

    const token = req.cookies && req.cookies[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'not authenticated' });
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(401).json({ error: 'invalid or expired token' });
    }
    return next();
  } catch (e) {
    return next(e);
  }
}
