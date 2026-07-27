import { X } from 'lucide-react';
import { textDim, violet, teal, inset, cardBorder } from '../../theme.js';
import { MATCH_ICONS } from '../../data/minigameIcons.js';

export default function MatchOverlay({ minigame, pairCount, onTap, onCancel }) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-4" style={{ background: 'rgba(10,14,19,0.96)' }}>
      <div className="w-full max-w-sm text-center">
        <button onClick={onCancel} className="absolute top-4 right-4" style={{ color: textDim }}><X size={22} /></button>
        <div className="flex justify-between font-mono text-sm mb-4" style={{ color: textDim }}>
          <span>{minigame.timeLeft}s left</span>
          <span style={{ color: violet }}>{minigame.pairsFound}/{pairCount} pairs</span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {minigame.order.map((iconIdx, idx) => {
            const shown = minigame.revealed[idx] || minigame.matched[idx];
            const TileIcon = MATCH_ICONS[iconIdx];
            return (
              <button
                key={idx}
                onClick={() => onTap(idx)}
                className="aspect-square rounded-xl flex items-center justify-center"
                style={{ background: minigame.matched[idx] ? teal : shown ? violet : inset, border: `1px solid ${cardBorder}` }}
              >
                {shown && <TileIcon size={20} color="#0E141B" />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
