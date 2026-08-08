import { costAt, costForN, maxAffordable, milestoneMult, nextMilestone, tierRate, fmt } from '../helpers.js';
import { cardBg, cardBorder, inset, textMain, textDim, teal, buyBtnStyle } from '../theme.js';
import { GRID_DEFS } from '../data/tiers.js';

export default function GridPanel({ run, gridMult, thresholds, onBuy }) {
  return (
    <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3" data-tour="grid-buy">
      <div className="rounded-lg p-3 text-xs" style={{ background: cardBg, border: `1px solid ${cardBorder}`, color: textDim }}>
        The Grid runs on its own &mdash; no automation needed. Volunteers contribute FLOPS straight to your total, all the time.
      </div>
      {GRID_DEFS.map((def, i) => {
        const g = run.grid[i];
        const rate = tierRate(g.owned, def.baseProd, gridMult, thresholds);
        const cost1 = costAt(def, g.owned);
        const cost10 = costForN(def, g.owned, 10);
        const maxN = maxAffordable(def, g.owned, run.credits);
        const affordable1 = run.credits >= cost1;
        const Icon = def.Icon;
        const msMult = milestoneMult(g.owned, thresholds);
        const nextMs = nextMilestone(g.owned, thresholds);
        return (
          <div key={def.id} className="tier-card rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}`, animationDelay: `${i * 40}ms` }}>
            <div className="flex items-center gap-3">
              <div className="rounded-lg p-2" style={{ background: inset }}>
                <Icon size={22} color={g.owned > 0 ? teal : textDim} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm truncate" style={{ color: textMain }}>{def.name}</div>
                  <div className="font-mono text-xs" style={{ color: textDim }}>&times;{g.owned}</div>
                </div>
                <div className="text-xs font-mono" style={{ color: textDim }}>
                  {fmt(rate)} F/s
                  {msMult > 1 && <span style={{ color: teal }}> &middot; &times;{msMult} milestone</span>}
                </div>
              </div>
            </div>
            {nextMs && (
              <div className="mt-1.5">
                <div className="h-1 rounded" style={{ background: cardBorder }}>
                  <div className="h-1 rounded" style={{ background: teal, width: `${Math.min(100, (g.owned / nextMs) * 100)}%` }} />
                </div>
                <div className="text-xs font-mono mt-0.5" style={{ color: textDim }}>{g.owned}/{nextMs} to next &times;2</div>
              </div>
            )}
            <div className="grid grid-cols-3 gap-2 mt-3">
              <button onClick={() => onBuy(i, 1)} disabled={!affordable1} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(affordable1)}>
                +1 &middot; {fmt(cost1)}
              </button>
              <button onClick={() => onBuy(i, 10)} disabled={run.credits < cost10} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(run.credits >= cost10)}>
                +10 &middot; {fmt(cost10)}
              </button>
              <button onClick={() => onBuy(i, 'max')} disabled={maxN < 1} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(maxN >= 1)}>
                Max{maxN >= 1 ? ` +${maxN}` : ''}
              </button>
            </div>
            {(() => {
              const next = nextMilestone(g.owned, thresholds);
              if (next === null) return null;          // past the last milestone
              const n = next - g.owned;
              const costN = costForN(def, g.owned, n);
              const affordable = run.credits >= costN;
              return (
                <button
                  onClick={() => onBuy(i, 'milestone')}
                  disabled={!affordable}
                  title={`Reach ${next} for a 2x output multiplier on this lane`}
                  className="rounded-lg py-2 text-xs font-mono w-full mt-2"
                  style={buyBtnStyle(affordable)}
                >
                  {`→ ${next}: ${n} for ${fmt(costN)}`}
                </button>
              );
            })()}
          </div>
        );
      })}
    </div>
  );
}
