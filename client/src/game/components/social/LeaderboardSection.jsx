import { useState } from 'react';
import { cardBg, cardBorder, inset, textMain, textDim, amber } from '../../theme.js';
import { fmt, fmtCores } from '../../helpers.js';
import { useCoreFormat } from '../../coreFormat.js';
import { achievementDef } from '@shared/achievements.js';
import { achievementIcon, TIER_COLOR } from '../../data/achievementIcons.js';

// Board keys match server/leaderboardService.js's BOARDS list plus the
// event board it appends. `format` is how that board's `value` reads.
const BOARDS = [
  { key: 'allTimeFlops', label: 'FLOPS', format: (v) => `${fmt(v)} all-time` },
  { key: 'level', label: 'Level', format: (v) => `lv ${v}` },
  // The one board whose unit the player can restyle - `format` takes the
  // chosen core notation so this row matches the header chip.
  { key: 'legacyCores', label: 'Legacy Cores (best)', format: (v, coreFormat) => `${fmtCores(v, coreFormat)} cores` },
  { key: 'singularities', label: 'Singularities', format: (v) => `${fmt(v)}x` },
  { key: 'tapes', label: 'Tapes', format: (v) => `${fmt(v)} tapes` },
  { key: 'latestEventRung', label: 'Last event', format: (v) => `${v} rungs` },
];

function Badges({ ids }) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return (
    <span className="flex items-center gap-0.5 shrink-0">
      {ids.map((id) => {
        const def = achievementDef(id);
        if (!def) return null;
        const Icon = achievementIcon(def.icon);
        return <Icon key={id} size={12} color={TIER_COLOR[def.tier]} title={def.name} />;
      })}
    </span>
  );
}

// Rows arrive already ranked, opt-out-filtered and capped by the server - this
// component never re-sorts or re-filters them, so what a player sees is
// exactly what the server decided is public.
//
// The opt-out control writes through PUT /api/me/leaderboard-opt-out (the
// authoritative column these boards filter on), the same endpoint and the same
// handler the Event tab's "Hide me" checkbox uses - there is one preference,
// not one per board.
export default function LeaderboardSection({ boards, userId, optOut, loading, onToggleOptOut }) {
  const [active, setActive] = useState('allTimeFlops');
  const board = (boards && boards[active]) || [];
  const activeDef = BOARDS.find((b) => b.key === active);
  const coreFormat = useCoreFormat();

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-1 overflow-x-auto -mx-1 px-1 pb-0.5">
        {BOARDS.map((b) => (
          <button
            key={b.key}
            onClick={() => setActive(b.key)}
            className="rounded-lg px-2.5 py-1 text-xs font-semibold whitespace-nowrap"
            style={{
              background: active === b.key ? amber : inset,
              color: active === b.key ? '#0E141B' : textDim,
              border: `1px solid ${active === b.key ? amber : cardBorder}`,
            }}
          >
            {b.label}
          </button>
        ))}
      </div>

      <div className="rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
        {loading && board.length === 0 ? (
          <div className="text-xs" style={{ color: textDim }}>Loading&hellip;</div>
        ) : board.length === 0 ? (
          <div className="text-xs" style={{ color: textDim }}>No entries yet.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {board.map((row, i) => {
              const mine = row.userId === userId;
              return (
                <div
                  key={row.userId}
                  className="flex items-center justify-between text-xs font-mono rounded-lg px-2 py-1.5 gap-2"
                  style={{
                    background: mine ? inset : 'transparent',
                    border: `1px solid ${mine ? amber : 'transparent'}`,
                    color: mine ? textMain : textDim,
                  }}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="shrink-0" style={{ color: i === 0 ? amber : textDim }}>#{i + 1}</span>
                    {row.avatarUrl && (
                      <img src={row.avatarUrl} alt="" className="w-4 h-4 rounded-full shrink-0" />
                    )}
                    <span className="truncate">{row.username || 'Anonymous'}{mine ? ' (you)' : ''}</span>
                    <Badges ids={row.badges} />
                  </span>
                  <span className="shrink-0">{activeDef.format(row.value, coreFormat)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <label className="flex items-center gap-1.5 text-xs font-mono" style={{ color: textDim }}>
        <input
          type="checkbox"
          checked={!!(optOut ?? false)}
          onChange={(e) => onToggleOptOut(!!e.target.checked)}
        />
        Hide me from all leaderboards
      </label>
    </div>
  );
}
