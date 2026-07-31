import { useState, useEffect } from 'react';
import {
  ShieldAlert, Users, SlidersHorizontal, KeyRound, Sparkles,
} from 'lucide-react';
import {
  cardBorder, textMain, textDim, violet, inset, amber,
} from '../../theme.js';
import { fetchAdminUsers } from '../../api.js';
import AdminBalancing from './AdminBalancing.jsx';
import AdminRoles from './AdminRoles.jsx';
import AdminEvents from './AdminEvents.jsx';

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

// Each tab declares the effective role it requires to be visible at all.
// `user.roles` (from GET /api/me, server/auth.js's getEffectiveRoles) is
// already the CALLER's effective set - admins/owners have 'event_coordinator'
// folded in there server-side, so a plain `.includes(role)` below is enough;
// this file never needs to reason about role implication itself. The server
// enforces every one of these routes independently (requireRole per route,
// server/routes/api.js) - this filtering is UX only, so a pure coordinator
// simply never sees tabs they have no route access to, rather than seeing
// them and hitting a wall of 403s.
const ALL_TABS = [
  { key: 'users', label: 'Users', Icon: Users, role: 'admin' },
  { key: 'balancing', label: 'Balancing', Icon: SlidersHorizontal, role: 'admin' },
  { key: 'roles', label: 'Roles', Icon: KeyRound, role: 'admin' },
  { key: 'events', label: 'Events', Icon: Sparkles, role: 'event_coordinator' },
];

export default function AdminPanel({ user, onConfigSaved }) {
  const roles = (user && Array.isArray(user.roles)) ? user.roles : [];
  const tabs = ALL_TABS.filter((t) => roles.includes(t.role));
  const [tab, setTab] = useState(tabs[0] ? tabs[0].key : null);

  // Keeps the active tab valid if the visible set ever changes shape (e.g.
  // roles refresh mid-session) - falls back to the first still-visible tab
  // rather than rendering nothing.
  useEffect(() => {
    if (tab !== null && tabs.some((t) => t.key === tab)) return;
    setTab(tabs[0] ? tabs[0].key : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.map((t) => t.key).join(',')]);

  return (
    <div className="rounded-lg p-3" style={{ border: `1px solid ${violet}`, background: 'rgba(156,140,242,0.08)' }}>
      <div className="flex items-center gap-1.5 text-xs font-semibold mb-2" style={{ color: violet }}>
        <ShieldAlert size={13} /> ADMIN
      </div>

      {tabs.length > 1 && (
        <div className="flex gap-1 mb-3 rounded-lg p-1" style={{ background: '#0E141B' }}>
          {tabs.map(({ key, label, Icon }) => (
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
      )}

      {tab === 'users' && <AdminUsersTab />}
      {tab === 'balancing' && <AdminBalancing onConfigSaved={onConfigSaved} />}
      {tab === 'roles' && <AdminRoles user={user} />}
      {tab === 'events' && <AdminEvents />}
    </div>
  );
}
