import { useState } from 'react';
import { LogOut } from 'lucide-react';
import { textMain, textDim, danger, teal, inset, cardBorder, amber } from '../../theme.js';
import DangerZone from './DangerZone.jsx';
import AdminPanel from './AdminPanel.jsx';
import { setUsername } from '../../api.js';
import { USERNAME_RE } from '@shared/validation.js';

// Same rule the server enforces (server/routes/api.js, via shared/validation.js).
// Used here purely for instant inline feedback; the server's regex is still
// the source of truth (see the 400 branch in handleSave below).

function UsernameForm({ displayName, onUsernameChanged }) {
  const [name, setName] = useState(displayName || '');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState(null); // { kind: 'success' | 'error', text }

  const trimmed = name.trim();
  const valid = USERNAME_RE.test(trimmed);
  const unchanged = trimmed === (displayName || '');

  async function handleSave() {
    if (!valid || unchanged || saving) return;
    setSaving(true);
    setNote(null);
    const res = await setUsername(trimmed);
    setSaving(false);
    if (res && res.ok) {
      setNote({ kind: 'success', text: 'Saved.' });
      onUsernameChanged(res.username);
    } else if (res && res.status === 400) {
      setNote({ kind: 'error', text: '3-20 characters: letters, numbers, _ or -' });
    } else if (res && res.status === 409) {
      setNote({ kind: 'error', text: 'That name is taken' });
    } else {
      setNote({ kind: 'error', text: "Couldn't save, try again" });
    }
  }

  return (
    <div className="rounded-lg p-3" style={{ background: inset, border: `1px solid ${cardBorder}` }}>
      <div className="text-xs font-semibold mb-2" style={{ color: textDim }}>Username</div>
      <div className="flex gap-2">
        <input
          value={name}
          onChange={(e) => { setName(e.target.value); setNote(null); }}
          maxLength={20}
          className="flex-1 rounded-md px-2 py-1.5 text-sm font-mono"
          style={{ background: '#0E141B', border: `1px solid ${cardBorder}`, color: textMain }}
        />
        <button
          onClick={handleSave}
          disabled={!valid || unchanged || saving}
          className="rounded-md px-3 py-1.5 text-xs font-semibold"
          style={{
            background: (!valid || unchanged || saving) ? '#0E141B' : amber,
            color: (!valid || unchanged || saving) ? textDim : '#0E141B',
            border: `1px solid ${cardBorder}`,
            opacity: (!valid || unchanged || saving) ? 0.6 : 1,
            cursor: (!valid || unchanged || saving) ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
      {!valid && (
        <p className="text-xs mt-1.5" style={{ color: textDim }}>3-20 characters: letters, numbers, _ or -</p>
      )}
      {note && (
        <p className="text-xs mt-1.5" style={{ color: note.kind === 'success' ? teal : danger }}>{note.text}</p>
      )}
    </div>
  );
}

export default function ProfileSettings({ user, displayName, onUsernameChanged, onLogout, onOpenReset, onConfigSaved }) {
  // Admin-panel UI visibility - the real gate is server-side (server/auth.js
  // requireRole per route), this only decides whether to show the section at
  // all. /api/me now returns the caller's effective roles (owners implicitly
  // hold both; getEffectiveRoles folds 'event_coordinator' into every
  // 'admin'), so no client-side user-id allowlist is needed anymore.
  //
  // Widened from admin-only (pre-v1.4) to admin-OR-event_coordinator: a pure
  // coordinator (granted 'event_coordinator' but not 'admin') needs to reach
  // this panel too, just to see its own Events tab - AdminPanel itself does
  // the finer-grained per-tab filtering (Users/Balancing/Roles stay
  // admin-only), so showing the panel to a coordinator here doesn't expose
  // anything they aren't already allowed to see.
  const canSeeAdminPanel = !!user && Array.isArray(user.roles)
    && (user.roles.includes('admin') || user.roles.includes('event_coordinator'));
  return (
    <div className="flex flex-col gap-4">
      <UsernameForm displayName={displayName} onUsernameChanged={onUsernameChanged} />
      <button onClick={onLogout} className="w-full rounded-lg py-2 text-sm font-semibold flex items-center justify-center gap-2" style={{ background: inset, border: `1px solid ${cardBorder}`, color: textMain }}>
        <LogOut size={16} /> Log out
      </button>
      <DangerZone onOpenReset={onOpenReset} />
      {canSeeAdminPanel && <AdminPanel user={user} onConfigSaved={onConfigSaved} />}
    </div>
  );
}
