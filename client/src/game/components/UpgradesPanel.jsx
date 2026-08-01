import { Gem } from 'lucide-react';
import { cardBg, cardBorder, textMain, textDim, violet, buyBtnStyle } from '../theme.js';
import { fmt } from '../helpers.js';
import { UPGRADE_DEFS } from '../data/upgrades.js';

export default function UpgradesPanel({ meta, onBuy }) {
  return (
    <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3" data-tour="upgrades-list">
      <div className="rounded-lg p-3 text-xs" style={{ background: cardBg, border: `1px solid ${cardBorder}`, color: textDim }}>
        Bought with Silicon Wafers, earned from Goals and minigames. These upgrades survive Migrate.
      </div>
      {UPGRADE_DEFS.map((u) => {
        const level = meta.upgrades[u.id] || 0;
        const maxed = level >= u.maxLevel;
        const cost = Math.ceil(u.baseCost * Math.pow(u.costMult, level));
        const afford = meta.wafers >= cost;
        return (
          <div key={u.id} className="rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
            <div className="flex items-center justify-between">
              <div className="font-semibold text-sm" style={{ color: textMain }}>{u.name}</div>
              <div className="font-mono text-xs" style={{ color: violet }}>Lv {level}/{u.maxLevel}</div>
            </div>
            <div className="text-xs mt-0.5" style={{ color: textDim }}>{u.desc}</div>
            <button
              onClick={() => onBuy(u)}
              disabled={maxed || !afford}
              className="mt-2 w-full rounded-lg py-2 text-xs font-mono flex items-center justify-center gap-1"
              style={buyBtnStyle(!maxed && afford)}
            >
              {maxed ? 'MAXED' : (<><Gem size={12} /> {fmt(cost)} wafers</>)}
            </button>
          </div>
        );
      })}
    </div>
  );
}
