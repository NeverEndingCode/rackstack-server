import { X } from 'lucide-react';
import { textDim, teal } from '../../theme.js';
import DebugTile from './DebugTile.jsx';

export default function DebugOverlay({ minigame, onTap, onCancel }) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-4" style={{ background: 'rgba(10,14,19,0.96)' }}>
      <div className="w-full max-w-sm text-center">
        <button onClick={onCancel} className="absolute top-4 right-4" style={{ color: textDim }}><X size={22} /></button>
        <div className="flex justify-between font-mono text-sm mb-4" style={{ color: textDim }}>
          <span>{minigame.timeLeft}s left</span>
          <span style={{ color: teal }}>{minigame.score} squashed</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {Array.from({ length: 9 }).map((_, idx) => (
            <DebugTile key={idx} idx={idx} lit={minigame.lit} onTap={onTap} />
          ))}
        </div>
      </div>
    </div>
  );
}
