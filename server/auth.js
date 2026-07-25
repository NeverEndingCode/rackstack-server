import passport from 'passport';
import { Strategy as DiscordStrategy } from 'passport-discord';
import { Strategy as GitHubStrategy } from 'passport-github2';
import jwt from 'jsonwebtoken';
import { upsertUser } from './db.js';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required. Generate one with: openssl rand -hex 32');
}

export const COOKIE_NAME = 'rackstack_token';

// Hardcoded admin - only this user id can access the /api/admin/* routes.
export const ADMIN_USER_ID = 'github:37058311';

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
