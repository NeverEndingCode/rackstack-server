import { X } from 'lucide-react';
import { amber, textDim } from '../../theme.js';

export default function RushOverlay({ minigame, onTap, onCancel }) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-4" style={{ background: 'rgba(10,14,19,0.96)' }}>
      <div className="w-full max-w-sm text-center">
        <button onClick={onCancel} className="absolute top-4 right-4" style={{ color: textDim }}><X size={22} /></button>
        <div className="font-mono text-sm mb-2" style={{ color: textDim }}>{minigame.timeLeft}s left</div>
        <div className="font-mono text-3xl mb-6" style={{ color: amber }}>{minigame.taps} taps</div>
        <button onClick={onTap} className="w-full rounded-2xl py-16 text-xl font-bold" style={{ background: amber, color: '#0E141B' }}>TAP</button>
      </div>
    </div>
  );
}
