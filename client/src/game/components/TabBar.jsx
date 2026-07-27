import { amber, textDim } from '../theme.js';

export default function TabBar({ tabs, activeTab, setActiveTab, gridUnlocked, overclockUnlocked, singularityUnlocked, coldStorageUnlocked }) {
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
            <TabIcon size={16} />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
