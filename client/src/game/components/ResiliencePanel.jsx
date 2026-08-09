import { ShieldAlert, ShieldCheck, Zap } from 'lucide-react';
import { cardBg, cardBorder, inset, textMain, textDim, teal, danger, amber, buyBtnStyle } from '../theme.js';
import { fmt } from '../helpers.js';
import {
  SUPPLY_IDS, supplyPrice, cureCost, hazardRatePerHour, activeAt,
} from '@shared/outages.js';

const SUPPLY_META = {
  antivirus: {
    name: 'Antivirus licence',
    counters: 'Ransomware',
    blurb: 'Absorbs one ransomware incident - even while you are away.',
  },
  backupIsp: {
    name: 'Backup ISP line',
    counters: 'ISP outage',
    blurb: 'Keeps the Grid up through one connectivity failure.',
  },
  spareDrives: {
    name: 'Spare drive',
    counters: 'Drive failure',
    blurb: 'Swaps in for one failed rack tier before it costs you anything.',
  },
};

export default function ResiliencePanel({
  state, config, totalOutputPerSec, now, onBuySupply, onResolveOutage,
}) {
  const rate = hazardRatePerHour(config);
  // The RATE, never the next time (spec decision 3) - showing nextHazardAt
  // would turn the prepaid economy into buying one licence twenty minutes
  // before it fires.
  const perHours = rate > 0 ? Math.round(1 / rate) : 0;
  const live = activeAt(state.server.outages, now);
  const curable = live.filter((o) => o.source === 'hazard' && o.endAt > now);

  return (
    <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3">
      <div
        className="rounded-xl p-3"
        style={{ background: cardBg, border: `1px solid ${cardBorder}` }}
        data-tour="resilience-risk"
      >
        <div className="flex items-center gap-2 text-sm font-semibold mb-1" style={{ color: textMain }}>
          <ShieldAlert size={16} color={amber} /> Standing risk
        </div>
        <div className="text-xs" style={{ color: textDim }}>
          {rate > 0
            ? `Roughly one incident every ${perHours}h. You are never told when - stock up instead.`
            : 'No incidents are currently possible.'}
        </div>
      </div>

      {curable.length > 0 && (
        <div className="rounded-xl p-3 flex flex-col gap-2" style={{ background: cardBg, border: `1px solid ${danger}` }}>
          <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: danger }}>
            <Zap size={16} /> Running incidents
          </div>
          {curable.map((o) => {
            const cost = cureCost(o, config, totalOutputPerSec, now);
            const affordable = state.run.credits >= cost;
            return (
              <button
                key={o.id}
                data-testid={`cure-${o.id}`}
                onClick={() => onResolveOutage(o.id)}
                disabled={!affordable}
                className="rounded-lg py-2 text-xs font-mono w-full"
                style={buyBtnStyle(affordable)}
              >
                Resolve now &middot; {fmt(cost)}
              </button>
            );
          })}
          <div className="text-[11px]" style={{ color: textDim }}>
            Always dearer than having stocked the supply. Preparation is the cheap path.
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2" data-tour="resilience-supplies">
        {SUPPLY_IDS.map((id) => {
          const meta = SUPPLY_META[id];
          const stock = (state.meta.supplies && state.meta.supplies[id]) || 0;
          const cost = supplyPrice(id, config, totalOutputPerSec);
          const affordable = state.run.credits >= cost;
          return (
            <div key={id} className="tier-card rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
              <div className="flex items-center gap-3">
                <div className="rounded-lg p-2" style={{ background: inset }}>
                  <ShieldCheck size={20} color={stock > 0 ? teal : textDim} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <div className="font-semibold text-sm truncate" style={{ color: textMain }}>{meta.name}</div>
                    <div className="font-mono text-xs" style={{ color: stock > 0 ? teal : textDim }}>&times;{stock}</div>
                  </div>
                  <div className="text-xs" style={{ color: textDim }}>Counters {meta.counters}. {meta.blurb}</div>
                </div>
              </div>
              <button
                data-testid={`supply-buy-${id}`}
                onClick={() => onBuySupply(id)}
                disabled={!affordable}
                className="rounded-lg py-2 text-xs font-mono w-full mt-2"
                style={buyBtnStyle(affordable)}
              >
                Buy 1 &middot; {fmt(cost)}
              </button>
            </div>
          );
        })}
      </div>

      <div className="rounded-lg p-3 text-xs" style={{ background: cardBg, border: `1px solid ${cardBorder}`, color: textDim }}>
        Supplies are spent automatically the moment a matching incident starts - including while you are offline, which is the only defence that can reach one. They survive a Migrate, so spend down before you prestige rather than watching the balance evaporate. Cold Storage is never affected by any of this.
      </div>
    </div>
  );
}
