import { useEffect, useState } from 'react';
import { History, RotateCcw, RefreshCcw } from 'lucide-react';
import {
  cardBorder, textMain, textDim, violet, teal, danger, amber, inset,
} from '../../theme.js';
import {
  TUNABLES, DEFAULT_CONFIG, getAtPath, setAtPath,
} from '@shared/configSchema.js';
import {
  fetchConfig, putAdminConfig, fetchConfigHistory, rollbackConfig,
} from '../../api.js';

// Group TUNABLES rows by their path prefix, preserving TUNABLES' own
// declared order both for group order and row order within a group.
// Minigames get a finer-grained split (one group per minigame) since that
// prefix alone accounts for roughly half the rows; everything else groups
// on its top-level key.
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
  // v1.3 added 11 batchQueue.* tunables; without this they rendered under the
  // raw key. Keep in sync with AdminEvents.jsx's copy of this map.
  batchQueue: 'Cold Storage (batch queue)',
};

function buildGroups() {
  const order = [];
  const byKey = new Map();
  for (const t of TUNABLES) {
    const key = groupKeyFor(t.path);
    if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
    byKey.get(key).push(t);
  }
  return order.map((key) => ({ key, label: GROUP_LABELS[key] || key, rows: byKey.get(key) }));
}
const GROUPS = buildGroups();

function rawFromData(data) {
  const out = {};
  for (const t of TUNABLES) out[t.path] = String(getAtPath(data, t.path));
  return out;
}

// Parses/validates one field's current raw (string) input against its
// TUNABLES range, and reports whether it differs from the last-known
// server value for that path.
function fieldStatus(raw, serverValue, tunable) {
  const num = raw === '' ? NaN : Number(raw);
  const valid = raw !== '' && !Number.isNaN(num)
    && num >= tunable.min && num <= tunable.max
    && (!tunable.integer || Number.isInteger(num));
  const dirty = valid ? num !== serverValue : String(raw) !== String(serverValue);
  return { num, valid, dirty };
}

function fmtDate(ms) {
  if (!ms) return '';
  try { return new Date(ms).toLocaleString(); } catch (e) { return String(ms); }
}

