import { Zap } from 'lucide-react';
import { inset, amber, textMain, textDim, cardBorder } from '../theme.js';
import { EVENT_WINDOW } from '../constants.js';

export default function EventToast({ eventState, onClaim }) {
  if (!eventState) return null;
  return (
    <div className="fixed left-4 right-4 bottom-4 z-20 max-w-sm mx-auto">
      <button onClick={onClaim} className="w-full rounded-xl p-3 text-left flex items-center gap-3" style={{ background: inset, border: `1px solid ${amber}`, boxShadow: '0 8px 24px rgba(0,0,0,0.45)' }}>
        <Zap size={20} color={amber} className="event-icon" />
        <div className="flex-1">
          <div className="text-sm font-semibold" style={{ color: textMain }}>{eventState.label}</div>
          <div className="text-xs" style={{ color: textDim }}>tap to investigate</div>
          <div className="h-1 rounded mt-1" style={{ background: cardBorder }}>
            <div className="h-1 rounded" style={{ background: amber, width: `${Math.max(0, ((eventState.expiresAt - Date.now()) / EVENT_WINDOW) * 100)}%` }} />
          </div>
        </div>
      </button>
    </div>
  );
}
