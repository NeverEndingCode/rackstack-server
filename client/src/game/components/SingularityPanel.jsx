import { Sparkles, Gem } from 'lucide-react';
import { cardBg, violet, textMain, textDim } from '../theme.js';
import { SINGULARITY_DEFS } from '../data/upgrades.js';
import { fmtCores } from '../helpers.js';
import { useCoreFormat } from '../coreFormat.js';

export default function SingularityPanel({ meta, config, singularityGain, onOpenSingularityConfirm, onBuyShard }) {
  const coreFormat = useCoreFormat();
  return (
    <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3" data-tour="singularity-list">
      <div className="rounded-xl p-4" style={{ background: cardBg, border: `1px solid ${violet}` }}>
        <div className="flex items-center gap-2 mb-1">
          <Sparkles size={16} color={violet} />
          <div className="font-semibold text-sm" style={{ color: violet }}>Trigger a Singularity</div>
        </div>
        <div className="text-xs mb-3" style={{ color: textDim }}>
          Converts all {fmtCores(meta.legacyCores, coreFormat)} Legacy Cores into Singularity Shards, spent below on permanent perks. Wipes your current run AND your Legacy Cores. Wafers, Upgrades, Level, and Goals are untouched.
        </div>
        <div className="font-mono text-lg mb-3" style={{ color: violet }}>+{singularityGain} Shards</div>
        <button onClick={onOpenSingularityConfirm} disabled={singularityGain <= 0} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: singularityGain > 0 ? violet : cardBg, color: singularityGain > 0 ? '#0E141B' : textDim, cursor: singularityGain > 0 ? 'pointer' : 'not-allowed' }}>
          Trigger Singularity
        </button>
      </div>
      <div className="font-mono text-sm flex items-center gap-1" style={{ color: violet }}><Gem size={14} /> {meta.singularityShards} Shards available</div>
      {SINGULARITY_DEFS.map((u) => {
        const level = meta.shardUpgrades[u.id] || 0;
        // Max level is read live from config.upgrades.maxLevels (admin-tunable,
        // same source the reducer's buyShardUpgrade() enforces) rather than the
        // static u.maxLevel on the def.
        const maxLevel = (config.upgrades.maxLevels && config.upgrades.maxLevels[u.id]) ?? u.maxLevel;
        const maxed = level >= maxLevel;
        const cost = Math.ceil(u.baseCost * Math.pow(u.costMult, level));
        const afford = meta.singularityShards >= cost;
        return (
          <div key={u.id} className="rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${violet}` }}>
            <div className="flex items-center justify-between">
              <div className="font-semibold text-sm" style={{ color: textMain }}>{u.name}</div>
              <div className="font-mono text-xs" style={{ color: violet }}>Lv {level}/{maxLevel}</div>
            </div>
            <div className="text-xs mt-0.5" style={{ color: textDim }}>{u.desc}</div>
            <button
              onClick={() => onBuyShard(u)}
              disabled={maxed || !afford}
              className="mt-2 w-full rounded-lg py-2 text-xs font-mono flex items-center justify-center gap-1"
              style={{ background: !maxed && afford ? violet : cardBg, color: !maxed && afford ? '#0E141B' : textDim, opacity: !maxed && afford ? 1 : 0.55, cursor: !maxed && afford ? 'pointer' : 'not-allowed' }}
            >
              {maxed ? 'MAXED' : `${cost} shards`}
            </button>
          </div>
        );
      })}
    </div>
  );
}
