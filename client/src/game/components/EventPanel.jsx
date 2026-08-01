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

// One ladder's worth of rung cards. `rows` are pre-resolved
// {reward, current, target, met, claimed} - the live event resolves them
// locally through rungProgress (the exact function the server runs), while a
// pending (force-ended, still-claimable) window uses the server's own
// snapshot from GET /api/event, since the client has no baseline for it.
function RungList({ rows, accent, onClaim }) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => {
        const claimable = row.met && !row.claimed;
        const pct = row.target > 0 ? Math.min(100, (row.current / row.target) * 100) : 0;
        return (
          <div
            key={i}
            className="rounded-xl p-3"
            style={{ background: cardBg, border: `1px solid ${row.claimed ? teal : cardBorder}`, opacity: row.claimed ? 0.6 : 1 }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold" style={{ color: textMain }}>
                {row.claimed ? '✓ ' : ''}{rewardText(row.reward)}
              </div>
              {claimable && (
                <button
                  onClick={() => onClaim(i)}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold shrink-0"
                  style={{ background: amber, color: '#0E141B' }}
                >
                  Claim
                </button>
              )}
            </div>
            <div className="mt-1.5 h-1.5 rounded" style={{ background: inset }}>
              <div className="h-1.5 rounded" style={{ background: row.claimed ? teal : accent, width: `${pct}%` }} />
            </div>
            <div className="mt-1 text-xs font-mono" style={{ color: textDim }}>
              {fmt(row.current)}/{fmt(row.target)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// A window force-ended early by a NEWER event going active. Spec §5.2
// force-ends the lingering personal window, but §5.3 keeps its claims open
// for 48h - so these render as their own card below the current event's
// ladder rather than being silently dropped (which is what used to happen:
// the superseded eventProgress was nulled outright and every met-but-
// unclaimed rung was destroyed permanently).
function PendingClaimCard({ entry, onClaim }) {
  const { event, progress } = entry;
  const accent = (event.theme && event.theme.color) || violet;
  const rows = (progress.rungs || []).map((r, i) => ({
    ...r, reward: (event.ladder[i] || {}).reward,
  }));
  const graceMsLeft = Math.max(0, (progress.endsAt + EVENT_CLAIM_GRACE_MS) - Date.now());
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${amber}` }}>
        <div className="text-sm font-semibold" style={{ color: textMain }}>
          Unclaimed from {event.name}
        </div>
        <div className="mt-1 text-xs font-mono" style={{ color: amber }}>
          This event was superseded — claim within {fmtCountdown(graceMsLeft)}
        </div>
      </div>
      <RungList rows={rows} accent={accent} onClaim={(i) => onClaim(i, event.id)} />
    </div>
  );
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
  event, eventProgress, meta, leaderboard, pendingClaims = [],
  userId, optOut, graceActive, onClaimRung, onToggleOptOut,
}) {
  const pending = Array.isArray(pendingClaims) ? pendingClaims : [];
  const hasCurrent = !!(event && eventProgress);

  if (!hasCurrent) {
    return (
      <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3" data-tour="event-ladder">
        {pending.map((entry) => (
          <PendingClaimCard key={entry.event.id} entry={entry} onClaim={onClaimRung} />
        ))}
        {pending.length === 0 && (
          <div className="rounded-xl p-4 text-sm" style={{ background: cardBg, border: `1px solid ${cardBorder}`, color: textDim }}>
            Event details aren&rsquo;t available right now. If you still have rewards to claim, try reopening this tab in a moment.
          </div>
        )}
      </div>
    );
  }

  const accent = (event.theme && event.theme.color) || violet;
  const icon = (event.theme && event.theme.icon) || null;
  const now = Date.now();
  const msLeft = Math.max(0, eventProgress.endsAt - now);
  const graceMsLeft = Math.max(0, (eventProgress.endsAt + EVENT_CLAIM_GRACE_MS) - now);

  return (
    <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3" data-tour="event-ladder">
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

      <RungList
        rows={event.ladder.map((rung, i) => ({
          ...rungProgress(rung, meta, eventProgress.baseline),
          reward: rung.reward,
          claimed: eventProgress.rungsClaimed.includes(i),
        }))}
        accent={accent}
        onClaim={(i) => onClaimRung(i, event.id)}
      />

      {pending.map((entry) => (
        <PendingClaimCard key={entry.event.id} entry={entry} onClaim={onClaimRung} />
      ))}

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
