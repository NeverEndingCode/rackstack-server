import React, { useEffect, useState } from 'react';
import Login from './Login.jsx';
import RackStack from './RackStack.jsx';

export default function App() {
  const [status, setStatus] = useState('checking'); // checking | anon | authed
  const [user, setUser] = useState(null);

  useEffect(() => {
    fetch('/api/me', { credentials: 'include' })
      .then((r) => {
        if (!r.ok) throw new Error('not authenticated');
        return r.json();
      })
      .then((u) => { setUser(u); setStatus('authed'); })
      .catch(() => setStatus('anon'));
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

  if (status === 'anon') return <Login />;

  return <RackStack user={user} />;
}
