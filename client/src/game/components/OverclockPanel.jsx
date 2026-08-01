import { Flame, Snowflake, AlertTriangle } from 'lucide-react';
import { costAt, costForN, maxAffordable, milestoneMult, nextMilestone, tierRate, fmt } from '../helpers.js';
import { cardBg, cardBorder, inset, textMain, textDim, amber, teal, danger, buyBtnStyle } from '../theme.js';
import { OVERCLOCK_DEFS } from '../data/tiers.js';

export default function OverclockPanel({ run, overclockMult, thresholds, onBuy, onVent, ventDisabled, heatColor, onCooldown, cooldownSecondsLeft, ventPercent, overheatCooldownMs }) {
  const ventBlocked = ventDisabled || onCooldown;
  return (
    <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3">
      <div className="rounded-xl p-4" style={{ background: cardBg, border: `1px solid ${heatColor}` }} data-tour="overclock-heat">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: textMain }}><Flame size={16} color={heatColor} /> Heat</div>
          <div className="font-mono text-sm" style={{ color: heatColor }}>{Math.round(run.heat)}%</div>
        </div>
        <div className="h-2 rounded" style={{ background: cardBorder }}>
          <div className="h-2 rounded" style={{ background: heatColor, width: `${run.heat}%` }} />
        </div>
        {run.heat > 80 && !onCooldown && (
          <div className="text-xs mt-1 flex items-center gap-1" style={{ color: danger }}>
            <AlertTriangle size={12} /> Overheating risk &mdash; vent now to avoid a mandatory cooldown
          </div>
        )}
        {onCooldown && (
          <div className="text-xs mt-1 flex items-center gap-1" style={{ color: danger }}>
            <AlertTriangle size={12} /> Overclock lane frozen after meltdown &mdash; {cooldownSecondsLeft}s left
          </div>
        )}
        <button onClick={onVent} disabled={ventBlocked} data-tour="overclock-vent" className="mt-3 w-full rounded-lg py-2 text-sm font-semibold flex items-center justify-center gap-2" style={{ background: ventBlocked ? cardBg : teal, color: ventBlocked ? textDim : '#0E141B', border: `1px solid ${cardBorder}`, cursor: ventBlocked ? 'not-allowed' : 'pointer' }}>
          <Snowflake size={16} /> Vent Heat (-{Math.round(ventPercent)}%)
        </button>
      </div>
      <div className="rounded-lg p-3 text-xs" style={{ background: cardBg, border: `1px solid ${cardBorder}`, color: textDim }}>
        Overclock nodes run on their own like the Grid, but generate heat. Let it hit 100% and the lane freezes for {Math.round(overheatCooldownMs / 1000)}s while it cools down - no nodes are ever lost. Venting sheds {Math.round(ventPercent)}% of your heat capacity, so keep venting to avoid the lockout.
      </div>
      {OVERCLOCK_DEFS.map((def, i) => {
        const o = run.overclock[i];
        const rate = tierRate(o.owned, def.baseProd, overclockMult, thresholds);
        const cost1 = costAt(def, o.owned);
        const cost10 = costForN(def, o.owned, 10);
        const maxN = maxAffordable(def, o.owned, run.credits);
        const affordable1 = run.credits >= cost1 && !onCooldown;
        const Icon = def.Icon;
        const msMult = milestoneMult(o.owned, thresholds);
        const nextMs = nextMilestone(o.owned, thresholds);
        return (
          <div key={def.id} className="tier-card rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}`, animationDelay: `${i * 40}ms` }}>
            <div className="flex items-center gap-3">
              <div className="rounded-lg p-2" style={{ background: inset }}>
                <Icon size={22} color={o.owned > 0 ? danger : textDim} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm truncate" style={{ color: textMain }}>{def.name}</div>
                  <div className="font-mono text-xs" style={{ color: textDim }}>&times;{o.owned}</div>
                </div>
                <div className="text-xs font-mono" style={{ color: textDim }}>
                  {fmt(rate)} F/s &middot; {def.heatPerSec.toFixed(2)} heat/s each
                  {msMult > 1 && <span style={{ color: teal }}> &middot; &times;{msMult} milestone</span>}
                </div>
              </div>
            </div>
            {nextMs && (
              <div className="mt-1.5">
                <div className="h-1 rounded" style={{ background: cardBorder }}>
                  <div className="h-1 rounded" style={{ background: teal, width: `${Math.min(100, (o.owned / nextMs) * 100)}%` }} />
                </div>
                <div className="text-xs font-mono mt-0.5" style={{ color: textDim }}>{o.owned}/{nextMs} to next &times;2</div>
              </div>
            )}
            <div className="grid grid-cols-3 gap-2 mt-3">
              <button onClick={() => onBuy(i, 1)} disabled={!affordable1} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(affordable1)}>
                +1 &middot; {fmt(cost1)}
              </button>
              <button onClick={() => onBuy(i, 10)} disabled={run.credits < cost10 || onCooldown} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(run.credits >= cost10 && !onCooldown)}>
                +10 &middot; {fmt(cost10)}
              </button>
              <button onClick={() => onBuy(i, 'max')} disabled={maxN < 1 || onCooldown} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(maxN >= 1 && !onCooldown)}>
                Max{maxN >= 1 ? ` +${maxN}` : ''}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
