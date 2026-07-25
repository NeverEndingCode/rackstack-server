import { useState } from 'react';
import { X, BarChart3, Settings } from 'lucide-react';
import { cardBg, cardBorder, textMain, textDim, amber } from '../../theme.js';
import ProfileStats from './ProfileStats.jsx';
import ProfileSettings from './ProfileSettings.jsx';

// Rendered above minigame overlays (z-30) but below ModalRoot (z-40) so the
// reset confirmation modals launched from the Danger Zone always stack above
// this view.
export default function ProfileView({ user, meta, memberSince, onClose, onLogout, onOpenReset }) {
  const [tab, setTab] = useState('stats');
  return (
    <div className="fixed inset-0 flex items-center justify-center p-4" style={{ background: 'rgba(10,14,19,0.96)', zIndex: 35 }}>
      <div className="w-full max-w-sm rounded-xl p-5" style={{ background: cardBg, border: `1px solid ${cardBorder}`, maxHeight: '85vh', overflowY: 'auto' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold" style={{ color: textMain }}>Profile</h2>
          <button onClick={onClose} style={{ color: textDim }}><X size={22} /></button>
        </div>

        <div className="flex gap-1 mb-4 rounded-lg p-1" style={{ background: '#0E141B' }}>
          <button
            onClick={() => setTab('stats')}
            className="flex-1 rounded-md py-1.5 text-xs font-semibold flex items-center justify-center gap-1"
            style={{ background: tab === 'stats' ? amber : 'transparent', color: tab === 'stats' ? '#0E141B' : textDim }}
          >
            <BarChart3 size={14} /> Stats
          </button>
          <button
            onClick={() => setTab('settings')}
            className="flex-1 rounded-md py-1.5 text-xs font-semibold flex items-center justify-center gap-1"
            style={{ background: tab === 'settings' ? amber : 'transparent', color: tab === 'settings' ? '#0E141B' : textDim }}
          >
            <Settings size={14} /> Settings
          </button>
        </div>

        {tab === 'stats' && <ProfileStats meta={meta} memberSince={memberSince} />}
        {tab === 'settings' && <ProfileSettings user={user} onLogout={onLogout} onOpenReset={onOpenReset} />}
      </div>
    </div>
  );
}
