import { useState } from 'react';
import { cardBg, cardBorder, textMain, textDim, teal, violet, amber } from '../theme.js';
import { fmt } from '../helpers.js';
import { GOAL_DEFS, REPEATABLE_DEFS } from '../data/goals.js';

export default function GoalsPanel({ ctx, meta, onClaimGoal, onClaimRepeatable }) {
  const [showCompleted, setShowCompleted] = useState(false);
  const completedCount = Object.keys(meta.goalsCompleted).length;
  return (
    <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-2" data-tour="goals-list">
      <div className="flex items-center justify-between text-xs font-mono mb-1" style={{ color: textDim }}>
        <span>{completedCount}/{GOAL_DEFS.length} completed</span>
        <button onClick={() => setShowCompleted((s) => !s)} style={{ color: violet }}>{showCompleted ? 'Hide completed' : 'Show completed'}</button>
      </div>
      {GOAL_DEFS.filter((g) => showCompleted || !meta.goalsCompleted[g.id]).map((g) => {
        const done = !!meta.goalsCompleted[g.id];
        const [cur, target] = g.progress(ctx);
        const met = cur >= target;
        return (
          <div key={g.id} className="rounded-xl p-3 flex items-center gap-3" style={{ background: cardBg, border: `1px solid ${done ? teal : cardBorder}`, opacity: done ? 0.6 : 1 }}>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold" style={{ color: textMain }}>{done ? '✓ ' : ''}{g.desc}</div>
              <div className="text-xs font-mono mt-0.5" style={{ color: textDim }}>
                {done ? 'Completed' : `${fmt(cur)}/${fmt(target)}`} &middot; +{g.xp} xp &middot; +{g.wafers} wafers
              </div>
            </div>
            {!done && met && (
              <button onClick={() => onClaimGoal(g)} className="rounded-lg px-3 py-2 text-xs font-semibold" style={{ background: amber, color: '#0E141B' }}>Claim</button>
            )}
          </div>
        );
      })}

      <div className="mt-4 mb-1 text-xs font-mono uppercase tracking-wide" style={{ color: violet }}>Ongoing &mdash; always another one</div>
      {REPEATABLE_DEFS.map((def) => {
        const level = meta.repeatable[def.id] || 0;
        const target = def.target(level);
        const cur = def.metric(ctx);
        const met = cur >= target;
        return (
          <div key={def.id} className="rounded-xl p-3 flex items-center gap-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold" style={{ color: textMain }}>{def.desc(target)}</div>
              <div className="text-xs font-mono mt-0.5" style={{ color: textDim }}>
                {fmt(cur)}/{fmt(target)} &middot; +{def.xp(level)} xp &middot; +{def.wafers(level)} wafers &middot; tier {level + 1}
              </div>
            </div>
            {met && (
              <button onClick={() => onClaimRepeatable(def)} className="rounded-lg px-3 py-2 text-xs font-semibold" style={{ background: violet, color: '#0E141B' }}>Claim</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
