import { CircuitBoard, Gem, Zap } from 'lucide-react';
import { cardBg, cardBorder, textDim, amber, teal, violet } from '../theme.js';
import { fmt, fmtCores, CORE_FORMAT_LABELS } from '../helpers.js';
import { useCoreFormat, cycleCoreFormat } from '../coreFormat.js';

export default function StatsRow({ run, meta, totalOutputPerSec, xpNeeded, boost, boostMultNow }) {
  // Tapping the chip cycles Full -> ABC -> Sci in place; the same setting
  // also lives in Profile > Settings for players who'd rather pick it there.
  const coreFormat = useCoreFormat();
  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-3" data-tour="header-stats">
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
        <button
          type="button"
          onClick={cycleCoreFormat}
          title={`Core number format: ${CORE_FORMAT_LABELS[coreFormat]} (tap to change)`}
          aria-label={`Legacy cores: ${fmtCores(meta.legacyCores, coreFormat)}. Tap to change the number format.`}
          data-testid="cores-chip"
          className="flex items-center gap-1 font-mono"
          style={{ color: teal, cursor: 'pointer' }}
        >
          <CircuitBoard size={13} /> {fmtCores(meta.legacyCores, coreFormat)} cores
        </button>
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
