import { Zap } from 'lucide-react';
import { inset, amber, textMain, textDim, cardBorder } from '../theme.js';

// anomalyState: { label, expiresAt } | null - timing (expiresAt) comes from
// canon (server.anomalyExpiresAt), not rolled locally. windowMs is the full
// anomaly window length (config.anomaly.windowMs) used only to size the
// countdown bar.
export default function AnomalyToast({ anomalyState, windowMs, onClaim }) {
  if (!anomalyState) return null;
  return (
    <div className="fixed left-4 right-4 bottom-4 z-20 max-w-sm mx-auto">
      <button onClick={onClaim} className="w-full rounded-xl p-3 text-left flex items-center gap-3" style={{ background: inset, border: `1px solid ${amber}`, boxShadow: '0 8px 24px rgba(0,0,0,0.45)' }}>
        <Zap size={20} color={amber} className="event-icon" />
        <div className="flex-1">
          <div className="text-sm font-semibold" style={{ color: textMain }}>{anomalyState.label}</div>
          <div className="text-xs" style={{ color: textDim }}>tap to investigate</div>
          <div className="h-1 rounded mt-1" style={{ background: cardBorder }}>
            <div className="h-1 rounded" style={{ background: amber, width: `${Math.max(0, ((anomalyState.expiresAt - Date.now()) / windowMs) * 100)}%` }} />
          </div>
        </div>
      </button>
    </div>
  );
}
