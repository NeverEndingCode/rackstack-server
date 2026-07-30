import { useEffect, useState } from 'react';
import {
  Plus, Trash2, CalendarClock, Play, Square, X, Users as UsersIcon, PenSquare,
} from 'lucide-react';
import {
  cardBorder, textMain, textDim, violet, teal, amber, danger, inset,
} from '../../theme.js';
import { TUNABLES, DEFAULT_CONFIG, getAtPath } from '@shared/configSchema.js';
import { EVENT_METRIC_IDS, validateModifiers, validateLadder } from '@shared/events.js';
import {
  fetchAdminEvents, createEvent, updateEvent, deleteEvent as apiDeleteEvent,
  scheduleEvent, activateEvent, endEvent, fetchEventParticipation,
} from '../../api.js';

// Mirrors server/routes/api.js's EVENT_SLUG_RE - client-side copy purely for
// instant feedback, the server's regex is still the source of truth (same
// pattern UsernameForm.jsx follows for USERNAME_RE, except that one actually
// imports the shared regex - this one can't, since EVENT_SLUG_RE lives in
// server/routes/api.js, not shared/, so it's duplicated here instead).
const EVENT_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
function isValidSlug(id) {
  return typeof id === 'string' && id.length >= 3 && id.length <= 60 && EVENT_SLUG_RE.test(id);
}

const STATUS_COLOR = {
  draft: textDim, scheduled: teal, active: amber, ended: violet,
};

const METRIC_LABELS = {
  flopsEarned: 'FLOPS earned',
  minigamesWon: 'Minigames won',
  blocksClaimed: 'Blocks claimed',
  tapesEarned: 'Tapes earned',
  wafersEarned: 'Wafers earned',
};

// Same grouping idiom as AdminBalancing.jsx (groupKeyFor/GROUP_LABELS) -
// duplicated rather than imported since AdminBalancing.jsx doesn't export
// either, and this dropdown needs the identical friendly labels/per-minigame
// split to avoid presenting a differently-organized picker for the same
// TUNABLES rows elsewhere in this same admin panel.
function groupKeyFor(path) {
  const parts = path.split('.');
  if (parts[0] === 'minigames' && parts.length > 2) return `minigames.${parts[1]}`;
  return parts[0];
}
const GROUP_LABELS = {
  heat: 'Heat',
  minigames: 'Minigames (general)',
  'minigames.rush': 'Minigame: Rush',
  'minigames.debug': 'Minigame: Debug',
  'minigames.match': 'Minigame: Match',
  'minigames.balance': 'Minigame: Balance',
  production: 'Production',
  offline: 'Offline',
  anomaly: 'Anomaly',
  upgrades: 'Upgrade max levels',
  batchQueue: 'Cold Storage (batch queue)',
};
const TUNABLE_GROUPS = (() => {
  const order = [];
  const byKey = new Map();
  for (const t of TUNABLES) {
    const key = groupKeyFor(t.path);
    if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
    byKey.get(key).push(t);
  }
  return order.map((key) => [GROUP_LABELS[key] || key, byKey.get(key)]);
})();

function fmtDate(ms) {
  if (ms == null) return 'Not scheduled';
  try { return new Date(ms).toLocaleString(); } catch (e) { return String(ms); }
}

