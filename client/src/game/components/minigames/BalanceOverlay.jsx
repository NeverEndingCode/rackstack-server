import { useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import { textDim, danger, teal, inset, cardBorder } from '../../theme.js';
import { BALANCE_SAFE_ZONE_MIN, BALANCE_SAFE_ZONE_MAX, BALANCE_BASE_SPEED, BALANCE_SPEED_VARIANCE } from '../../constants.js';

// Smooth, rAF-driven indicator. Position lives in a ref and is painted
// directly onto the DOM node each frame - keeping 60fps motion out of
// React's render cycle. score/timeLeft stay in the shared `minigame` state
// (low frequency, needed by the orchestrator's finish/payout logic).
export default function BalanceOverlay({ minigame, onBarHit, onMiss, onCancel }) {
  const needleRef = useRef(null);
  const posRef = useRef(0);
  const dirRef = useRef(1);
  const speedRef = useRef(BALANCE_BASE_SPEED);
  const lastFrameRef = useRef(null);
  const nextSpeedNudgeRef = useRef(0);

  useEffect(() => {
    let rafId;
    const loop = (t) => {
      if (lastFrameRef.current == null) lastFrameRef.current = t;
      const dt = t - lastFrameRef.current;
      lastFrameRef.current = t;

      if (t >= nextSpeedNudgeRef.current) {
        speedRef.current = BALANCE_BASE_SPEED + (Math.random() * 2 - 1) * BALANCE_SPEED_VARIANCE;
        nextSpeedNudgeRef.current = t + 600 + Math.random() * 900;
      }

      let pos = posRef.current + dirRef.current * speedRef.current * dt;
      let dir = dirRef.current;
      if (pos >= 100) { pos = 100; dir = -1; } else if (pos <= 0) { pos = 0; dir = 1; }
      posRef.current = pos;
      dirRef.current = dir;
      if (needleRef.current) needleRef.current.style.left = `calc(${pos}% - 3px)`;

      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);

  function handleBarClick(e) {
    e.stopPropagation();
    const inZone = posRef.current >= BALANCE_SAFE_ZONE_MIN && posRef.current <= BALANCE_SAFE_ZONE_MAX;
    if (inZone) onBarHit();
  }
  function handleCancelClick(e) {
    e.stopPropagation();
    onCancel();
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-4" style={{ background: 'rgba(10,14,19,0.96)' }} onClick={onMiss}>
      <div className="w-full max-w-sm text-center">
        <button onClick={handleCancelClick} className="absolute top-4 right-4" style={{ color: textDim }}><X size={22} /></button>
        <div className="flex justify-between font-mono text-sm mb-6" style={{ color: textDim }}>
          <span>{minigame.timeLeft}s left</span>
          <span style={{ color: danger }}>{minigame.score} stabilized</span>
        </div>
        <div className="relative h-8 rounded-full mb-8 cursor-pointer" style={{ background: inset, border: `1px solid ${cardBorder}` }} onClick={handleBarClick}>
          <div className="absolute top-0 bottom-0" style={{ left: `${BALANCE_SAFE_ZONE_MIN}%`, width: `${BALANCE_SAFE_ZONE_MAX - BALANCE_SAFE_ZONE_MIN}%`, background: 'rgba(79,195,176,0.25)', borderLeft: `1px solid ${teal}`, borderRight: `1px solid ${teal}` }} />
          <div ref={needleRef} className="absolute top-0 bottom-0 w-1.5 rounded" style={{ left: 'calc(0% - 3px)', background: danger }} />
        </div>
        <div className="text-xs" style={{ color: textDim }}>Click the bar while the marker is in the safe zone &mdash; clicking elsewhere costs points</div>
      </div>
    </div>
  );
}
