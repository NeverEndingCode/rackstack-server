import { useEffect, useState } from 'react';
import { Crown, ShieldCheck, Sparkles } from 'lucide-react';
import {
  cardBorder, textMain, textDim, violet, teal, danger, inset,
} from '../../theme.js';
import { fetchAdminRoles, postRoleChange } from '../../api.js';

// Grant/revoke controls mirror the server rule (server/routes/api.js) for
// UX only - the server is the actual enforcement:
//   - 'admin' can only be granted/revoked by the owner.
//   - 'event_coordinator' can be granted/revoked by the owner or any admin
//     (i.e. anyone who can even see this tab, since AdminPanel is already
//     gated on user.roles.includes('admin')).
//   - Owner rows are env-derived (SUPER_ADMIN_IDS) and never editable.
function RoleChip({ label, icon, active, onClick, pending, testId }) {
  return (
    <button
      onClick={onClick}
      disabled={pending}
      data-testid={testId}
      className="rounded-md px-2 py-1 text-[10px] font-semibold flex items-center gap-1"
      style={{
        background: active ? 'rgba(79,195,176,0.15)' : '#0E141B',
        color: active ? teal : textDim,
        border: `1px solid ${active ? teal : cardBorder}`,
        opacity: pending ? 0.5 : 1,
        cursor: pending ? 'not-allowed' : 'pointer',
      }}
    >
      {icon} {label}{active ? ' ✓' : ''}
    </button>
  );
}

export default function AdminRoles({ user }) {
  const [users, setUsers] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [pendingKey, setPendingKey] = useState(null); // `${userId}:${role}` currently in flight

  const viewerIsOwner = !!user && user.isOwner === true;

  useEffect(() => {
    let cancelled = false;
    fetchAdminRoles().then((res) => {
      if (cancelled) return;
      if (!res || res.error) { setLoadError('Failed to load users.'); return; }
      setUsers(res.users);
    });
    return () => { cancelled = true; };
  }, []);

  async function handleToggle(u, role) {
    const key = `${u.id}:${role}`;
    const op = u.roles.includes(role) ? 'revoke' : 'grant';
    setActionError(null);
    setPendingKey(key);
    const res = await postRoleChange(u.id, role, op);
    setPendingKey(null);
    if (res && res.ok) {
      setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, roles: res.roles } : x)));
      return;
    }
    if (res && res.error === 'owner_required') setActionError('Only the owner can grant or revoke admin.');
    else if (res && res.error === 'cannot_modify_owner') setActionError("Can't modify the owner's roles.");
    else setActionError('Failed to update role.');
  }

  if (loadError) return <div className="text-xs" style={{ color: danger }}>{loadError}</div>;
  if (!users) return <div className="text-xs" style={{ color: textDim }}>Loading&hellip;</div>;
  if (users.length === 0) return <div className="text-xs" style={{ color: textDim }}>No users yet.</div>;

  return (
    <div className="flex flex-col gap-2">
      {actionError && (
        <div className="rounded-md p-2 text-xs" style={{ background: inset, border: `1px solid ${danger}`, color: danger }}>
          {actionError}
        </div>
      )}
      <div className="flex flex-col gap-2 max-h-96 overflow-y-auto">
        {users.map((u) => (
          <div key={u.id} className="rounded-md p-2 text-xs" style={{ background: inset, border: `1px solid ${cardBorder}` }}>
            <div className="flex items-center justify-between font-mono gap-2 mb-1.5" style={{ color: textMain }}>
              <span className="truncate">{u.username || u.id}</span>
              {u.isOwner && (
                <span className="flex items-center gap-1 shrink-0" style={{ color: violet }}>
                  <Crown size={12} /> Owner
                </span>
              )}
            </div>
            {u.isOwner ? (
              <div className="text-[10px]" style={{ color: textDim }}>Owner roles are fixed and not editable.</div>
            ) : (
              <div className="flex gap-1.5 flex-wrap">
                {viewerIsOwner && (
                  <RoleChip
                    label="Admin"
                    icon={<ShieldCheck size={11} />}
                    active={u.roles.includes('admin')}
                    pending={pendingKey === `${u.id}:admin`}
                    onClick={() => handleToggle(u, 'admin')}
                    testId={`role-admin-${u.id}`}
                  />
                )}
                <RoleChip
                  label="Event Coordinator"
                  icon={<Sparkles size={11} />}
                  active={u.roles.includes('event_coordinator')}
                  pending={pendingKey === `${u.id}:event_coordinator`}
                  onClick={() => handleToggle(u, 'event_coordinator')}
                  testId={`role-event_coordinator-${u.id}`}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
