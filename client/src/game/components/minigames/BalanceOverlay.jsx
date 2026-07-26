import { useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import { textDim, textMain, danger, teal, amber, inset, cardBorder } from '../../theme.js';

// Needle animation speed isn't part of the server-config surface (there's no
// tunable for it) - kept as local literals rather than round-tripping
// through config.
const BASE_SPEED = 0.024; // % of bar per ms
const SPEED_VARIANCE = 0.010; // +/- fluctuation applied periodically

// Smooth, rAF-driven indicator. Position lives in a ref and is painted
// directly onto the DOM node each frame - keeping 60fps motion out of
// React's render cycle. score/timeLeft stay in the shared `minigame` state
// (low frequency, needed by the orchestrator's finish/payout logic).
export default function BalanceOverlay({ minigame, balanceConfig: z, onScore, onCancel }) {
  const needleRef = useRef(null);
  const posRef = useRef(0);
  const dirRef = useRef(1);
  const speedRef = useRef(BASE_SPEED);
  const lastFrameRef = useRef(null);
  const nextSpeedNudgeRef = useRef(0);

  useEffect(() => {
    let rafId;
    const loop = (t) => {
      if (lastFrameRef.current == null) lastFrameRef.current = t;
      const dt = t - lastFrameRef.current;
      lastFrameRef.current = t;

      if (t >= nextSpeedNudgeRef.current) {
        speedRef.current = BASE_SPEED + (Math.random() * 2 - 1) * SPEED_VARIANCE;
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

  // Single scoring path for every "attempt" in the game: the bar's own
  // click, the STABILIZE button, and the backdrop's miss handler all funnel
  // through here so the three-zone payout logic lives in exactly one place.
  // `forceMiss` is set by the backdrop only - a click outside the bar/button
  // isn't aimed at the needle at all, so it's unconditionally a miss
  // regardless of where the needle happens to be; the bar/button instead
  // score off the needle's *current* position at the moment of the click.
  function attemptScore(e, forceMiss) {
    if (e) e.stopPropagation();
    let delta;
    if (forceMiss) {
      delta = -z.missPenalty;
    } else {
      const p = posRef.current;
      const inRiskZone = (p >= z.safeZoneMin && p <= z.safeZoneMin + z.riskZoneWidth)
        || (p >= z.safeZoneMax - z.riskZoneWidth && p <= z.safeZoneMax);
      const inSafeZone = p > z.safeZoneMin && p < z.safeZoneMax;
      if (inRiskZone) delta = z.pointsRisk;
      else if (inSafeZone) delta = z.pointsSafe;
      else delta = -z.missPenalty;
    }
    onScore(delta);
  }
  function handleCancelClick(e) {
    e.stopPropagation();
    onCancel();
  }

  return (
    <div data-testid="balance-overlay" className="fixed inset-0 z-30 flex items-center justify-center p-4" style={{ background: 'rgba(10,14,19,0.96)' }} onClick={(e) => attemptScore(e, true)}>
      <div className="w-full max-w-sm text-center">
        <button onClick={handleCancelClick} data-testid="balance-cancel" className="absolute top-4 right-4" style={{ color: textDim }}><X size={22} /></button>
        <div className="flex justify-between font-mono text-sm mb-6" style={{ color: textDim }}>
          <span>{minigame.timeLeft}s left</span>
          <span data-testid="balance-score" style={{ color: danger }}>{minigame.score} stabilized</span>
        </div>
        <div data-testid="balance-bar" className="relative h-8 rounded-full mb-8 cursor-pointer" style={{ background: inset, border: `1px solid ${cardBorder}` }} onClick={(e) => attemptScore(e, false)}>
          <div data-testid="balance-zone-safe" className="absolute top-0 bottom-0" style={{ left: `${z.safeZoneMin}%`, width: `${z.safeZoneMax - z.safeZoneMin}%`, background: 'rgba(79,195,176,0.25)', borderLeft: `1px solid ${teal}`, borderRight: `1px solid ${teal}` }} />
          <div data-testid="balance-zone-risk-low" className="absolute top-0 bottom-0" style={{ left: `${z.safeZoneMin}%`, width: `${z.riskZoneWidth}%`, background: 'rgba(232,163,61,0.35)' }} />
          <div data-testid="balance-zone-risk-high" className="absolute top-0 bottom-0" style={{ left: `${z.safeZoneMax - z.riskZoneWidth}%`, width: `${z.riskZoneWidth}%`, background: 'rgba(232,163,61,0.35)' }} />
          <div ref={needleRef} data-testid="balance-needle" className="absolute top-0 bottom-0 w-1.5 rounded" style={{ left: 'calc(0% - 3px)', background: danger }} />
        </div>
        <div className="text-xs mb-4" style={{ color: textDim }}>
          Click the bar or press STABILIZE while the marker is in the safe zone &mdash; the <span style={{ color: amber }}>amber edges</span> pay more but clicking outside the zone entirely costs points
        </div>
        <button onClick={(e) => attemptScore(e, false)} data-testid="balance-stabilize" className="w-full rounded-2xl py-4 text-base font-bold" style={{ background: danger, color: textMain }}>
          STABILIZE
        </button>
      </div>
    </div>
  );
}