function msToLocalInput(ms) {
  if (ms == null) return '';
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputToMs(s) {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? null : t;
}

function formFromEvent(ev) {
  return {
    id: ev ? ev.id : '',
    name: ev ? (ev.name || '') : '',
    description: ev ? (ev.description || '') : '',
    themeIcon: (ev && ev.theme && ev.theme.icon) || '',
    themeColor: (ev && ev.theme && ev.theme.color) || '',
    modifiers: ev && Array.isArray(ev.modifiers)
      ? ev.modifiers.map((m) => ({ path: m.path, valueRaw: String(m.value) }))
      : [],
    ladder: ev && Array.isArray(ev.ladder)
      ? ev.ladder.map((r) => ({
        metric: r.metric,
        targetRaw: String(r.target),
        wafersRaw: (r.reward && r.reward.wafers != null) ? String(r.reward.wafers) : '',
        tapesRaw: (r.reward && r.reward.tapes != null) ? String(r.reward.tapes) : '',
        flopsRaw: (r.reward && r.reward.flops != null) ? String(r.reward.flops) : '',
      }))
      : [],
    startsAt: msToLocalInput(ev ? ev.starts_at : null),
    endsAt: msToLocalInput(ev ? ev.ends_at : null),
  };
}

function buildModifiersPayload(form) {
  return form.modifiers.map((m) => ({ path: m.path, value: Number(m.valueRaw) }));
}

function buildLadderPayload(form) {
  return form.ladder.map((r) => {
    const reward = {};
    if (r.wafersRaw !== '') reward.wafers = Number(r.wafersRaw);
    if (r.tapesRaw !== '') reward.tapes = Number(r.tapesRaw);
    if (r.flopsRaw !== '') reward.flops = Number(r.flopsRaw);
    return { metric: r.metric, target: Number(r.targetRaw), reward };
  });
}

function StatusBadge({ status }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase shrink-0"
      style={{ color: STATUS_COLOR[status] || textDim, border: `1px solid ${STATUS_COLOR[status] || cardBorder}` }}
    >
      {status}
    </span>
  );
}

