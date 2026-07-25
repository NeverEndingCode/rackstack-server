import { useState, useEffect } from 'react';
import { ShieldAlert } from 'lucide-react';
import { cardBorder, textMain, textDim, violet, inset } from '../../theme.js';

export default function AdminPanel() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/admin/users', { credentials: 'include' })
      .then((r) => { if (!r.ok) throw new Error(`request failed (${r.status})`); return r.json(); })
      .then((data) => { if (!cancelled) setUsers(data.users); })
      .catch(() => { if (!cancelled) setError('Failed to load users.'); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="rounded-lg p-3" style={{ border: `1px solid ${violet}`, background: 'rgba(156,140,242,0.08)' }}>
      <div className="flex items-center gap-1.5 text-xs font-semibold mb-2" style={{ color: violet }}>
        <ShieldAlert size={13} /> ADMIN &mdash; ALL USERS
      </div>
      {error && <div className="text-xs" style={{ color: textDim }}>{error}</div>}
      {!users && !error && <div className="text-xs" style={{ color: textDim }}>Loading&hellip;</div>}
      {users && users.length === 0 && <div className="text-xs" style={{ color: textDim }}>No users yet.</div>}
      {users && users.length > 0 && (
        <div className="flex flex-col gap-2 max-h-72 overflow-y-auto">
          {users.map((u) => (
            <div key={u.id} className="rounded-md p-2 text-xs" style={{ background: inset, border: `1px solid ${cardBorder}` }}>
              <div className="flex items-center justify-between font-mono gap-2" style={{ color: textMain }}>
                <span className="truncate">{u.username || u.id}</span>
                <span style={{ color: textDim }}>{u.provider}</span>
              </div>
              <div className="mt-0.5" style={{ color: textDim }}>
                {u.level != null
                  ? `Lv ${u.level} · ${u.wafers ?? 0} wafers · ${u.legacyCores ?? 0} cores · ${u.singularityShards ?? 0} shards`
                  : 'No save yet'}
              </div>
              {u.stats && (
                <div style={{ color: textDim }}>
                  Migrates {u.stats.migrates ?? 0} &middot; Singularities {u.stats.singularities ?? 0} &middot; Minigames won {u.stats.minigamesWon ?? 0}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
