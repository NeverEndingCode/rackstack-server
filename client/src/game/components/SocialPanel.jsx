import { useState, useEffect } from 'react';
import { ClipboardCheck, Trophy, Award } from 'lucide-react';
import { textDim, amber } from '../theme.js';
import ContractsSection from './social/ContractsSection.jsx';
import LeaderboardSection from './social/LeaderboardSection.jsx';
import AchievementsSection from './social/AchievementsSection.jsx';

const SECTIONS = [
  { id: 'contracts', label: 'Contracts', Icon: ClipboardCheck },
  { id: 'board', label: 'Board', Icon: Trophy },
  { id: 'badges', label: 'Badges', Icon: Award },
];

// Social tab shell (v1.5). Three sections behind an inner toggle, reusing
// ProfileView.jsx's segmented-control pattern rather than adding three more
// entries to an already nine-wide tab bar.
//
// The leaderboard is the only part that needs a network fetch (contracts and
// badges are both derived from canonical state, which arrives free on every
// reconcile), so it's fetched lazily the first time the Board section is
// opened - and refreshed on each subsequent open, throttled by RackStack.jsx.
export default function SocialPanel({
  meta, serverTime, userId, boards, leaderboardLoading, optOut,
  onClaimContract, onToggleOptOut, onRefreshLeaderboard,
}) {
  const [section, setSection] = useState('contracts');

  useEffect(() => {
    if (section === 'board') onRefreshLeaderboard();
  }, [section, onRefreshLeaderboard]);

  return (
    <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3">
      <div className="flex gap-1 rounded-lg p-1" style={{ background: '#0E141B' }}>
        {SECTIONS.map((s) => {
          const active = section === s.id;
          const SectionIcon = s.Icon;
          return (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className="flex-1 rounded-md py-1.5 text-xs font-semibold flex items-center justify-center gap-1"
              style={{ background: active ? amber : 'transparent', color: active ? '#0E141B' : textDim }}
            >
              <SectionIcon size={14} /> {s.label}
            </button>
          );
        })}
      </div>

      {section === 'contracts' && (
        <ContractsSection meta={meta} serverTime={serverTime} onClaim={onClaimContract} />
      )}
      {section === 'board' && (
        <LeaderboardSection
          boards={boards}
          userId={userId}
          optOut={optOut}
          loading={leaderboardLoading}
          onToggleOptOut={onToggleOptOut}
        />
      )}
      {section === 'badges' && <AchievementsSection achievements={meta.achievements} />}
    </div>
  );
}
