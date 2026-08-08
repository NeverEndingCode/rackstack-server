import React, { useState } from 'react';
import { Cpu } from 'lucide-react';
import { startSuperTokensLogin, loginErrorMessage, FALLBACK_AUTH_INFO } from './game/auth.js';

// Display order, independent of the order the server lists providers in.
// Keeps the screen looking the same as it did before v1.9 regardless of how
// configuredProviders() happens to sort.
const PROVIDER_STYLE = {
  discord: { label: 'Continue with Discord', background: '#5865F2', color: '#fff' },
  github: { label: 'Continue with GitHub', background: '#EAEFF5', color: '#0E141B' },
};
const DISPLAY_ORDER = ['discord', 'github'];

// `authInfo` comes from App, which fetches GET /api/auth-info once at boot and
// falls back to FALLBACK_AUTH_INFO when it cannot be reached - so this
// component always has a usable answer and never fetches it a second time.
export default function Login({ authInfo = FALLBACK_AUTH_INFO }) {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get('authError');
  const authReason = params.get('authReason');

  const [failure, setFailure] = useState(null);
  const [pending, setPending] = useState(null);
  const info = authInfo;

  // The redirect leg carries its failure in the URL (App.jsx puts it there
  // before handing over); a failure to *start* the login is held in state.
  const shownError = failure || (authError ? { provider: authError, reason: authReason } : null);

  async function onSuperTokensLogin(providerId) {
    setPending(providerId);
    setFailure(null);
    const res = await startSuperTokensLogin(providerId);
    // Resolves only when the navigation never happened.
    if (!res.ok) {
      setFailure({ provider: providerId, reason: res.reason });
      setPending(null);
    }
  }

  const providers = DISPLAY_ORDER.filter((id) => info.providers?.includes(id));

  return (
    <div
      style={{ minHeight: '100vh', background: '#0E141B', color: '#EAEFF5' }}
      className="flex items-center justify-center px-4"
    >
      <div className="w-full max-w-sm text-center">
        <Cpu size={40} color="#E8A33D" className="mx-auto mb-3" />
        <h1 className="text-2xl font-bold tracking-widest mb-1">RACKSTACK</h1>
        <p className="text-sm mb-8" style={{ color: '#7C8AA0' }}>spare pi to hyperscale</p>

        {shownError && (
          <div className="text-xs mb-4 rounded-lg p-2" style={{ background: 'rgba(224,92,76,0.12)', border: '1px solid #E05C4C', color: '#E05C4C' }}>
            {loginErrorMessage(shownError.provider, shownError.reason)}
          </div>
        )}

        {providers.length === 0 && (
          <div className="text-xs rounded-lg p-2" style={{ background: 'rgba(224,92,76,0.12)', border: '1px solid #E05C4C', color: '#E05C4C' }}>
            No login provider is configured on this server.
          </div>
        )}

        {providers.map((id) => {
          const { label, ...css } = PROVIDER_STYLE[id];
          const className = 'block w-full rounded-lg py-3 mb-3 text-sm font-semibold';

          // passport mode is a plain link to a server route that 302s to the
          // provider. SuperTokens needs a fetch first, to be told where to go.
          if (info.loginFlow === 'passport') {
            return (
              <a key={id} href={`/auth/${id}`} className={className} style={css}>
                {label}
              </a>
            );
          }

          return (
            <button
              key={id}
              type="button"
              disabled={pending !== null}
              onClick={() => onSuperTokensLogin(id)}
              className={className}
              style={{ ...css, opacity: pending && pending !== id ? 0.5 : 1 }}
            >
              {pending === id ? 'Redirecting...' : label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
