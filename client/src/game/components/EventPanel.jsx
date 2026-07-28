import { Trophy } from 'lucide-react';
import {
  cardBg, cardBorder, inset, textMain, textDim, amber, teal, violet,
} from '../theme.js';
import { fmt } from '../helpers.js';
import { rungProgress } from '@shared/events.js';
import { EVENT_CLAIM_GRACE_MS } from '@shared/reducer.js';

// Dd Hh (days once >=24h left, else Hh Mm), rounded up to the nearest
// minute - same rounding convention as ColdStoragePanel's fmtCountdown, an
// event window just runs longer than a Cold Storage block so it also needs
// a days place.
function fmtCountdown(ms) {
  const totalMin = Math.max(0, Math.ceil(ms / 60000));
  const totalHours = Math.floor(totalMin / 60);
  if (totalHours >= 24) {
    const d = Math.floor(totalHours / 24);
    const h = totalHours % 24;
    return `${d}d ${h}h`;
  }
  const m = totalMin % 60;
  return `${totalHours}h ${m}m`;
}

function rewardText(reward) {
  const r = reward || {};
  const parts = [];
  if (typeof r.wafers === 'number' && r.wafers > 0) parts.push(`+${fmt(r.wafers)} wafers`);
  if (typeof r.tapes === 'number' && r.tapes > 0) parts.push(`+${fmt(r.tapes)} tapes`);
  if (typeof r.flops === 'number' && r.flops > 0) parts.push(`+${fmt(r.flops)} FLOPS`);
  return parts.join(' · ') || 'reward';
}

// event: {id, name, description, theme: {icon,color}|null, ladder} - the
// currently (or, during the 48h post-end grace window, most-recently)
// active event's identity. RackStack.jsx caches this itself (see its
// refreshEventData doc comment) because GET /api/event stops returning it
// the moment the event's global status flips to 'ended', even though a
// player's own claim window can still be open for up to
// EVENT_CLAIM_GRACE_MS past that.
//
// eventProgress is state.meta.eventProgress verbatim (canonical, updates for
// free on every reconcile). Per-rung progress is computed here via
// rungProgress (@shared/events.js) - the EXACT function the server's own
// claimEventRung and GET /api/event route run - so a bar can never show a
// rung as claimable that the server would actually reject, and vice versa.
//
// leaderboard is a separate, already server-ranked/opt-out-filtered/capped
// (<=50) array RackStack fetches opportunistically (GET /api/event) - not
// derivable from local state the way the ladder progress is.
export default function EventPanel({
  event, eventProgress, meta, leaderboard, userId, optOut, graceActive, onClaimRung, onToggleOptOut,
}) {
  if (!event || !eventProgress) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-4">
        <div className="rounded-xl p-4 text-sm" style={{ background: cardBg, border: `1px solid ${cardBorder}`, color: textDim }}>
          Event details aren&rsquo;t available right now. If you still have rewards to claim, try reopening this tab in a moment.
        </div>
      </div>
    );
  }

  const accent = (event.theme && event.theme.color) || violet;
  const icon = (event.theme && event.theme.icon) || null;
  const now = Date.now();
  const msLeft = Math.max(0, eventProgress.endsAt - now);
  const graceMsLeft = Math.max(0, (eventProgress.endsAt + EVENT_CLAIM_GRACE_MS) - now);

  return (
    <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3">
      <div className="rounded-xl p-4" style={{ background: cardBg, border: `1px solid ${accent}` }}>
        <div className="flex items-center gap-2">
          {icon ? <span className="text-2xl leading-none">{icon}</span> : <Trophy size={22} color={accent} />}
          <div className="flex-1 min-w-0">
            <div className="text-base font-semibold" style={{ color: textMain }}>{event.name}</div>
            {event.description && (
              <div className="text-xs mt-0.5" style={{ color: textDim }}>{event.description}</div>
            )}
          </div>
        </div>
        <div className="mt-2 text-xs font-mono" style={{ color: graceActive ? amber : accent }}>
          {graceActive
            ? `Event ended — claim outstanding rewards within ${fmtCountdown(graceMsLeft)}`
            : `Ends in ${fmtCountdown(msLeft)}`}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {event.ladder.map((rung, i) => {
          const progress = rungProgress(rung, meta, eventProgress.baseline);
          const claimed = eventProgress.rungsClaimed.includes(i);
          const claimable = progress.met && !claimed;
          const pct = progress.target > 0 ? Math.min(100, (progress.current / progress.target) * 100) : 0;
          return (
            <div
              key={i}
              className="rounded-xl p-3"
              style={{ background: cardBg, border: `1px solid ${claimed ? teal : cardBorder}`, opacity: claimed ? 0.6 : 1 }}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold" style={{ color: textMain }}>
                  {claimed ? '✓ ' : ''}{rewardText(rung.reward)}
                </div>
                {claimable && (
                  <button
                    onClick={() => onClaimRung(i)}
                    className="rounded-lg px-3 py-1.5 text-xs font-semibold shrink-0"
                    style={{ background: amber, color: '#0E141B' }}
                  >
                    Claim
                  </button>
                )}
              </div>
              <div className="mt-1.5 h-1.5 rounded" style={{ background: inset }}>
                <div className="h-1.5 rounded" style={{ background: claimed ? teal : accent, width: `${pct}%` }} />
              </div>
              <div className="mt-1 text-xs font-mono" style={{ color: textDim }}>
                {fmt(progress.current)}/{fmt(progress.target)}
              </div>
            </div>
          );
        })}
      </div>

      <div className="rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
        <div className="flex items-center justify-between mb-2 gap-2">
          <div className="text-sm font-semibold flex items-center gap-1.5" style={{ color: textMain }}>
            <Trophy size={15} color={amber} /> Leaderboard
          </div>
          <label className="flex items-center gap-1.5 text-xs font-mono shrink-0" style={{ color: textDim }}>
            <input
              type="checkbox"
              checked={!!(optOut ?? false)}
              onChange={(e) => onToggleOptOut(!!e.target.checked)}
            />
            Hide me
          </label>
        </div>
        {leaderboard.length === 0 ? (
          <div className="text-xs" style={{ color: textDim }}>No entries yet.</div>
        ) : (
          <div className="flex flex-col gap-1">
            {leaderboard.map((row, i) => {
              const mine = row.userId === userId;
              return (
                <div
                  key={row.userId}
                  className="flex items-center justify-between text-xs font-mono rounded-lg px-2 py-1.5"
                  style={{
                    background: mine ? inset : 'transparent',
                    border: `1px solid ${mine ? amber : 'transparent'}`,
                    color: mine ? textMain : textDim,
                  }}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <span style={{ color: i === 0 ? amber : textDim }}>#{i + 1}</span>
                    <span className="truncate">{row.username || 'Anonymous'}{mine ? ' (you)' : ''}</span>
                  </span>
                  <span className="shrink-0">{row.rungsClaimed} rungs</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
