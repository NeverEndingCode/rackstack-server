import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { cardBg, cardBorder, textMain, textDim, amber, teal } from '../theme.js';

const PAD = 8;          // spotlight padding around the anchor
const TOOLTIP_W = 320;
const TOOLTIP_H = 210;  // assumed height for the flip decision
const GAP = 12;         // gap between hole and tooltip

/**
 * Spotlight coach-marks. A dimmed full-viewport layer with a rounded hole cut
 * over the current step's anchor, plus a tooltip card.
 *
 * Anchors resolve by data-tour attribute rather than React refs, so panels
 * carry a single inert attribute instead of threading refs. An anchor that
 * resolves to nothing is NOT an error - the step degrades to a centered card
 * with no hole. A tour must never trap or blank the UI because a panel
 * changed shape.
 */
export default function TutorialOverlay({ steps, onStepChange, onFinish, onSkip }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState(null);
  const step = steps[i];
  const lastTabRef = useRef(undefined);

  // Ask for the step's tab BEFORE measuring - the panel has to be mounted.
  useEffect(() => {
    if (!step) return;
    if (step.tab && step.tab !== lastTabRef.current) {
      lastTabRef.current = step.tab;
      onStepChange(step.tab);
    }
  }, [step, onStepChange]);

  // Measure after the tab switch has painted.
  useLayoutEffect(() => {
    if (!step) return undefined;
    let raf1 = 0;
    let raf2 = 0;

    function measure() {
      if (!step.anchor) { setRect(null); return; }
      const el = document.querySelector(`[data-tour="${step.anchor}"]`);
      if (!el) { setRect(null); return; }
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    }

    // Two frames: one for the tab switch to commit, one for layout to settle.
    raf1 = requestAnimationFrame(() => {
      if (step.anchor) {
        const el = document.querySelector(`[data-tour="${step.anchor}"]`);
        if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' });
      }
      raf2 = requestAnimationFrame(measure);
    });

    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [step]);

  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onSkip(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onSkip]);

  if (!step) return null;

  const last = i === steps.length - 1;
  const hole = rect
    ? { top: rect.top - PAD, left: rect.left - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }
    : null;

  // Below the hole, flipped above when it would overflow, clamped to the
  // viewport on both axes so the card is never partly offscreen.
  let tipStyle;
  if (hole) {
    const below = hole.top + hole.height + GAP;
    const flip = below + TOOLTIP_H > window.innerHeight;
    const top = flip ? Math.max(GAP, hole.top - TOOLTIP_H - GAP) : below;
    const left = Math.min(
      Math.max(GAP, hole.left + hole.width / 2 - TOOLTIP_W / 2),
      Math.max(GAP, window.innerWidth - TOOLTIP_W - GAP),
    );
    tipStyle = { position: 'fixed', top, left, width: TOOLTIP_W };
  } else {
    tipStyle = {
      position: 'fixed', top: '50%', left: '50%',
      transform: 'translate(-50%, -50%)', width: TOOLTIP_W,
    };
  }

  return (
    <div className="fixed inset-0" style={{ zIndex: 60 }}>
      <svg className="absolute inset-0 w-full h-full" style={{ pointerEvents: 'none' }}>
        <defs>
          <mask id="tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {hole && (
              <rect x={hole.left} y={hole.top} width={hole.width} height={hole.height} rx="10" fill="black" />
            )}
          </mask>
        </defs>
        <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.72)" mask="url(#tour-mask)" />
        {hole && (
          <rect
            x={hole.left} y={hole.top} width={hole.width} height={hole.height}
            rx="10" fill="none" stroke={teal} strokeWidth="2"
          />
        )}
      </svg>

      <div className="rounded-xl p-4 shadow-xl" style={{ ...tipStyle, background: cardBg, border: `1px solid ${cardBorder}` }}>
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="font-bold text-sm" style={{ color: textMain }}>{step.title}</div>
          <button onClick={onSkip} aria-label="Skip tutorial" style={{ color: textDim }}>
            <X size={16} />
          </button>
        </div>
        <p className="text-xs mb-3" style={{ color: textDim }}>{step.body}</p>
        <div className="flex items-center justify-between">
          <div className="font-mono text-xs" style={{ color: textDim }}>{i + 1} / {steps.length}</div>
          <div className="flex items-center gap-2">
            <button onClick={onSkip} className="rounded-lg px-3 py-1.5 text-xs font-semibold" style={{ background: 'transparent', color: textDim }}>
              Skip
            </button>
            {i > 0 && (
              <button onClick={() => setI(i - 1)} className="rounded-lg px-3 py-1.5 text-xs font-semibold" style={{ background: cardBorder, color: textMain }}>
                Back
              </button>
            )}
            <button
              onClick={() => (last ? onFinish() : setI(i + 1))}
              className="rounded-lg px-3 py-1.5 text-xs font-semibold"
              style={{ background: amber, color: '#0E141B' }}
            >
              {last ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
