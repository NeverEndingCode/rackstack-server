import { LogOut } from 'lucide-react';
import { textMain, inset, cardBorder } from '../../theme.js';
import DangerZone from './DangerZone.jsx';

export default function ProfileSettings({ onLogout, onOpenReset }) {
  return (
    <div className="flex flex-col gap-4">
      <button onClick={onLogout} className="w-full rounded-lg py-2 text-sm font-semibold flex items-center justify-center gap-2" style={{ background: inset, border: `1px solid ${cardBorder}`, color: textMain }}>
        <LogOut size={16} /> Log out
      </button>
      <DangerZone onOpenReset={onOpenReset} />
    </div>
  );
}