export default function AdminBalancing({ onConfigSaved }) {
  const [serverConfig, setServerConfig] = useState(null); // { version, data }
  const [raw, setRaw] = useState(null); // { [path]: string }
  const [fieldErrors, setFieldErrors] = useState({}); // { [path]: message }
  const [generalErrors, setGeneralErrors] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveNote, setSaveNote] = useState(null);

  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState(null);
  const [rollingBack, setRollingBack] = useState(null); // version currently rolling back

  async function loadConfig() {
    setLoadError(null);
    const res = await fetchConfig();
    if (!res || res.error) { setLoadError('Failed to load config.'); return; }
    setServerConfig(res);
    setRaw(rawFromData(res.data));
  }

  async function loadHistory() {
    setHistoryError(null);
    const res = await fetchConfigHistory();
    if (!res || res.error) { setHistoryError('Failed to load history.'); return; }
    setHistory(res.history);
  }

  useEffect(() => { loadConfig(); loadHistory(); }, []);

  if (loadError) return <div className="text-xs" style={{ color: danger }}>{loadError}</div>;
  if (!serverConfig || !raw) return <div className="text-xs" style={{ color: textDim }}>Loading&hellip;</div>;

  const statuses = {};
  for (const t of TUNABLES) {
    statuses[t.path] = fieldStatus(raw[t.path], getAtPath(serverConfig.data, t.path), t);
  }
  const anyDirty = TUNABLES.some((t) => statuses[t.path].dirty);
  const anyInvalid = TUNABLES.some((t) => !statuses[t.path].valid);
  const saveDisabled = saving || !anyDirty || anyInvalid;

  function handleChange(path, value) {
    setRaw((prev) => ({ ...prev, [path]: value }));
  }

  function handleReset() {
    setRaw(rawFromData(serverConfig.data));
    setFieldErrors({});
    setGeneralErrors([]);
    setSaveNote(null);
  }

  async function handleSave() {
    setSaving(true);
    setFieldErrors({});
    setGeneralErrors([]);
    setSaveNote(null);
    const clone = structuredClone(serverConfig.data);
    for (const t of TUNABLES) setAtPath(clone, t.path, statuses[t.path].num);
    const res = await putAdminConfig(clone);
    setSaving(false);
    if (res && typeof res.version === 'number') {
      const next = { version: res.version, data: clone };
      setServerConfig(next);
      setRaw(rawFromData(clone));
      setSaveNote({ kind: 'success', text: `Saved as version ${res.version}.` });
      onConfigSaved(next);
      loadHistory();
      return;
    }
    if (res && Array.isArray(res.errors)) {
      const fMap = {};
      const general = [];
      for (const msg of res.errors) {
        const hit = TUNABLES.find((t) => msg.startsWith(`${t.path}:`));
        if (hit) fMap[hit.path] = msg;
        else general.push(msg);
      }
      setFieldErrors(fMap);
      setGeneralErrors(general);
      return;
    }
    setSaveNote({ kind: 'error', text: "Couldn't save, try again." });
  }

  async function handleRollback(version) {
    setRollingBack(version);
    setHistoryError(null);
    const res = await rollbackConfig(version);
    if (res && typeof res.version === 'number') {
      const cfg = await fetchConfig();
      setRollingBack(null);
      if (cfg && !cfg.error) {
        setServerConfig(cfg);
        setRaw(rawFromData(cfg.data));
        setFieldErrors({});
        setGeneralErrors([]);
        setSaveNote({ kind: 'success', text: `Rolled back to version ${version} (now version ${cfg.version}).` });
        onConfigSaved(cfg);
      }
      loadHistory();
      return;
    }
    setRollingBack(null);
    const msg = (res && Array.isArray(res.errors) && res.errors.join('; '))
      || (res && res.error) || 'Rollback failed.';
    setHistoryError(msg);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs" style={{ color: textDim }}>
        Live config version {serverConfig.version}. Edited fields highlight until saved.
      </div>

      {generalErrors.length > 0 && (
        <div className="rounded-md p-2 text-xs" style={{ background: inset, border: `1px solid ${danger}`, color: danger }}>
          {generalErrors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}

      <div className="flex flex-col gap-3 max-h-96 overflow-y-auto pr-1">
        {GROUPS.map((group) => (
          <div key={group.key} className="rounded-md p-2" style={{ background: inset, border: `1px solid ${cardBorder}` }}>
            <div className="text-xs font-semibold mb-1.5" style={{ color: violet }}>{group.label}</div>
            <div className="flex flex-col gap-1.5">
              {group.rows.map((t) => {
                const st = statuses[t.path];
                const err = fieldErrors[t.path];
                const defaultVal = getAtPath(DEFAULT_CONFIG, t.path);
                return (
                  <div key={t.path} className="flex flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <label className="flex-1 text-xs truncate" style={{ color: textMain }} title={t.path}>
                        {t.label}
                      </label>
                      <input
                        type="number"
                        data-testid={`tunable-${t.path}`}
                        value={raw[t.path]}
                        onChange={(e) => handleChange(t.path, e.target.value)}
                        step={t.integer ? 1 : 'any'}
                        className="w-24 rounded-md px-2 py-1 text-xs font-mono text-right"
                        style={{
                          background: '#0E141B',
                          border: `1px solid ${err ? danger : (st.dirty ? amber : cardBorder)}`,
                          color: st.valid ? textMain : danger,
                        }}
                      />
                    </div>
                    <div className="text-[10px]" style={{ color: textDim }}>
                      range [{t.min}, {t.max}]{t.integer ? ', integer' : ''} &middot; default {defaultVal}
                    </div>
                    {err && <div className="text-[10px]" style={{ color: danger }}>{err}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saveDisabled}
          data-testid="balancing-save"
          className="flex-1 rounded-md py-1.5 text-xs font-semibold"
          style={{
            background: saveDisabled ? '#0E141B' : amber,
            color: saveDisabled ? textDim : '#0E141B',
            border: `1px solid ${cardBorder}`,
            opacity: saveDisabled ? 0.6 : 1,
            cursor: saveDisabled ? 'not-allowed' : 'pointer',
          }}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          onClick={handleReset}
          disabled={!anyDirty || saving}
          data-testid="balancing-reset"
          className="rounded-md px-3 py-1.5 text-xs font-semibold flex items-center gap-1"
          style={{
            background: inset, color: textDim, border: `1px solid ${cardBorder}`,
            opacity: (!anyDirty || saving) ? 0.6 : 1,
            cursor: (!anyDirty || saving) ? 'not-allowed' : 'pointer',
          }}
        >
          <RefreshCcw size={12} /> Reset
        </button>
      </div>
      {saveNote && (
        <div className="text-xs" style={{ color: saveNote.kind === 'success' ? teal : danger }}>{saveNote.text}</div>
      )}

      <div className="rounded-md p-2" style={{ background: inset, border: `1px solid ${cardBorder}` }}>
        <div className="flex items-center gap-1.5 text-xs font-semibold mb-1.5" style={{ color: violet }}>
          <History size={13} /> History
        </div>
        {historyError && <div className="text-xs mb-1" style={{ color: danger }}>{historyError}</div>}
        {!history && !historyError && <div className="text-xs" style={{ color: textDim }}>Loading&hellip;</div>}
        {history && history.length === 0 && <div className="text-xs" style={{ color: textDim }}>No history yet.</div>}
        {history && history.length > 0 && (
          <div className="flex flex-col gap-1.5 max-h-56 overflow-y-auto">
            {history.map((h) => (
              <div key={h.version} className="flex items-center justify-between gap-2 text-xs font-mono" style={{ color: textMain }}>
                <div className="min-w-0 truncate">
                  v{h.version}
                  <span style={{ color: textDim }}> &middot; {fmtDate(h.updatedAt)} &middot; {h.updatedBy || 'system'}</span>
                </div>
                <button
                  onClick={() => handleRollback(h.version)}
                  disabled={rollingBack !== null || h.version === serverConfig.version}
                  data-testid={`rollback-${h.version}`}
                  className="rounded-md px-2 py-1 text-[10px] font-semibold flex items-center gap-1 shrink-0"
                  style={{
                    background: '#0E141B', color: textDim, border: `1px solid ${cardBorder}`,
                    opacity: (rollingBack !== null || h.version === serverConfig.version) ? 0.5 : 1,
                    cursor: (rollingBack !== null || h.version === serverConfig.version) ? 'not-allowed' : 'pointer',
                  }}
                >
                  <RotateCcw size={10} /> {rollingBack === h.version ? 'Rolling back...' : 'Rollback'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
