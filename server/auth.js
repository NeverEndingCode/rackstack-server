import passport from 'passport';
import { Strategy as DiscordStrategy } from 'passport-discord';
import { Strategy as GitHubStrategy } from 'passport-github2';
import jwt from 'jsonwebtoken';
import { upsertUser, getRoles } from './db.js';

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
export function getEffectiveRoles(id) {
  if (isOwner(id)) return ['admin', 'event_coordinator'];
  const stored = getRoles(id);
  const effective = new Set(stored);
  if (effective.has('admin')) effective.add('event_coordinator');
  return [...effective];
}

/**
 * Express middleware factory: 403s unless the requester's effective roles
 * include `role`. Always re-derived from the DB (and env for ownership) on
 * every request - never trusted from the client or cached on req.user.
 */
export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'not authenticated' });
    if (getEffectiveRoles(req.user.sub).includes(role)) return next();
    return res.status(403).json({ error: 'forbidden' });
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
    }, (accessToken, refreshToken, profile, done) => {
      try {
        const user = upsertUser({
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
    }, (accessToken, refreshToken, profile, done) => {
      try {
        const user = upsertUser({
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

export function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'not authenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}
