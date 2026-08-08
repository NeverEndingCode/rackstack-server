// The login routes, split out of api.js in v1.8 because they are the only
// routes in the codebase whose *registration* depends on AUTH_MODE.
//
// Everything else in api.js is mode-agnostic: it sits behind `requireAuth`,
// which resolves `req.user` from whichever stack authenticated the request.
// These four are different - they ARE the passport stack - so in
// `supertokens` mode they must not exist at all rather than exist and fail.
//
// A router factory rather than a module-level router, because the mode is
// resolved per buildApp() call: a test (and, in principle, a process running
// more than one app) must be able to build a `passport` app and a
// `supertokens` app without the first one's routes leaking into the second.

import express from 'express';
import passport from 'passport';
import { issueToken, COOKIE_NAME, configuredProviders } from '../auth.js';
import { isPassportEnabled, isSuperTokensEnabled } from '../authMode.js';
import { isSuperTokensReady, loadSessionRecipe } from '../supertokens/init.js';

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

/**
 * Builds the auth routes for one mode.
 *
 * `/auth/logout` is registered in EVERY mode and clears both stacks. A logout
 * that only clears half of a dual-stack session is worse than one that fails
 * outright: the user sees the logged-out UI, believes they are logged out, and
 * is still authenticated on the next request. On a shared machine that is a
 * genuine account-exposure bug, not a cosmetic one.
 */
export function createAuthRouter({ mode }) {
  const router = express.Router();

  // The one route here that is NOT a login route, and the one place in the
  // codebase serving /api/* from outside routes/api.js.
  //
  // It lives here because it answers a question only this file knows: which
  // stack the client must drive. It cannot live on GET /api/config, which the
  // v1.9 plan originally proposed, because that route sits behind requireAuth
  // and the caller is by definition not logged in yet.
  //
  // Deliberately public. It reveals which login buttons to draw and nothing
  // else - no credentials, no ids, no per-user state - and every fact in it is
  // already observable by looking at the login screen or watching a redirect.
  //
  // `loginFlow` is a server DECISION, not raw configuration, so the policy
  // lives in one place. In `dual` both stacks accept a session, and the client
  // is told to use SuperTokens: exercising that path is the entire point of
  // dual, and the passport routes stay registered underneath as the rollback.
  router.get('/api/auth-info', (req, res) => {
    res.json({
      authMode: mode,
      loginFlow: isSuperTokensEnabled(mode) ? 'supertokens' : 'passport',
      providers: configuredProviders(),
    });
  });

  if (isPassportEnabled(mode)) {
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
  }

  router.post('/auth/logout', async (req, res) => {
    // Always clear the legacy cookie, in every mode - a user in `supertokens`
    // mode can still be carrying one from before the cutover, and that cookie
    // is exactly what requireAuth's fallback branch would accept.
    res.clearCookie(COOKIE_NAME);

    if (isSuperTokensReady()) {
      try {
        const Session = await loadSessionRecipe();
        const session = await Session.getSession(req, res, { sessionRequired: false });
        if (session) await session.revokeSession();
      } catch (e) {
        // Best-effort by design. The legacy cookie is already cleared above,
        // and a SuperTokens session that cannot even be read is not one this
        // request can revoke. Failing the whole logout here would leave the
        // user MORE logged in than reporting success does.
        console.error('[auth] failed to revoke the SuperTokens session during logout', e);
      }
    }

    res.json({ ok: true });
  });

  return router;
}
