import { cardBg, cardBorder, textMain, textDim } from '../../theme.js';
import { ACHIEVEMENT_DEFS, achievementProgress } from '@shared/achievements.js';
import { fmt } from '@shared/gameRules.js';
import { achievementIcon, TIER_COLOR } from '../../data/achievementIcons.js';

function unlockedDate(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// The badge case. Achievements are pure prestige (spec §6.3) - there is
// deliberately no Claim button anywhere here, because they unlock
// automatically in the reducer the moment their condition is met.
//
// `ctx` is the goalCtx-shaped object RackStack builds once per render and
// already hands to GoalsPanel; it drives the progress bar on each still-locked
// scalar badge. It is optional only so this component keeps rendering the case
// itself if a caller has no ctx to give - the bars simply don't appear.
export default function AchievementsSection({ achievements, ctx }) {
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
              {!unlocked && ctx && (() => {
                const p = achievementProgress(def, ctx);
                if (!p || !(p.target > 0)) return null;  // boolean badge, no bar
                // Clamped for the width only: achievementProgress deliberately
                // does not clamp `current`, and an unclamped ratio would draw a
                // bar wider than its track.
                const pct = Math.max(0, Math.min(1, p.current / p.target)) * 100;
                return (
                  <div className="mt-1">
                    <div className="h-1 rounded-full overflow-hidden" style={{ background: cardBorder }}>
                      <div className="h-full" style={{ width: `${pct}%`, background: accent }} />
                    </div>
                    {/* fmt is mandatory, not cosmetic: flops_p's target is 1e15. */}
                    <div className="text-xs font-mono mt-0.5" style={{ color: textDim }}>
                      {fmt(p.current)} / {fmt(p.target)}
                    </div>
                  </div>
                );
              })()}
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
