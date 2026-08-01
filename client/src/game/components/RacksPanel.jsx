import { costAt, costForN, maxAffordable, milestoneMult, nextMilestone, tierRate, fmt } from '../helpers.js';
import { cardBg, cardBorder, inset, textMain, textDim, amber, teal, buyBtnStyle } from '../theme.js';
import { TIER_DEFS } from '../data/tiers.js';

export default function RacksPanel({ run, unlockedUpTo, racksMult, thresholds, eff, onBuy, onCollect, onHire }) {
  const LockedIcon = unlockedUpTo + 1 < TIER_DEFS.length ? TIER_DEFS[unlockedUpTo + 1].Icon : null;
  return (
    <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3">
      {TIER_DEFS.slice(0, unlockedUpTo + 1).map((def, i) => {
        const ts = run.tiers[i];
        const rate = tierRate(ts.owned, def.baseProd, racksMult, thresholds);
        const cost1 = costAt(def, ts.owned);
        const cost10 = costForN(def, ts.owned, 10);
        const maxN = maxAffordable(def, ts.owned, run.credits);
        const affordable1 = run.credits >= cost1;
        const Icon = def.Icon;
        const msMult = milestoneMult(ts.owned, thresholds);
        const nextMs = nextMilestone(ts.owned, thresholds);
        const managerCost = def.managerCost * eff.automationDiscount;
        return (
          <div key={def.id} className="tier-card rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}`, animationDelay: `${i * 40}ms` }}>
            <div className="flex items-center gap-3">
              <div className="rounded-lg p-2" style={{ background: inset }}>
                <Icon size={22} color={ts.owned > 0 ? amber : textDim} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm truncate" style={{ color: textMain }}>{def.name}</div>
                  <div className="font-mono text-xs" style={{ color: textDim }}>&times;{ts.owned}</div>
                </div>
                <div className="text-xs font-mono" style={{ color: textDim }}>
                  {fmt(rate)} F/s{ts.manager ? ' · automated' : ''}
                  {msMult > 1 && <span style={{ color: teal }}> &middot; &times;{msMult} milestone</span>}
                </div>
              </div>
            </div>

            {ts.owned > 0 && (
              <div className="flex items-center gap-1 mt-2">
                {Array.from({ length: Math.min(ts.owned, 10) }).map((_, k) => (
                  <div key={k} className="led-on" style={{ width: 6, height: 6, borderRadius: 2, background: amber, animationDelay: `${k * 90}ms` }} />
                ))}
                {ts.owned > 10 && <span className="text-xs font-mono ml-1" style={{ color: textDim }}>+{ts.owned - 10}</span>}
              </div>
            )}

            {nextMs && (
              <div className="mt-1.5">
                <div className="h-1 rounded" style={{ background: cardBorder }}>
                  <div className="h-1 rounded" style={{ background: teal, width: `${Math.min(100, (ts.owned / nextMs) * 100)}%` }} />
                </div>
                <div className="text-xs font-mono mt-0.5" style={{ color: textDim }}>{ts.owned}/{nextMs} to next &times;2</div>
              </div>
            )}

            <div className="flex items-center gap-2 mt-3">
              {/* v1.6: stays mounted until the tier is automated, so it no
                  longer vanishes for a frame after each collect - the
                  "nothing banked yet" test moved onto `disabled`. */}
              {!ts.manager && ts.owned >= 1 && (
                <button
                  onClick={() => onCollect(i)}
                  disabled={ts.ready <= 0.01}
                  className="collect-pop rounded-lg px-3 py-2 text-xs font-semibold flex-1"
                  style={ts.ready > 0.01
                    ? { background: teal, color: '#0E141B' }
                    : { ...buyBtnStyle(false), cursor: 'not-allowed' }}
                >
                  Collect {fmt(ts.ready)}
                </button>
              )}
              {!ts.manager && ts.owned >= 1 && (
                <button onClick={() => onHire(i)} disabled={run.credits < managerCost} className="rounded-lg px-3 py-2 text-xs font-semibold" style={buyBtnStyle(run.credits >= managerCost)}>
                  Automate ({fmt(managerCost)})
                </button>
              )}
            </div>

            <div className="grid grid-cols-3 gap-2 mt-2">
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
          </div>
        );
      })}

      {LockedIcon && (
        <div className="rounded-xl p-3 flex items-center gap-3" style={{ background: 'rgba(22,31,43,0.5)', border: `1px dashed ${cardBorder}` }}>
          <div className="rounded-lg p-2" style={{ background: inset, opacity: 0.5 }}>
            <LockedIcon size={22} color={textDim} />
          </div>
          <div>
            <div className="font-semibold text-sm" style={{ color: textDim }}>{TIER_DEFS[unlockedUpTo + 1].name}</div>
            <div className="text-xs" style={{ color: textDim }}>Own 1 {TIER_DEFS[unlockedUpTo].name} to unlock</div>
          </div>
        </div>
      )}
    </div>
  );
}
