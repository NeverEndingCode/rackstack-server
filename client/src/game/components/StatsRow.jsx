import { CircuitBoard, Gem, Zap } from 'lucide-react';
import { cardBg, cardBorder, textDim, amber, teal, violet } from '../theme.js';
import { fmt } from '../helpers.js';

export default function StatsRow({ run, meta, totalOutputPerSec, xpNeeded, boost, boostMultNow }) {
  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="rounded-lg p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
          <div className="text-xs uppercase tracking-wide" style={{ color: textDim }}>Compute Balance</div>
          <div className="font-mono text-2xl tabular-nums" style={{ color: amber }}>{fmt(run.credits)} <span className="text-sm">F</span></div>
        </div>
        <div className="rounded-lg p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
          <div className="text-xs uppercase tracking-wide" style={{ color: textDim }}>Total Output</div>
          <div className="font-mono text-2xl tabular-nums" style={{ color: teal }}>{fmt(totalOutputPerSec)} <span className="text-sm">F/s</span></div>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-3 text-xs font-mono" style={{ color: textDim }}>
        <span className="flex items-center gap-1" style={{ color: teal }}><CircuitBoard size={13} /> {meta.legacyCores} cores</span>
        <span className="flex items-center gap-1" style={{ color: violet }}><Gem size={13} /> {fmt(meta.wafers)} wafers</span>
        <span className="flex-1 h-1 rounded" style={{ background: cardBorder }}>
          <span className="block h-1 rounded" style={{ background: violet, width: `${Math.min(100, (meta.xp / xpNeeded) * 100)}%` }} />
        </span>
        <span>{meta.xp}/{xpNeeded} xp</span>
      </div>

      {boostMultNow > 1 && (
        <div className="mt-2 rounded-lg px-3 py-1.5 text-xs font-mono flex items-center justify-between" style={{ background: 'rgba(232,163,61,0.12)', border: `1px solid ${amber}`, color: amber }}>
          <span className="flex items-center gap-1"><Zap size={13} /> Surge active &times;{boost.mult}</span>
          <span>{Math.max(0, Math.ceil((boost.until - Date.now()) / 1000))}s</span>
        </div>
      )}
    </>
  );
}
