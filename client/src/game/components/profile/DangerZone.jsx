import { AlertTriangle, RotateCcw } from 'lucide-react';
import { danger } from '../../theme.js';

export default function DangerZone({ onOpenReset }) {
  return (
    <div className="rounded-lg p-3" style={{ border: `1px solid ${danger}`, background: 'rgba(224,92,76,0.08)' }}>
      <div className="flex items-center gap-1.5 text-xs font-semibold mb-2" style={{ color: danger }}>
        <AlertTriangle size={13} /> DANGER ZONE
      </div>
      <button onClick={onOpenReset} className="text-xs flex items-center gap-1" style={{ color: danger }}>
        <RotateCcw size={12} /> Reset progress
      </button>
    </div>
  );
}
