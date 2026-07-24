import React from 'react';
import { Cpu } from 'lucide-react';

export default function Login() {
  const params = new URLSearchParams(window.location.search);
  const authError = params.get('authError');

  return (
    <div
      style={{ minHeight: '100vh', background: '#0E141B', color: '#EAEFF5' }}
      className="flex items-center justify-center px-4"
    >
      <div className="w-full max-w-sm text-center">
        <Cpu size={40} color="#E8A33D" className="mx-auto mb-3" />
        <h1 className="text-2xl font-bold tracking-widest mb-1">RACKSTACK</h1>
        <p className="text-sm mb-8" style={{ color: '#7C8AA0' }}>spare pi to hyperscale</p>

        {authError && (
          <div className="text-xs mb-4 rounded-lg p-2" style={{ background: 'rgba(224,92,76,0.12)', border: '1px solid #E05C4C', color: '#E05C4C' }}>
            Login with {authError} failed. Try again.
          </div>
        )}

        <a
          href="/auth/discord"
          className="block w-full rounded-lg py-3 mb-3 text-sm font-semibold"
          style={{ background: '#5865F2', color: '#fff' }}
        >
          Continue with Discord
        </a>
        <a
          href="/auth/github"
          className="block w-full rounded-lg py-3 text-sm font-semibold"
          style={{ background: '#EAEFF5', color: '#0E141B' }}
        >
          Continue with GitHub
        </a>
      </div>
    </div>
  );
}
