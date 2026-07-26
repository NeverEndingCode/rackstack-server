import { useState } from 'react';
import { X, BarChart3, Settings } from 'lucide-react';
import { cardBg, cardBorder, textMain, textDim, amber } from '../../theme.js';
import ProfileStats from './ProfileStats.jsx';
import ProfileSettings from './ProfileSettings.jsx';
import { fetchChangelog } from '../../api.js';

// Rendered above minigame overlays (z-30) but below ModalRoot (z-40) so the
// reset confirmation modals launched from the Danger Zone always stack above
// this view.
export default function ProfileView({ user, meta, memberSince, displayName, onUsernameChanged, onClose, onLogout, onOpenReset }) {
  const [tab, setTab] = useState('stats');
  // Changelog text is fetched lazily on first tap of the version footer and
  // cached here for the lifetime of this view (no need to re-fetch on
  // subsequent opens/closes of the changelog overlay).
  const [changelog, setChangelog] = useState({ status: 'idle', text: null });
  const [changelogOpen, setChangelogOpen] = useState(false);

  function openChangelog() {
    setChangelogOpen(true);
    if (changelog.status === 'idle') {
      setChangelog({ status: 'loading', text: null });
      fetchChangelog().then((res) => {
        if (typeof res === 'string') {
          setChangelog({ status: 'loaded', text: res });
        } else {
          setChangelog({ status: 'error', text: null });
        }
      });
    }
  }

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
        {tab === 'settings' && (
          <ProfileSettings
            user={user}
            displayName={displayName}
            onUsernameChanged={onUsernameChanged}
            onLogout={onLogout}
            onOpenReset={onOpenReset}
          />
        )}

        <button
          onClick={openChangelog}
          className="w-full text-center text-xs mt-4"
          style={{ color: textDim, opacity: 0.7 }}
        >
          v{__APP_VERSION__}
        </button>
      </div>

      {changelogOpen && (
        // Simple overlay layer local to ProfileView rather than routing through
        // ModalRoot: it only ever needs to stack above this view (zIndex 35),
        // so it borrows ModalRoot's z-40 convention via inline style without
        // adding a new modal type to that shared component.
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)', zIndex: 40 }}
          onClick={() => setChangelogOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-xl p-5 flex flex-col"
            style={{ background: cardBg, border: `1px solid ${cardBorder}`, maxHeight: '80vh' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold" style={{ color: textMain }}>Changelog</h3>
              <button onClick={() => setChangelogOpen(false)} style={{ color: textDim }}><X size={20} /></button>
            </div>
            <div className="overflow-y-auto text-xs" style={{ color: textDim }}>
              {changelog.status === 'loading' && <p>Loading...</p>}
              {changelog.status === 'error' && <p style={{ color: textDim }}>Couldn&apos;t load changelog.</p>}
              {changelog.status === 'loaded' && (
                <pre className="font-mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: textDim }}>{changelog.text}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
