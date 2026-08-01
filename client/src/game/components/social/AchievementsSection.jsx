import { cardBg, cardBorder, textMain, textDim } from '../../theme.js';
import { ACHIEVEMENT_DEFS } from '@shared/achievements.js';
import { achievementIcon, TIER_COLOR } from '../../data/achievementIcons.js';

function unlockedDate(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// The badge case. Achievements are pure prestige (spec §6.3) - there is
// deliberately no Claim button anywhere here, because they unlock
// automatically in the reducer the moment their condition is met.
export default function AchievementsSection({ achievements }) {
  const held = achievements && typeof achievements === 'object' ? achievements : {};
  const unlockedCount = ACHIEVEMENT_DEFS.filter(
    (d) => Object.prototype.hasOwnProperty.call(held, d.id),
  ).length;

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs font-mono" style={{ color: textDim }}>
        {unlockedCount}/{ACHIEVEMENT_DEFS.length} unlocked
      </div>

      <div className="grid grid-cols-2 gap-2" data-testid="badge-case">
        {ACHIEVEMENT_DEFS.map((def) => {
          const at = held[def.id];
          const unlocked = Object.prototype.hasOwnProperty.call(held, def.id);
          const Icon = achievementIcon(def.icon);
          const accent = TIER_COLOR[def.tier];
          return (
            <div
              key={def.id}
              className="rounded-xl p-3 flex flex-col gap-1"
              style={{
                background: cardBg,
                border: `1px solid ${unlocked ? accent : cardBorder}`,
                opacity: unlocked ? 1 : 0.5,
              }}
            >
              <Icon size={18} color={unlocked ? accent : textDim} />
              <div className="text-sm font-semibold leading-tight" style={{ color: unlocked ? textMain : textDim }}>
                {def.name}
              </div>
              <div className="text-xs leading-snug" style={{ color: textDim }}>{def.desc}</div>
              {unlocked && unlockedDate(at) && (
                <div className="text-xs font-mono mt-0.5" style={{ color: accent }}>{unlockedDate(at)}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
