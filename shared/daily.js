// The UTC day boundary, owned in exactly one place so the contracts board
// (shared/contracts.js) and the daily streak (shared/streak.js) can never
// drift apart on when "tomorrow" starts. All arithmetic goes through
// Date.UTC, so local time and DST are structurally irrelevant.

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function utcDateKey(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Parses a 'YYYY-MM-DD' key to a UTC epoch, rejecting anything that isn't
// exactly that shape AND that doesn't round-trip - so '2026-02-31' and
// '2026-13-01', which Date.UTC would silently roll over into a different real
// date, are rejected rather than quietly accepted as some other day.
function parseDateKey(key) {
  if (typeof key !== 'string') return null;
  const m = DATE_KEY_RE.exec(key);
  if (!m) return null;
  const [, y, mo, d] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  if (!Number.isFinite(ms)) return null;
  return utcDateKey(ms) === key ? ms : null;
}

const DAY_MS = 24 * 3600 * 1000;

export function daysBetweenDateKeys(a, b) {
  const from = parseDateKey(a);
  const to = parseDateKey(b);
  if (from === null || to === null) return null;
  return Math.round((to - from) / DAY_MS);
}
