import { useState, useEffect } from 'react';
import {
  ShieldAlert, Users, SlidersHorizontal, KeyRound,
} from 'lucide-react';
import {
  cardBorder, textMain, textDim, violet, inset, amber,
} from '../../theme.js';
import { fetchAdminUsers } from '../../api.js';
import AdminBalancing from './AdminBalancing.jsx';
import AdminRoles from './AdminRoles.jsx';

function AdminUsersTab() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchAdminUsers().then((res) => {
      if (cancelled) return;
      if (!res || res.error) { setError('Failed to load users.'); return; }
      setUsers(res.users);
    });
    return () => { cancelled = true; };
  }, []);

  if (error) return <div className="text-xs" style={{ color: textDim }}>{error}</div>;
  if (!users) return <div className="text-xs" style={{ color: textDim }}>Loading&hellip;</div>;
  if (users.length === 0) return <div className="text-xs" style={{ color: textDim }}>No users yet.</div>;

  return (
    <div className="flex flex-col gap-2 max-h-96 overflow-y-auto">
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
  );
}

const TABS = [
  { key: 'users', label: 'Users', Icon: Users },
  { key: 'balancing', label: 'Balancing', Icon: SlidersHorizontal },
  { key: 'roles', label: 'Roles', Icon: KeyRound },
];

export default function AdminPanel({ user, onConfigSaved }) {
  const [tab, setTab] = useState('users');

  return (
    <div className="rounded-lg p-3" style={{ border: `1px solid ${violet}`, background: 'rgba(156,140,242,0.08)' }}>
      <div className="flex items-center gap-1.5 text-xs font-semibold mb-2" style={{ color: violet }}>
        <ShieldAlert size={13} /> ADMIN
      </div>

      <div className="flex gap-1 mb-3 rounded-lg p-1" style={{ background: '#0E141B' }}>
        {TABS.map(({ key, label, Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className="flex-1 rounded-md py-1.5 text-[11px] font-semibold flex items-center justify-center gap-1"
            style={{ background: tab === key ? amber : 'transparent', color: tab === key ? '#0E141B' : textDim }}
          >
            <Icon size={12} /> {label}
          </button>
        ))}
      </div>

      {tab === 'users' && <AdminUsersTab />}
      {tab === 'balancing' && <AdminBalancing onConfigSaved={onConfigSaved} />}
      {tab === 'roles' && <AdminRoles user={user} />}
    </div>
  );
}
