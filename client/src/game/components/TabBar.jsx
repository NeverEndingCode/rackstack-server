import { amber, textDim } from '../theme.js';

// eventLive: Live Events (v1.4) - true while the player's OWN event window
// is currently live (not just reachable-for-grace-claims - see
// RackStack.jsx's eventLive/eventTabVisible split). Only used to pulse the
// Event tab's icon (reusing the `.event-icon` keyframe already defined in
// RackStack.jsx for the anomaly toast/banner) as a "something's live" cue;
// it does NOT gate whether the tab renders at all - `tabs` arrives from
// RackStack.jsx already filtered to omit 'event' entirely outside its
// visible window (live window or 48h grace), unlike grid/overclock/
// singularity/coldstorage below which are always rendered, just disabled.
export default function TabBar({ tabs, activeTab, setActiveTab, gridUnlocked, overclockUnlocked, singularityUnlocked, coldStorageUnlocked, eventLive }) {
  return (
    <div className="mt-3 flex gap-1 -mx-4 px-4 overflow-x-auto">
      {tabs.map((tab) => {
        const locked = (tab.id === 'grid' && !gridUnlocked) || (tab.id === 'overclock' && !overclockUnlocked) || (tab.id === 'singularity' && !singularityUnlocked) || (tab.id === 'coldstorage' && !coldStorageUnlocked);
        const active = activeTab === tab.id;
        const TabIcon = tab.Icon;
        return (
          <button
            key={tab.id}
            disabled={locked}
            onClick={() => setActiveTab(tab.id)}
            className="flex flex-col items-center gap-0.5 py-2 px-3 rounded-t-lg text-xs whitespace-nowrap"
            style={{
              color: locked ? textDim : active ? amber : textDim,
              borderBottom: active ? `2px solid ${amber}` : '2px solid transparent',
              opacity: locked ? 0.45 : 1,
              cursor: locked ? 'not-allowed' : 'pointer',
            }}
            title={locked ? 'Keep progressing to unlock' : undefined}
          >
            <TabIcon size={16} className={tab.id === 'event' && eventLive ? 'event-icon' : undefined} />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
