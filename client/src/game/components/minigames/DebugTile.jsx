import { Bug } from 'lucide-react';
import { teal, inset, cardBorder } from '../../theme.js';

// Uses onPointerDown (not onClick) so simultaneous multi-finger taps on
// different tiles each register independently - a browser only synthesizes
// one `click` per gesture even under multi-touch, but pointerdown fires per
// finger/pointer. Deliberately no onClick alongside it (would double-fire
// via the browser's synthesized click-after-pointerdown).
export default function DebugTile({ idx, lit, onTap }) {
  const isLit = lit.includes(idx);
  return (
    <button
      onPointerDown={(e) => { e.preventDefault(); onTap(idx); }}
      className="aspect-square rounded-xl flex items-center justify-center"
      style={{ background: isLit ? teal : inset, border: `1px solid ${cardBorder}`, touchAction: 'manipulation' }}
    >
      {isLit && <Bug size={26} color="#0E141B" />}
    </button>
  );
}
