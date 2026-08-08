import React, { useEffect, useState } from 'react';
import Login from './Login.jsx';
import RackStack from './RackStack.jsx';
import {
  callbackProviderFromPath, completeSuperTokensLogin, fetchAuthInfo, FALLBACK_AUTH_INFO,
} from './game/auth.js';
import { configureAuthRefresh } from './game/api.js';

export default function App() {
  const [status, setStatus] = useState('checking'); // checking | anon | authed
  const [user, setUser] = useState(null);
  const [authInfo, setAuthInfo] = useState(FALLBACK_AUTH_INFO);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Started first and awaited later: it is independent of the callback
      // exchange below, and one round trip here serves both the login screen
      // (which buttons to draw) and api.js (whether to refresh on a 401).
      const infoPromise = fetchAuthInfo();

      // The SuperTokens redirect leg (v1.9). The provider sends the player to
      // /auth/callback/<provider>?code=..., which the server does not handle -
      // SuperTokens' ThirdParty recipe serves only POST /auth/callback/apple,
      // so the request falls through to the SPA and lands here. Exchanging the
      // code has to happen BEFORE /api/me, because it is what creates the
      // session /api/me would otherwise report as absent.
      let callbackFailure = null;
      if (callbackProviderFromPath(window.location.pathname)) {
        const result = await completeSuperTokensLogin();
        if (cancelled) return;
        if (!result.ok) callbackFailure = result;

        // Replace rather than push, and always: leaving a spent ?code= in the
        // URL means a reload re-POSTs an authorisation code the provider has
        // already burned, which fails and bounces a logged-in player back to
        // the login screen. Replacing also keeps the code out of the back
        // button and out of any link the player might copy.
        const next = result.ok
          ? '/'
          : `/?authError=${encodeURIComponent(result.provider ?? '')}&authReason=${encodeURIComponent(result.reason)}`;
        window.history.replaceState({}, '', next);
      }

      const info = await infoPromise;
      if (cancelled) return;
      const resolved = info && !info.error ? info : FALLBACK_AUTH_INFO;
      configureAuthRefresh(resolved);
      setAuthInfo(resolved);

      // Deliberately skipped when the exchange just failed: there is no
      // session to find, and asking anyway only delays the login screen.
      let authed = null;
      if (!callbackFailure) {
        try {
          const res = await fetch('/api/me', { credentials: 'include' });
          if (res.ok) authed = await res.json();
        } catch { /* offline or server down - treated as anonymous below */ }
      }

      if (cancelled) return;
      if (authed) { setUser(authed); setStatus('authed'); } else setStatus('anon');
    })();

    return () => { cancelled = true; };
  }, []);

  if (status === 'checking') {
    return (
      <div
        style={{ minHeight: '100vh', background: '#0E141B', color: '#7C8AA0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        className="font-mono text-sm"
      >
        Booting rack...
      </div>
    );
  }

  if (status === 'anon') return <Login authInfo={authInfo} />;

  return <RackStack user={user} />;
}
