import { Trophy } from 'lucide-react';
import { violet, textMain } from '../theme.js';

// Xh Ym countdown, rounded up to the nearest minute (same convention as
// ColdStoragePanel's fmtCountdown) so a window that just missed closing
// doesn't briefly read "0h 0m".
function fmtCountdown(ms) {
  const totalMin = Math.max(0, Math.ceil(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${m}m`;
}

// Sticky-header banner shown while the player's OWN event window is live -
// same rounded-pill, tap-to-focus pattern as the surge banner in
// StatsRow.jsx, split into its own component since it's conditioned on a
// completely different piece of state (Live Events, v1.4).
//
// `endsAt` is the player's PERSONAL window (state.meta.eventProgress.endsAt),
// not the event's global end - two players who joined at different times
// see different countdowns here. RackStack.jsx only renders this banner
// while that personal window is still live (not during the post-end grace
// period - the event tab itself stays reachable then, this banner just
// stops nagging about something no longer "live").
export default function EventBanner({ event, endsAt, onOpen }) {
  if (!event) return null;
  const msLeft = Math.max(0, endsAt - Date.now());
  const icon = (event.theme && event.theme.icon) || null;
  return (
    <button
      onClick={onOpen}
      className="mt-2 w-full rounded-lg px-3 py-1.5 text-xs font-mono flex items-center justify-between"
      style={{ background: 'rgba(156,140,242,0.12)', border: `1px solid ${violet}`, color: violet }}
    >
      <span className="flex items-center gap-1.5">
        {icon ? <span className="event-icon text-sm leading-none">{icon}</span> : <Trophy size={13} className="event-icon" />}
        <span style={{ color: textMain }}>{event.name}</span> live
      </span>
      <span>{fmtCountdown(msLeft)} left</span>
    </button>
  );
}