function ParticipationView({ eventId, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    fetchEventParticipation(eventId).then((res) => {
      if (cancelled) return;
      if (!res || res.error) { setError('Failed to load participation.'); return; }
      setRows(res.participation);
    });
    return () => { cancelled = true; };
  }, [eventId]);

  return (
    <div className="rounded-md p-2" style={{ background: inset, border: `1px solid ${cardBorder}` }}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: violet }}>
          <UsersIcon size={13} /> Participation
        </div>
        <button onClick={onClose} className="text-xs" style={{ color: textDim }}><X size={13} /></button>
      </div>
      {error && <div className="text-xs" style={{ color: danger }}>{error}</div>}
      {!rows && !error && <div className="text-xs" style={{ color: textDim }}>Loading&hellip;</div>}
      {rows && rows.length === 0 && <div className="text-xs" style={{ color: textDim }}>No participants yet.</div>}
      {rows && rows.length > 0 && (
        <div className="flex flex-col gap-1 max-h-56 overflow-y-auto">
          {rows.map((r) => (
            <div key={r.user_id} className="flex items-center justify-between gap-2 text-[11px] font-mono" style={{ color: textMain }}>
              <span className="truncate">{r.user_id}</span>
              <span style={{ color: textDim }}>
                {r.rungs_claimed} rungs &middot; last {fmtDate(r.last_progress_at)}{r.opted_out ? ' · hidden' : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ModifierRow({ row, onChange, onRemove, testIndex }) {
  const tDef = TUNABLES.find((t) => t.path === row.path);
  const num = row.valueRaw === '' ? NaN : Number(row.valueRaw);
  const valid = tDef && row.valueRaw !== '' && !Number.isNaN(num)
    && num >= tDef.min && num <= tDef.max && (!tDef.integer || Number.isInteger(num));
  return (
    <div className="flex flex-col gap-1 rounded-md p-1.5" style={{ background: '#0E141B', border: `1px solid ${cardBorder}` }}>
      <div className="flex items-center gap-1.5">
        <select
          value={row.path}
          onChange={(e) => onChange({ ...row, path: e.target.value })}
          data-testid={`modifier-path-${testIndex}`}
          className="flex-1 min-w-0 rounded-md px-1.5 py-1 text-[11px]"
          style={{ background: '#0E141B', border: `1px solid ${cardBorder}`, color: textMain }}
        >
          {TUNABLE_GROUPS.map(([group, rows]) => (
            <optgroup key={group} label={group}>
              {rows.map((t) => <option key={t.path} value={t.path}>{t.label}</option>)}
            </optgroup>
          ))}
        </select>
        <input
          type="number"
          value={row.valueRaw}
          onChange={(e) => onChange({ ...row, valueRaw: e.target.value })}
          step={tDef && tDef.integer ? 1 : 'any'}
          data-testid={`modifier-value-${testIndex}`}
          className="w-24 rounded-md px-2 py-1 text-[11px] font-mono text-right"
          style={{ background: '#0E141B', border: `1px solid ${valid ? cardBorder : danger}`, color: valid ? textMain : danger }}
        />
        <button onClick={onRemove} data-testid={`modifier-remove-${testIndex}`} style={{ color: danger }}>
          <Trash2 size={13} />
        </button>
      </div>
      {tDef && (
        <div className="text-[10px]" style={{ color: textDim }}>
          range [{tDef.min}, {tDef.max}]{tDef.integer ? ', integer' : ''}
        </div>
      )}
    </div>
  );
}

function LadderRow({ row, onChange, onRemove, testIndex }) {
  return (
    <div className="flex flex-col gap-1 rounded-md p-1.5" style={{ background: '#0E141B', border: `1px solid ${cardBorder}` }}>
      <div className="flex items-center gap-1.5">
        <select
          value={row.metric}
          onChange={(e) => onChange({ ...row, metric: e.target.value })}
          data-testid={`rung-metric-${testIndex}`}
          className="flex-1 min-w-0 rounded-md px-1.5 py-1 text-[11px]"
          style={{ background: '#0E141B', border: `1px solid ${cardBorder}`, color: textMain }}
        >
          {EVENT_METRIC_IDS.map((m) => <option key={m} value={m}>{METRIC_LABELS[m] || m}</option>)}
        </select>
        <input
          type="number"
          value={row.targetRaw}
          onChange={(e) => onChange({ ...row, targetRaw: e.target.value })}
          placeholder="target"
          data-testid={`rung-target-${testIndex}`}
          className="w-20 rounded-md px-2 py-1 text-[11px] font-mono text-right"
          style={{ background: '#0E141B', border: `1px solid ${cardBorder}`, color: textMain }}
        />
        <button onClick={onRemove} data-testid={`rung-remove-${testIndex}`} style={{ color: danger }}>
          <Trash2 size={13} />
        </button>
      </div>
      <div className="flex items-center gap-1.5 text-[10px]" style={{ color: textDim }}>
        reward:
        <input
          type="number" value={row.wafersRaw} placeholder="wafers"
          onChange={(e) => onChange({ ...row, wafersRaw: e.target.value })}
          data-testid={`rung-wafers-${testIndex}`}
          className="w-16 rounded-md px-1.5 py-0.5 font-mono"
          style={{ background: '#0E141B', border: `1px solid ${cardBorder}`, color: textMain }}
        />
        <input
          type="number" value={row.tapesRaw} placeholder="tapes"
          onChange={(e) => onChange({ ...row, tapesRaw: e.target.value })}
          data-testid={`rung-tapes-${testIndex}`}
          className="w-16 rounded-md px-1.5 py-0.5 font-mono"
          style={{ background: '#0E141B', border: `1px solid ${cardBorder}`, color: textMain }}
        />
        <input
          type="number" value={row.flopsRaw} placeholder="flops"
          onChange={(e) => onChange({ ...row, flopsRaw: e.target.value })}
          data-testid={`rung-flops-${testIndex}`}
          className="w-16 rounded-md px-1.5 py-0.5 font-mono"
          style={{ background: '#0E141B', border: `1px solid ${cardBorder}`, color: textMain }}
        />
      </div>
    </div>
  );
}

// Create/edit form for one event, plus its Schedule/Activate/End/Delete
// actions and (on request) its participation view. `event` is null when
// authoring a brand-new draft; otherwise the full row from GET
// /api/admin/events (snake_case starts_at/ends_at, as returned by
// server/db.js's parseEventRow).
function EventEditor({ event, onSaved, onDeleted, onClose }) {
  const isNew = !event;
  const [form, setForm] = useState(() => formFromEvent(event));
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(null); // 'schedule' | 'activate' | 'end' | 'delete'
  const [generalErrors, setGeneralErrors] = useState([]);
  const [modErrors, setModErrors] = useState([]);
  const [ladderErrors, setLadderErrors] = useState([]);
  const [scheduleError, setScheduleError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [note, setNote] = useState(null);
  const [showParticipation, setShowParticipation] = useState(false);
  const [current, setCurrent] = useState(event); // latest known server row, refreshed after actions

  // Reset local editor state only when the incoming `event` prop refers to a
  // genuinely DIFFERENT event than the one already loaded (`current`) - e.g.
  // the admin picked a different row, or switched to/from "New event".
  // Comparing by identity (id, or null for "authoring a new draft") rather
  // than by object/prop reference matters because every successful save/
  // schedule/activate/end below calls `setCurrent(res.event)` itself and
  // then bubbles that same row up via onSaved - AdminEvents' `events` array
  // is replaced wholesale in its handleSaved, so the `event` prop we receive
  // is a FRESH object reference for the very row we just finished handling.
  // If this effect fired on every such reference change (the original bug),
  // it would wipe the success note - and any error state - the instant the
  // request that produced it resolved, before an admin (or an e2e test)
  // could ever see it. Because the action handlers below already call
  // setCurrent(res.event) synchronously (in the same batch as the onSaved
  // call that eventually changes this prop), `current`'s identity has
  // always already caught up to the incoming prop's identity by the time
  // this effect re-runs for "our own" update - so the check below only ever
  // fires a real reset on an actual navigation, never on our own echo.
  useEffect(() => {
    const incomingId = event ? event.id : null;
    const knownId = current ? current.id : null;
    if (incomingId === knownId) return;
    setForm(formFromEvent(event));
    setCurrent(event);
    setGeneralErrors([]); setModErrors([]); setLadderErrors([]); setScheduleError(null);
    setActionError(null); setNote(null); setShowParticipation(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event]);

  const modifiersPayload = buildModifiersPayload(form);
  const ladderPayload = buildLadderPayload(form);
  const modCheck = validateModifiers(modifiersPayload);
  const ladderCheck = validateLadder(ladderPayload);
  const slugValid = isNew ? isValidSlug(form.id) : true;
  const nameValid = form.name.trim().length > 0;
  const canSave = slugValid && nameValid && modCheck.ok && ladderCheck.ok && !saving;

  function updateModifier(i, next) {
    setForm((f) => ({ ...f, modifiers: f.modifiers.map((m, idx) => (idx === i ? next : m)) }));
  }
  function addModifier() {
    const used = new Set(form.modifiers.map((m) => m.path));
    const t = TUNABLES.find((x) => !used.has(x.path)) || TUNABLES[0];
    setForm((f) => ({ ...f, modifiers: [...f.modifiers, { path: t.path, valueRaw: String(getAtPath(DEFAULT_CONFIG, t.path)) }] }));
  }
  function removeModifier(i) {
    setForm((f) => ({ ...f, modifiers: f.modifiers.filter((_, idx) => idx !== i) }));
  }

  function updateRung(i, next) {
    setForm((f) => ({ ...f, ladder: f.ladder.map((r, idx) => (idx === i ? next : r)) }));
  }
  function addRung() {
    if (form.ladder.length >= 20) return;
    setForm((f) => ({
      ...f,
      ladder: [...f.ladder, {
        metric: EVENT_METRIC_IDS[0], targetRaw: '', wafersRaw: '', tapesRaw: '', flopsRaw: '',
      }],
    }));
  }
  function removeRung(i) {
    setForm((f) => ({ ...f, ladder: f.ladder.filter((_, idx) => idx !== i) }));
  }

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setGeneralErrors([]); setModErrors([]); setLadderErrors([]); setNote(null);
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      theme: (form.themeIcon.trim() || form.themeColor.trim())
        ? { icon: form.themeIcon.trim() || undefined, color: form.themeColor.trim() || undefined }
        : null,
      modifiers: modifiersPayload,
      ladder: ladderPayload,
    };
    const res = isNew
      ? await createEvent({ ...payload, id: form.id.trim() })
      : await updateEvent(current.id, payload);
    setSaving(false);

    if (res && res.event) {
      setCurrent(res.event);
      setForm(formFromEvent(res.event));
      setNote({ kind: 'success', text: isNew ? 'Event created as a draft.' : 'Saved.' });
      onSaved(res.event);
      return;
    }
    if (res && res.error === 'id_taken') { setGeneralErrors(['That event id is already taken.']); return; }
    if (res && res.error === 'event_active') {
      setGeneralErrors(["This event is active - ladder/modifiers can't be edited until it's ended."]);
      return;
    }
    if (res && res.error === 'not_found') { setGeneralErrors(['This event no longer exists.']); return; }
    if (res && Array.isArray(res.errors)) {
      const ladderMsgs = res.errors.filter((e) => e.startsWith('rung ') || e.startsWith('ladder '));
      const rest = res.errors.filter((e) => !e.startsWith('rung ') && !e.startsWith('ladder '));
      const modMsgs = rest.filter((e) => e.includes('modifier') || TUNABLES.some((t) => e.startsWith(`${t.path}:`)) || e.startsWith('unknown modifier path'));
      const general = rest.filter((e) => !modMsgs.includes(e));
      setLadderErrors(ladderMsgs);
      setModErrors(modMsgs);
      setGeneralErrors(general);
      return;
    }
    setGeneralErrors(["Couldn't save, try again."]);
  }

  async function handleSchedule() {
    const startsAt = localInputToMs(form.startsAt);
    const endsAt = localInputToMs(form.endsAt);
    setScheduleError(null);
    if (startsAt == null || endsAt == null || endsAt <= startsAt) {
      setScheduleError('Pick a start and end time, with end after start.');
      return;
    }
    setBusy('schedule');
    const res = await scheduleEvent(current.id, startsAt, endsAt);
    setBusy(null);
    if (res && res.event) {
      setCurrent(res.event);
      setForm((f) => ({ ...f, startsAt: msToLocalInput(res.event.starts_at), endsAt: msToLocalInput(res.event.ends_at) }));
      setNote({ kind: 'success', text: `Scheduled: ${fmtDate(res.event.starts_at)} - ${fmtDate(res.event.ends_at)}.` });
      onSaved(res.event);
      return;
    }
    if (res && res.error === 'event_active') setScheduleError("This event is active - end it before rescheduling.");
    else if (res && res.error === 'invalid_request') setScheduleError('Start and end times are required, and end must be after start.');
    else if (res && res.error === 'not_found') setScheduleError('This event no longer exists.');
    else setScheduleError("Couldn't schedule, try again.");
  }

  async function handleActivate() {
    setActionError(null);
    setBusy('activate');
    const res = await activateEvent(current.id);
    setBusy(null);
    if (res && res.event) {
      setCurrent(res.event);
      setNote({ kind: 'success', text: 'Activated.' });
      onSaved(res.event);
      return;
    }
    if (res && res.error === 'event_active') setActionError('A different event is already active - end it first.');
    else if (res && res.error === 'not_scheduled') setActionError('Schedule a start/end window before activating.');
    else if (res && res.error === 'invalid_target') setActionError("This event's window has already passed - reschedule it first.");
    else if (res && res.error === 'not_found') setActionError('This event no longer exists.');
    else setActionError("Couldn't activate, try again.");
  }

  async function handleEnd() {
    setActionError(null);
    setBusy('end');
    const res = await endEvent(current.id);
    setBusy(null);
    if (res && res.event) {
      setCurrent(res.event);
      setNote({ kind: 'success', text: 'Ended.' });
      onSaved(res.event);
      return;
    }
    setActionError((res && res.error === 'not_found') ? 'This event no longer exists.' : "Couldn't end, try again.");
  }

  async function handleDelete() {
    setActionError(null);
    setBusy('delete');
    const res = await apiDeleteEvent(current.id);
    setBusy(null);
    if (res && res.ok) { onDeleted(current.id); return; }
    if (res && res.error === 'not_draft') setActionError('Only draft events can be deleted - end it instead.');
    else if (res && res.error === 'not_found') { onDeleted(current.id); }
    else setActionError("Couldn't delete, try again.");
  }

  const status = current ? current.status : 'draft';

  return (
    <div className="rounded-md p-2 flex flex-col gap-2" style={{ background: inset, border: `1px solid ${violet}` }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: violet }}>
          {isNew ? <Plus size={13} /> : <PenSquare size={13} />} {isNew ? 'New event' : current.id}
          {!isNew && <StatusBadge status={status} />}
        </div>
        <button onClick={onClose} data-testid="event-editor-close" style={{ color: textDim }}><X size={14} /></button>
      </div>

      {generalErrors.length > 0 && (
        <div className="rounded-md p-1.5 text-[11px]" style={{ background: '#0E141B', border: `1px solid ${danger}`, color: danger }}>
          {generalErrors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}
      {note && <div className="text-[11px]" style={{ color: note.kind === 'success' ? teal : danger }}>{note.text}</div>}

      <div className="flex flex-col gap-1.5">
        {isNew && (
          <div className="flex flex-col gap-0.5">
            <label className="text-[10px]" style={{ color: textDim }}>Id (slug, permanent)</label>
            <input
              value={form.id}
              onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
              placeholder="summer-surge"
              data-testid="event-id"
              className="rounded-md px-2 py-1 text-xs font-mono"
              style={{ background: '#0E141B', border: `1px solid ${slugValid || !form.id ? cardBorder : danger}`, color: textMain }}
            />
            {!slugValid && form.id && (
              <div className="text-[10px]" style={{ color: danger }}>3-60 chars, lowercase letters/numbers, hyphen-separated.</div>
            )}
          </div>
        )}
        <div className="flex flex-col gap-0.5">
          <label className="text-[10px]" style={{ color: textDim }}>Name</label>
          <input
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            data-testid="event-name"
            className="rounded-md px-2 py-1 text-xs"
            style={{ background: '#0E141B', border: `1px solid ${nameValid ? cardBorder : danger}`, color: textMain }}
          />
        </div>
        <div className="flex flex-col gap-0.5">
          <label className="text-[10px]" style={{ color: textDim }}>Description</label>
          <textarea
            value={form.description}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            rows={2}
            data-testid="event-description"
            className="rounded-md px-2 py-1 text-xs resize-none"
            style={{ background: '#0E141B', border: `1px solid ${cardBorder}`, color: textMain }}
          />
        </div>
        <div className="flex gap-1.5">
          <div className="flex-1 flex flex-col gap-0.5">
            <label className="text-[10px]" style={{ color: textDim }}>Theme icon (emoji)</label>
            <input
              value={form.themeIcon}
              onChange={(e) => setForm((f) => ({ ...f, themeIcon: e.target.value }))}
              data-testid="event-theme-icon"
              className="rounded-md px-2 py-1 text-xs"
              style={{ background: '#0E141B', border: `1px solid ${cardBorder}`, color: textMain }}
            />
          </div>
          <div className="flex-1 flex flex-col gap-0.5">
            <label className="text-[10px]" style={{ color: textDim }}>Theme color</label>
            <input
              value={form.themeColor}
              onChange={(e) => setForm((f) => ({ ...f, themeColor: e.target.value }))}
              placeholder="#f59e0b"
              data-testid="event-theme-color"
              className="rounded-md px-2 py-1 text-xs font-mono"
              style={{ background: '#0E141B', border: `1px solid ${cardBorder}`, color: textMain }}
            />
          </div>
        </div>
      </div>

      <div className="rounded-md p-1.5" style={{ background: '#0E141B', border: `1px solid ${cardBorder}` }}>
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[11px] font-semibold" style={{ color: textMain }}>Modifiers</div>
          <button onClick={addModifier} data-testid="add-modifier" className="flex items-center gap-1 text-[10px]" style={{ color: amber }}>
            <Plus size={11} /> Add
          </button>
        </div>
        {modErrors.length > 0 && (
          <div className="mb-1.5 text-[10px]" style={{ color: danger }}>
            {modErrors.map((e, i) => <div key={i}>{e}</div>)}
          </div>
        )}
        {form.modifiers.length === 0 && <div className="text-[10px]" style={{ color: textDim }}>No modifiers - event runs on the live config unchanged.</div>}
        <div className="flex flex-col gap-1.5">
          {form.modifiers.map((row, i) => (
            <ModifierRow key={i} row={row} testIndex={i} onChange={(next) => updateModifier(i, next)} onRemove={() => removeModifier(i)} />
          ))}
        </div>
      </div>

      <div className="rounded-md p-1.5" style={{ background: '#0E141B', border: `1px solid ${cardBorder}` }}>
        <div className="flex items-center justify-between mb-1.5">
          <div className="text-[11px] font-semibold" style={{ color: textMain }}>Ladder (1-20 rungs)</div>
          <button onClick={addRung} disabled={form.ladder.length >= 20} data-testid="add-rung" className="flex items-center gap-1 text-[10px]" style={{ color: form.ladder.length >= 20 ? textDim : amber }}>
            <Plus size={11} /> Add rung
          </button>
        </div>
        {ladderErrors.length > 0 && (
          <div className="mb-1.5 text-[10px]" style={{ color: danger }}>
            {ladderErrors.map((e, i) => <div key={i}>{e}</div>)}
          </div>
        )}
        {form.ladder.length === 0 && <div className="text-[10px]" style={{ color: danger }}>At least one rung is required.</div>}
        <div className="flex flex-col gap-1.5">
          {form.ladder.map((row, i) => (
            <LadderRow key={i} row={row} testIndex={i} onChange={(next) => updateRung(i, next)} onRemove={() => removeRung(i)} />
          ))}
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={!canSave}
        data-testid="event-save"
        className="rounded-md py-1.5 text-xs font-semibold"
        style={{
          background: canSave ? amber : '#0E141B',
          color: canSave ? '#0E141B' : textDim,
          border: `1px solid ${cardBorder}`,
          opacity: canSave ? 1 : 0.6,
          cursor: canSave ? 'pointer' : 'not-allowed',
        }}
      >
        {saving ? 'Saving...' : (isNew ? 'Create draft' : 'Save changes')}
      </button>

      {!isNew && (
        <>
          <div className="rounded-md p-1.5 flex flex-col gap-1.5" style={{ background: '#0E141B', border: `1px solid ${cardBorder}` }}>
            <div className="text-[11px] font-semibold flex items-center gap-1.5" style={{ color: textMain }}>
              <CalendarClock size={12} /> Window
            </div>
            <div className="text-[10px]" style={{ color: textDim }}>
              {fmtDate(current.starts_at)} &rarr; {fmtDate(current.ends_at)}
            </div>
            <div className="flex gap-1.5">
              <input
                type="datetime-local"
                value={form.startsAt}
                onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))}
                data-testid="event-starts-at"
                className="flex-1 rounded-md px-1.5 py-1 text-[11px] font-mono"
                style={{ background: '#161F2B', border: `1px solid ${cardBorder}`, color: textMain }}
              />
              <input
                type="datetime-local"
                value={form.endsAt}
                onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))}
                data-testid="event-ends-at"
                className="flex-1 rounded-md px-1.5 py-1 text-[11px] font-mono"
                style={{ background: '#161F2B', border: `1px solid ${cardBorder}`, color: textMain }}
              />
            </div>
            {scheduleError && <div className="text-[10px]" style={{ color: danger }}>{scheduleError}</div>}
            <button
              onClick={handleSchedule}
              disabled={busy !== null || status === 'active'}
              data-testid="event-schedule"
              className="rounded-md py-1 text-[11px] font-semibold"
              style={{
                background: teal, color: '#0E141B',
                opacity: (busy !== null || status === 'active') ? 0.5 : 1,
                cursor: (busy !== null || status === 'active') ? 'not-allowed' : 'pointer',
              }}
            >
              {busy === 'schedule' ? 'Scheduling...' : 'Schedule'}
            </button>
          </div>

          {actionError && (
            <div className="rounded-md p-1.5 text-[11px]" style={{ background: '#0E141B', border: `1px solid ${danger}`, color: danger }}>
              {actionError}
            </div>
          )}

          <div className="flex gap-1.5">
            <button
              onClick={handleActivate}
              disabled={busy !== null || status === 'active' || current.ends_at == null}
              data-testid="event-activate"
              title={current.ends_at == null ? 'Schedule a window first' : ''}
              className="flex-1 rounded-md py-1.5 text-xs font-semibold flex items-center justify-center gap-1"
              style={{
                background: amber, color: '#0E141B',
                opacity: (busy !== null || status === 'active' || current.ends_at == null) ? 0.5 : 1,
                cursor: (busy !== null || status === 'active' || current.ends_at == null) ? 'not-allowed' : 'pointer',
              }}
            >
              <Play size={12} /> {busy === 'activate' ? 'Activating...' : 'Activate'}
            </button>
            <button
              onClick={handleEnd}
              disabled={busy !== null || (status !== 'active' && status !== 'scheduled')}
              data-testid="event-end"
              className="flex-1 rounded-md py-1.5 text-xs font-semibold flex items-center justify-center gap-1"
              style={{
                background: inset, color: textMain, border: `1px solid ${cardBorder}`,
                opacity: (busy !== null || (status !== 'active' && status !== 'scheduled')) ? 0.5 : 1,
                cursor: (busy !== null || (status !== 'active' && status !== 'scheduled')) ? 'not-allowed' : 'pointer',
              }}
            >
              <Square size={12} /> {busy === 'end' ? 'Ending...' : 'End'}
            </button>
            <button
              onClick={handleDelete}
              disabled={busy !== null || status !== 'draft'}
              data-testid="event-delete"
              title={status !== 'draft' ? 'Only drafts can be deleted' : ''}
              className="rounded-md px-2.5 py-1.5 text-xs font-semibold flex items-center justify-center"
              style={{
                background: inset, color: danger, border: `1px solid ${cardBorder}`,
                opacity: (busy !== null || status !== 'draft') ? 0.5 : 1,
                cursor: (busy !== null || status !== 'draft') ? 'not-allowed' : 'pointer',
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>

          <button
            onClick={() => setShowParticipation((v) => !v)}
            data-testid="event-toggle-participation"
            className="flex items-center gap-1.5 text-[11px]"
            style={{ color: textDim }}
          >
            <UsersIcon size={12} /> {showParticipation ? 'Hide' : 'Show'} participation ({current.participationCount ?? '?'})
          </button>
          {showParticipation && <ParticipationView eventId={current.id} onClose={() => setShowParticipation(false)} />}
        </>
      )}
    </div>
  );
}

export default function AdminEvents() {
  const [events, setEvents] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [selectedId, setSelectedId] = useState(null); // event id, 'new', or null

  async function load() {
    setLoadError(null);
    const res = await fetchAdminEvents();
    if (!res || res.error) { setLoadError('Failed to load events.'); return; }
    setEvents(res.events);
  }

  useEffect(() => { load(); }, []);

  function handleSaved(event) {
    setEvents((prev) => {
      if (!prev) return prev;
      const idx = prev.findIndex((e) => e.id === event.id);
      const withCount = { ...event, participationCount: idx >= 0 ? prev[idx].participationCount : 0 };
      if (idx >= 0) { const next = [...prev]; next[idx] = withCount; return next; }
      return [...prev, withCount];
    });
    setSelectedId(event.id);
  }

  function handleDeleted(id) {
    setEvents((prev) => (prev ? prev.filter((e) => e.id !== id) : prev));
    setSelectedId(null);
  }

  if (loadError) return <div className="text-xs" style={{ color: danger }}>{loadError}</div>;
  if (!events) return <div className="text-xs" style={{ color: textDim }}>Loading&hellip;</div>;

  const selectedEvent = selectedId && selectedId !== 'new' ? events.find((e) => e.id === selectedId) : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="text-xs" style={{ color: textDim }}>{events.length} event{events.length === 1 ? '' : 's'}</div>
        <button
          onClick={() => setSelectedId('new')}
          data-testid="events-new"
          className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold"
          style={{ background: amber, color: '#0E141B' }}
        >
          <Plus size={12} /> New event
        </button>
      </div>

      {events.length === 0 && <div className="text-xs" style={{ color: textDim }}>No events yet.</div>}

      <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
        {events.map((e) => (
          <button
            key={e.id}
            onClick={() => setSelectedId(e.id)}
            data-testid={`event-row-${e.id}`}
            className="rounded-md p-2 text-left"
            style={{
              background: inset,
              border: `1px solid ${selectedId === e.id ? violet : cardBorder}`,
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                {e.theme && e.theme.icon && <span className="text-sm leading-none">{e.theme.icon}</span>}
                <span className="text-xs font-semibold truncate" style={{ color: textMain }}>{e.name}</span>
              </div>
              <StatusBadge status={e.status} />
            </div>
            <div className="mt-1 text-[10px] font-mono" style={{ color: textDim }}>
              {e.id} &middot; {fmtDate(e.starts_at)} &rarr; {fmtDate(e.ends_at)} &middot; {e.participationCount} participant{e.participationCount === 1 ? '' : 's'}
            </div>
          </button>
        ))}
      </div>

      {(selectedId === 'new' || selectedEvent) && (
        <EventEditor
          event={selectedId === 'new' ? null : selectedEvent}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
