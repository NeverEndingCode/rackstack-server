import { LogOut } from 'lucide-react';
import { textMain, inset, cardBorder } from '../../theme.js';
import DangerZone from './DangerZone.jsx';
import AdminPanel from './AdminPanel.jsx';

export default function ProfileSettings({ user, onLogout, onOpenReset }) {
  // Admin-only UI visibility - the real gate is server-side (server/auth.js
  // requireRole('admin')), this only decides whether to show the section at
  // all. /api/me now returns the caller's effective roles (owners implicitly
  // hold 'admin'), so no client-side user-id allowlist is needed anymore.
  const isAdmin = !!user && Array.isArray(user.roles) && user.roles.includes('admin');
  return (
    <div className="flex flex-col gap-4">
      <button onClick={onLogout} className="w-full rounded-lg py-2 text-sm font-semibold flex items-center justify-center gap-2" style={{ background: inset, border: `1px solid ${cardBorder}`, color: textMain }}>
        <LogOut size={16} /> Log out
      </button>
      <DangerZone onOpenReset={onOpenReset} />
      {isAdmin && <AdminPanel />}
    </div>
  );
}
