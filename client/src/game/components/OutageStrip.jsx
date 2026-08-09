import { AlertTriangle, CalendarClock } from 'lucide-react';
import { cardBorder, textDim, danger, amber } from '../theme.js';
import { activeAt } from '@shared/outages.js';
import { GRID_DEFS, TIER_DEFS } from '@shared/gameData.js';

// One coherent story about a slowdown, read from server.outages - the single
// representation every source shares (spec §3). There is no separate hazard
// list and maintenance list to reconcile here because there is no separate
// list anywhere.
const KIND_LABEL = {
  ransomware: 'ransomware',
  ispOutage: 'ISP outage',
  driveFailure: 'drive failure',
  maintenance: 'maintenance',
  overheat: 'overheat',
};

function scopeLabel(scope) {
  if (!scope) return 'Something';
  if (scope.lane === '*') return 'All lanes';
  if (scope.lane === 'grid') {
    const def = GRID_DEFS[scope.index];
    return def ? `Grid: ${def.name}` : 'Grid';
  }
  if (scope.lane === 'tiers') {
    const def = TIER_DEFS[scope.index];
    return def ? def.name : 'A rack tier';
  }
  return 'Overclock';
}

function remaining(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function OutageStrip({ outages, gridMaintenance, now }) {
  const live = activeAt(outages, now);
  const upcoming = gridMaintenance && gridMaintenance.startAt > now ? gridMaintenance : null;
  if (live.length === 0 && !upcoming) return null;

  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="outage-strip">
      {live.map((o) => (
        <div
          key={o.id}
          className="rounded-md px-2 py-1 text-xs flex items-center gap-1.5"
          style={{ background: 'rgba(220,60,60,0.08)', border: `1px solid ${danger}`, color: danger }}
        >
          <AlertTriangle size={12} />
          <span>
            {scopeLabel(o.scope)}
            {o.factor === 0 ? ' offline' : ` at ${Math.round(o.factor * 100)}%`}
            {' · '}{KIND_LABEL[o.kind] || o.kind}
            {' · '}{remaining(o.endAt - now)} left
          </span>
        </div>
      ))}
      {/* Maintenance is telegraphed (spec decision 3) - the one thing in this
          release the player gets to see coming and route around. */}
      {upcoming && (
        <div
          className="rounded-md px-2 py-1 text-xs flex items-center gap-1.5"
          style={{ background: 'rgba(240,180,60,0.08)', border: `1px solid ${cardBorder}`, color: amber }}
        >
          <CalendarClock size={12} />
          <span style={{ color: textDim }}>
            Scheduled maintenance: {scopeLabel({ lane: 'grid', index: upcoming.index })}
            {' · in '}{remaining(upcoming.startAt - now)}
          </span>
        </div>
      )}
    </div>
  );
}
