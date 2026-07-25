import { useState, useEffect, useRef } from 'react';

import {
  TICK_MS, MILESTONES, EVENT_WINDOW, EVENT_LABELS,
  HEAT_COOLDOWN_MS, VENT_COOLDOWN_MS, GAME_WIN_COOLDOWN_MS,
  DEBUG_MAX_LIT, DEBUG_SPAWN_MIN_MS, DEBUG_SPAWN_MAX_MS,
  MATCH_PAIR_COUNT, BALANCE_MISS_PENALTY,
} from './game/constants.js';
import { cardBorder, textDim } from './game/theme.js';
import { TIER_DEFS, GRID_DEFS, OVERCLOCK_DEFS } from './game/data/tiers.js';
import { TABS } from './game/data/tabs.js';
import {
  costForN, maxAffordable, tierRate, xpForLevel, randEventDelay,
  freshGrid, freshOverclock, initialRun, initialMeta, computeEffects, migrateGain,
} from './game/helpers.js';

import HeaderBar from './game/components/HeaderBar.jsx';
import StatsRow from './game/components/StatsRow.jsx';
import MigrateBar from './game/components/MigrateBar.jsx';
import TabBar from './game/components/TabBar.jsx';
import RacksPanel from './game/components/RacksPanel.jsx';
import GridPanel from './game/components/GridPanel.jsx';
import OverclockPanel from './game/components/OverclockPanel.jsx';
import UpgradesPanel from './game/components/UpgradesPanel.jsx';
import SingularityPanel from './game/components/SingularityPanel.jsx';
import GoalsPanel from './game/components/GoalsPanel.jsx';
import GamesPanel from './game/components/GamesPanel.jsx';
import EventToast from './game/components/EventToast.jsx';
import RushOverlay from './game/components/minigames/RushOverlay.jsx';
import DebugOverlay from './game/components/minigames/DebugOverlay.jsx';
import MatchOverlay from './game/components/minigames/MatchOverlay.jsx';
import BalanceOverlay from './game/components/minigames/BalanceOverlay.jsx';
import ModalRoot from './game/components/modals/ModalRoot.jsx';
import ProfileView from './game/components/profile/ProfileView.jsx';

/*
  RACKSTACK - idle infrastructure tycoon
  v3 adds: Overclock Bay (3rd lane, active heat management, "more
  challenging"), infinite repeatable Goals + hideable completed Goals,
  two more minigames (Cable Match, Overclock Balance), more Wafer
  upgrades, and a Singularity system (2nd-layer prestige inspired by
  ISEPS: burns Legacy Cores for Singularity Shards spent on big
  permanent perks). State: `run` (resets on Migrate), `meta` (permanent;
  only Migrate-scoped Legacy Cores reset on Singularity, everything else
  in meta survives).
*/

export default function RackStack({ user }) {
  const [run, setRun] = useState(initialRun());
  const [meta, setMeta] = useState(initialMeta());
  const [loaded, setLoaded] = useState(false);
  const [modal, setModal] = useState(null);
  const [eventState, setEventState] = useState(null);
  const [boost, setBoost] = useState(null);
  const [activeTab, setActiveTab] = useState('racks');
  const [minigame, setMinigame] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);

  const saveRef = useRef({ run, meta });
  const metaRef = useRef(meta);
  const boostRef = useRef(null);
  const minigameRef = useRef(null);
  const nextEligibleRef = useRef(Date.now() + randEventDelay());
  const debugSpawnRef = useRef(null);
  const ventCooldownRef = useRef(0);
  // Per-game post-win cooldowns. Ephemeral (not persisted) - low-stakes if
  // it resets on reload, unlike the heat cooldown which needed to survive
  // being away (see run.heatCooldownUntil below).
  const gameCooldownsRef = useRef({ rush: 0, debug: 0, match: 0, balance: 0 });

  useEffect(() => { saveRef.current = { run, meta }; }, [run, meta]);
  useEffect(() => { metaRef.current = meta; }, [meta]);
  useEffect(() => { boostRef.current = boost; }, [boost]);
  useEffect(() => { minigameRef.current = minigame; }, [minigame]);
  useEffect(() => () => { if (debugSpawnRef.current) clearTimeout(debugSpawnRef.current); }, []);

  // Load save on mount. The server is authoritative for offline production
  // (capped at 72h server-side, see server/gameLogic.js) - it returns the
  // already-caught-up run/meta plus how much was gained while away, so the
  // client does no offline math of its own here. run.heatCooldownUntil (if
  // present) rides along in the ...data.run spread below for free - being a
  // wall-clock timestamp, it's already correct whether the player was away
  // or not, no special offline handling needed.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/save', { credentials: 'include' });
        if (res.status === 401) {
          // session expired mid-visit; send back to the login gate
          window.location.reload();
          return;
        }
        const data = await res.json();
        if (data.run && data.meta) {
          // defensive padding in case the server has an older save shape
          let tiers = data.run.tiers || [];
          if (tiers.length < TIER_DEFS.length) {
            const extra = TIER_DEFS.slice(tiers.length).map((t) => ({ id: t.id, owned: 0, manager: false, ready: 0 }));
            tiers = [...tiers, ...extra];
          }
          const run2 = {
            ...initialRun(),
            ...data.run,
            tiers,
            grid: data.run.grid || freshGrid(),
            overclock: data.run.overclock || freshOverclock(),
            heat: data.run.heat || 0,
          };
          const meta2 = { ...initialMeta(), ...data.meta };
          meta2.stats = { ...initialMeta().stats, ...(data.meta.stats || {}) };
          setRun(run2);
          setMeta(meta2);
          if (data.offlineGain > 1) {
            setModal({ type: 'welcome', amount: data.offlineGain });
          }
        }
        // else: no save yet, keep the fresh initialRun()/initialMeta() defaults
      } catch (e) {
        // network hiccup on load - keep local defaults, autosave will retry
      }
      setLoaded(true);
    })();
  }, []);

  // Production tick
  useEffect(() => {
    const iv = setInterval(() => {
      const meta = metaRef.current;
      const eff = computeEffects(meta);
      const thresholds = MILESTONES.map((t) => Math.max(1, Math.round(t * eff.milestoneDiscount)));
      const now = Date.now();
      const boostMult = boostRef.current && now < boostRef.current.until ? boostRef.current.mult : 1;
      const baseMult = (1 + meta.legacyCores * 0.05) * eff.firmwareMult * eff.engineMult * eff.levelBonusMult * boostMult;
      const gridMult = baseMult * eff.gridExtraMult;
      const overclockMult = baseMult * eff.overclockExtraMult;
      const dt = TICK_MS / 1000;
      let meltdown = false;
      setRun((prev) => {
        let creditsGain = 0;
        let lifetimeGain = 0;
        const tiers = prev.tiers.map((ts, i) => {
          if (ts.owned === 0) return ts;
          const def = TIER_DEFS[i];
          const produced = tierRate(ts.owned, def.baseProd, baseMult, thresholds) * dt;
          lifetimeGain += produced;
          if (ts.manager) { creditsGain += produced; return ts; }
          return { ...ts, ready: ts.ready + produced };
        });
        prev.grid.forEach((g, i) => {
          if (g.owned === 0) return;
          const produced = tierRate(g.owned, GRID_DEFS[i].baseProd, gridMult, thresholds) * dt;
          creditsGain += produced;
          lifetimeGain += produced;
        });

        // Overclock lane: frozen entirely (no production, no heat change)
        // while on a post-meltdown cooldown, so heavy owned-node heat
        // generation can't re-trigger meltdown while venting is disabled.
        const onCooldownNow = !!prev.heatCooldownUntil && now < prev.heatCooldownUntil;
        let overclock = prev.overclock;
        let newHeat = prev.heat;
        let heatCooldownUntil = prev.heatCooldownUntil;

        if (onCooldownNow) {
          if (heatCooldownUntil && now >= heatCooldownUntil) heatCooldownUntil = null;
        } else {
          prev.overclock.forEach((o, i) => {
            if (o.owned === 0) return;
            const produced = tierRate(o.owned, OVERCLOCK_DEFS[i].baseProd, overclockMult, thresholds) * dt;
            creditsGain += produced;
            lifetimeGain += produced;
          });
          const heatGain = prev.overclock.reduce((s, o, i) => s + o.owned * OVERCLOCK_DEFS[i].heatPerSec, 0) * eff.heatDiscount;
          const netHeat = heatGain - eff.autoVentPerSec;
          newHeat = Math.min(100, Math.max(0, prev.heat + netHeat * dt));
          if (newHeat >= 100) {
            meltdown = true;
            overclock = prev.overclock.map((o) => ({ ...o, owned: Math.floor(o.owned * 0.5) }));
            newHeat = 0;
            heatCooldownUntil = now + HEAT_COOLDOWN_MS;
          }
        }

        return { ...prev, credits: prev.credits + creditsGain, lifetimeRun: prev.lifetimeRun + lifetimeGain, tiers, overclock, heat: newHeat, heatCooldownUntil };
      });
      if (meltdown) setModal({ type: 'meltdown' });
    }, TICK_MS);
    return () => clearInterval(iv);
  }, []);

  // Heartbeat: event lifecycle + minigame countdown (1s)
  useEffect(() => {
    if (!loaded) return;
    const iv = setInterval(() => {
      const now = Date.now();
      setEventState((prev) => {
        if (prev) {
          if (now >= prev.expiresAt) { nextEligibleRef.current = now + randEventDelay(); return null; }
          return prev;
        }
        if (now >= nextEligibleRef.current) {
          const label = EVENT_LABELS[Math.floor(Math.random() * EVENT_LABELS.length)];
          return { id: now, label, expiresAt: now + EVENT_WINDOW };
        }
        return prev;
      });

      const mg = minigameRef.current;
      if (mg && mg.timeLeft > 0 && (mg.type === 'rush' || mg.type === 'debug' || mg.type === 'match' || mg.type === 'balance')) {
        const newTimeLeft = mg.timeLeft - 1;
        if (newTimeLeft <= 0) {
          if (mg.type === 'debug' && debugSpawnRef.current) { clearTimeout(debugSpawnRef.current); debugSpawnRef.current = null; }
          setMinigame(null);
          if (mg.type === 'rush') finishRush(mg.taps);
          else if (mg.type === 'debug') finishDebug(mg.score);
          else if (mg.type === 'match') finishMatch(mg.pairsFound, false);
          else if (mg.type === 'balance') finishBalance(mg.score);
        } else {
          setMinigame((m) => (m ? { ...m, timeLeft: newTimeLeft } : m));
        }
      }
    }, 1000);
    return () => clearInterval(iv);
  }, [loaded]);

  // Boost expiry
  useEffect(() => {
    if (!boost) return;
    const remaining = boost.until - Date.now();
    if (remaining <= 0) { setBoost(null); return; }
    const t = setTimeout(() => setBoost(null), remaining);
    return () => clearTimeout(t);
  }, [boost]);

  // Autosave - POSTs the current run/meta to the server every 5s. The server
  // stamps its own last_save on write; offline catch-up happens on next load.
  useEffect(() => {
    if (!loaded) return;
    const iv = setInterval(() => {
      const s = saveRef.current;
      fetch('/api/save', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run: s.run, meta: s.meta }),
      }).catch(() => { /* will retry on the next tick */ });
    }, 5000);
    return () => clearInterval(iv);
  }, [loaded]);

  // Also flush a save on tab close / backgrounding so nothing is lost between
  // the 5s ticks. sendBeacon doesn't support custom headers so we send text
  // and rely on the browser to set a reasonable content type.
  useEffect(() => {
    const flush = () => {
      const s = saveRef.current;
      if (navigator.sendBeacon) {
        const blob = new Blob([JSON.stringify({ run: s.run, meta: s.meta })], { type: 'application/json' });
        navigator.sendBeacon('/api/save', blob);
      }
    };
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush(); };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
    };
  }, []);

  function buy(i, mode) {
    setRun((prev) => {
      const def = TIER_DEFS[i];
      const ts = prev.tiers[i];
      const n = mode === 'max' ? maxAffordable(def, ts.owned, prev.credits) : mode;
      if (n <= 0) return prev;
      const cost = costForN(def, ts.owned, n);
      if (cost > prev.credits) return prev;
      const tiers = [...prev.tiers];
      tiers[i] = { ...ts, owned: ts.owned + n };
      return { ...prev, credits: prev.credits - cost, tiers };
    });
  }
  function collectTier(i) {
    setRun((prev) => {
      const ts = prev.tiers[i];
      if (ts.ready <= 0) return prev;
      const tiers = [...prev.tiers];
      tiers[i] = { ...ts, ready: 0 };
      return { ...prev, credits: prev.credits + ts.ready, tiers };
    });
  }
  function collectAll() {
    setRun((prev) => {
      let add = 0;
      const tiers = prev.tiers.map((ts) => {
        if (ts.ready > 0) { add += ts.ready; return { ...ts, ready: 0 }; }
        return ts;
      });
      return { ...prev, credits: prev.credits + add, tiers };
    });
  }
  function hireManager(i) {
    const def = TIER_DEFS[i];
    const eff = computeEffects(meta);
    const cost = def.managerCost * eff.automationDiscount;
    setRun((prev) => {
      const ts = prev.tiers[i];
      if (ts.manager || ts.owned < 1 || prev.credits < cost) return prev;
      const tiers = [...prev.tiers];
      tiers[i] = { ...ts, manager: true, ready: 0 };
      return { ...prev, credits: prev.credits - cost + ts.ready, tiers };
    });
  }
  function buyGrid(i, mode) {
    setRun((prev) => {
      const def = GRID_DEFS[i];
      const g = prev.grid[i];
      const n = mode === 'max' ? maxAffordable(def, g.owned, prev.credits) : mode;
      if (n <= 0) return prev;
      const cost = costForN(def, g.owned, n);
      if (cost > prev.credits) return prev;
      const grid = [...prev.grid];
      grid[i] = { ...g, owned: g.owned + n };
      return { ...prev, credits: prev.credits - cost, grid };
    });
  }
  function buyOverclock(i, mode) {
    setRun((prev) => {
      if (prev.heatCooldownUntil && Date.now() < prev.heatCooldownUntil) return prev;
      const def = OVERCLOCK_DEFS[i];
      const o = prev.overclock[i];
      const n = mode === 'max' ? maxAffordable(def, o.owned, prev.credits) : mode;
      if (n <= 0) return prev;
      const cost = costForN(def, o.owned, n);
      if (cost > prev.credits) return prev;
      const overclock = [...prev.overclock];
      overclock[i] = { ...o, owned: o.owned + n };
      return { ...prev, credits: prev.credits - cost, overclock };
    });
  }
  function ventHeat() {
    if (Date.now() < ventCooldownRef.current) return;
    if (run.heatCooldownUntil && Date.now() < run.heatCooldownUntil) return;
    setRun((prev) => ({ ...prev, heat: Math.max(0, prev.heat - 25) }));
    ventCooldownRef.current = Date.now() + VENT_COOLDOWN_MS;
  }
  function doMigrate() {
    const eff = computeEffects(meta);
    const gain = migrateGain(run.lifetimeRun, eff.legacyGainMult);
    if (gain <= 0) return;
    const echoBonus = eff.echoCoresBonus || 0;
    const startCredits = (10 + eff.deepCacheBonus) * eff.bootstrapMult;
    setRun({ ...initialRun(), credits: startCredits });
    setMeta((prev) => ({ ...prev, legacyCores: prev.legacyCores + gain + echoBonus, stats: { ...prev.stats, migrates: prev.stats.migrates + 1 } }));
    setModal(null);
  }
  function doSingularity() {
    const shardsGained = Math.floor(Math.sqrt(meta.legacyCores));
    if (shardsGained <= 0) return;
    setRun(initialRun());
    setMeta((prev) => ({ ...prev, legacyCores: 0, singularityShards: prev.singularityShards + shardsGained, stats: { ...prev.stats, singularities: prev.stats.singularities + 1 } }));
    setModal({ type: 'singularityDone', shards: shardsGained });
  }
  function hardReset() {
    setRun(initialRun());
    setMeta(initialMeta());
    fetch('/api/save', { method: 'DELETE', credentials: 'include' }).catch(() => { /* ignore */ });
    setModal(null);
    setProfileOpen(false);
  }
  function logout() {
    fetch('/auth/logout', { method: 'POST', credentials: 'include' }).finally(() => window.location.reload());
  }
  function claimGoal(g) {
    if (meta.goalsCompleted[g.id]) return;
    let xp = meta.xp + g.xp;
    let level = meta.level;
    let leveled = false;
    while (xp >= xpForLevel(level)) { xp -= xpForLevel(level); level++; leveled = true; }
    setMeta((prev) => ({ ...prev, xp, level, wafers: prev.wafers + g.wafers, goalsCompleted: { ...prev.goalsCompleted, [g.id]: true }, stats: { ...prev.stats, totalWafersEarned: (prev.stats.totalWafersEarned || 0) + g.wafers } }));
    setModal({ type: leveled ? 'levelUp' : 'goalClaim', level, goal: g });
  }
  function claimRepeatable(def, ctx) {
    const level = meta.repeatable[def.id] || 0;
    const target = def.target(level);
    const cur = def.metric(ctx);
    if (cur < target) return;
    const xpGain = def.xp(level);
    const waferGain = def.wafers(level);
    let xp = meta.xp + xpGain;
    let lvl = meta.level;
    let leveled = false;
    while (xp >= xpForLevel(lvl)) { xp -= xpForLevel(lvl); lvl++; leveled = true; }
    setMeta((prev) => ({ ...prev, xp, level: lvl, wafers: prev.wafers + waferGain, repeatable: { ...prev.repeatable, [def.id]: level + 1 }, stats: { ...prev.stats, totalWafersEarned: (prev.stats.totalWafersEarned || 0) + waferGain } }));
    setModal({ type: leveled ? 'levelUp' : 'goalClaim', level: lvl, goal: { xp: xpGain, wafers: waferGain } });
  }
  function buyUpgrade(u) {
    const level = meta.upgrades[u.id] || 0;
    if (level >= u.maxLevel) return;
    const cost = Math.ceil(u.baseCost * Math.pow(u.costMult, level));
    if (meta.wafers < cost) return;
    setMeta((prev) => ({ ...prev, wafers: prev.wafers - cost, upgrades: { ...prev.upgrades, [u.id]: level + 1 } }));
  }
  function buyShardUpgrade(u) {
    const level = meta.shardUpgrades[u.id] || 0;
    if (level >= u.maxLevel) return;
    const cost = Math.ceil(u.baseCost * Math.pow(u.costMult, level));
    if (meta.singularityShards < cost) return;
    setMeta((prev) => ({ ...prev, singularityShards: prev.singularityShards - cost, shardUpgrades: { ...prev.shardUpgrades, [u.id]: level + 1 } }));
  }

  function finishRush(taps) {
    const eff = computeEffects(metaRef.current);
    const wafers = Math.max(1, Math.floor((taps / 4) * eff.luckyMinigameMult));
    setMeta((prev) => ({ ...prev, wafers: prev.wafers + wafers, stats: { ...prev.stats, minigamesWon: prev.stats.minigamesWon + 1, totalWafersEarned: (prev.stats.totalWafersEarned || 0) + wafers } }));
    if (wafers > 0) gameCooldownsRef.current.rush = Date.now() + GAME_WIN_COOLDOWN_MS;
    setModal({ type: 'minigameResult', text: `${taps} taps — +${wafers} wafers` });
  }
  function finishDebug(score) {
    const eff = computeEffects(metaRef.current);
    const wafers = Math.max(1, Math.floor((score / 2) * eff.luckyMinigameMult));
    setMeta((prev) => ({ ...prev, wafers: prev.wafers + wafers, stats: { ...prev.stats, minigamesWon: prev.stats.minigamesWon + 1, totalWafersEarned: (prev.stats.totalWafersEarned || 0) + wafers } }));
    if (wafers > 0) gameCooldownsRef.current.debug = Date.now() + GAME_WIN_COOLDOWN_MS;
    setModal({ type: 'minigameResult', text: `${score} bugs squashed — +${wafers} wafers` });
  }
  function finishMatch(pairsFound, won) {
    const eff = computeEffects(metaRef.current);
    const wafers = won ? Math.max(1, Math.floor(pairsFound * 2 * eff.luckyMinigameMult)) : 0;
    if (wafers > 0) {
      setMeta((prev) => ({ ...prev, wafers: prev.wafers + wafers, stats: { ...prev.stats, minigamesWon: prev.stats.minigamesWon + 1, totalWafersEarned: (prev.stats.totalWafersEarned || 0) + wafers } }));
      gameCooldownsRef.current.match = Date.now() + GAME_WIN_COOLDOWN_MS;
    }
    const resultText = wafers > 0
      ? `${pairsFound}/${MATCH_PAIR_COUNT} pairs matched — +${wafers} wafers`
      : `${pairsFound}/${MATCH_PAIR_COUNT} pairs matched — no payout, not fully matched`;
    setModal({ type: 'minigameResult', text: resultText });
  }
  function finishBalance(score) {
    const eff = computeEffects(metaRef.current);
    const wafers = Math.max(1, Math.floor(score * 1.5 * eff.luckyMinigameMult));
    setMeta((prev) => ({ ...prev, wafers: prev.wafers + wafers, stats: { ...prev.stats, minigamesWon: prev.stats.minigamesWon + 1, totalWafersEarned: (prev.stats.totalWafersEarned || 0) + wafers } }));
    if (wafers > 0) gameCooldownsRef.current.balance = Date.now() + GAME_WIN_COOLDOWN_MS;
    setModal({ type: 'minigameResult', text: `${score} stabilizations — +${wafers} wafers` });
  }

  function startRushGame() {
    if (Date.now() < gameCooldownsRef.current.rush) return;
    setMinigame({ type: 'rush', timeLeft: 10, taps: 0 });
  }
  function tapRush() { setMinigame((m) => (m && m.type === 'rush' ? { ...m, taps: m.taps + 1 } : m)); }

  function scheduleDebugSpawn() {
    const delay = DEBUG_SPAWN_MIN_MS + Math.random() * (DEBUG_SPAWN_MAX_MS - DEBUG_SPAWN_MIN_MS);
    debugSpawnRef.current = setTimeout(() => {
      setMinigame((m) => {
        if (!m || m.type !== 'debug') return m;
        if (m.lit.length >= DEBUG_MAX_LIT) return m;
        let idx;
        do { idx = Math.floor(Math.random() * 9); } while (m.lit.includes(idx));
        return { ...m, lit: [...m.lit, idx] };
      });
      scheduleDebugSpawn();
    }, delay);
  }
  function startDebugGame() {
    if (Date.now() < gameCooldownsRef.current.debug) return;
    setMinigame({ type: 'debug', timeLeft: 15, score: 0, lit: [] });
    if (debugSpawnRef.current) clearTimeout(debugSpawnRef.current);
    scheduleDebugSpawn();
  }
  function tapDebugTile(idx) {
    setMinigame((m) => {
      if (!m || m.type !== 'debug') return m;
      if (!m.lit.includes(idx)) return m;
      return { ...m, score: m.score + 1, lit: m.lit.filter((i) => i !== idx) };
    });
  }

  function startMatchGame() {
    if (Date.now() < gameCooldownsRef.current.match) return;
    const deck = [];
    for (let i = 0; i < MATCH_PAIR_COUNT; i++) deck.push(i, i);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
    }
    setMinigame({ type: 'match', order: deck, revealed: Array(deck.length).fill(false), matched: Array(deck.length).fill(false), picks: [], timeLeft: 40, pairsFound: 0 });
  }
  function tapMatchTile(idx) {
    setMinigame((m) => {
      if (!m || m.type !== 'match') return m;
      if (m.matched[idx] || m.revealed[idx] || m.picks.length >= 2) return m;
      const revealed = [...m.revealed]; revealed[idx] = true;
      const picks = [...m.picks, idx];
      let next = { ...m, revealed, picks };
      if (picks.length === 2) {
        const [a, b] = picks;
        if (m.order[a] === m.order[b]) {
          const matched = [...m.matched]; matched[a] = true; matched[b] = true;
          const pairsFound = m.pairsFound + 1;
          if (pairsFound === MATCH_PAIR_COUNT) {
            // Finish immediately - don't wait for the timer.
            setTimeout(() => finishMatch(pairsFound, true), 0);
            return null;
          }
          next = { ...next, matched, picks: [], pairsFound };
        } else {
          setTimeout(() => {
            setMinigame((mm) => {
              if (!mm || mm.type !== 'match') return mm;
              const revealed2 = [...mm.revealed]; revealed2[a] = false; revealed2[b] = false;
              return { ...mm, revealed: revealed2, picks: [] };
            });
          }, 700);
        }
      }
      return next;
    });
  }

  function startBalanceGame() {
    if (Date.now() < gameCooldownsRef.current.balance) return;
    setMinigame({ type: 'balance', timeLeft: 12, score: 0 });
  }
  function balanceHit() {
    setMinigame((m) => (m && m.type === 'balance' ? { ...m, score: m.score + 1 } : m));
  }
  function balanceMiss() {
    setMinigame((m) => (m && m.type === 'balance' ? { ...m, score: Math.max(0, m.score - BALANCE_MISS_PENALTY) } : m));
  }

  function cancelMinigame() {
    if (minigame && minigame.type === 'debug' && debugSpawnRef.current) { clearTimeout(debugSpawnRef.current); debugSpawnRef.current = null; }
    setMinigame(null);
  }

  if (!loaded) {
    return (
      <div style={{ minHeight: '100vh', background: '#0E141B', color: textDim, display: 'flex', alignItems: 'center', justifyContent: 'center' }} className="font-mono text-sm">
        Booting rack...
      </div>
    );
  }

  const eff = computeEffects(meta);
  const thresholds = MILESTONES.map((t) => Math.max(1, Math.round(t * eff.milestoneDiscount)));
  const boostMultNow = boost && Date.now() < boost.until ? boost.mult : 1;
  const racksMult = (1 + meta.legacyCores * 0.05) * eff.firmwareMult * eff.engineMult * eff.levelBonusMult * boostMultNow;
  const gridMult = racksMult * eff.gridExtraMult;
  const overclockMult = racksMult * eff.overclockExtraMult;
  const heatOnCooldown = !!run.heatCooldownUntil && Date.now() < run.heatCooldownUntil;
  const cooldownSecondsLeft = heatOnCooldown ? Math.max(0, Math.ceil((run.heatCooldownUntil - Date.now()) / 1000)) : 0;
  const racksOutput = run.tiers.reduce((sum, ts, i) => sum + tierRate(ts.owned, TIER_DEFS[i].baseProd, racksMult, thresholds), 0);
  const gridOutput = run.grid.reduce((sum, g, i) => sum + tierRate(g.owned, GRID_DEFS[i].baseProd, gridMult, thresholds), 0);
  const overclockOutput = heatOnCooldown ? 0 : run.overclock.reduce((sum, o, i) => sum + tierRate(o.owned, OVERCLOCK_DEFS[i].baseProd, overclockMult, thresholds), 0);
  const totalOutputPerSec = racksOutput + gridOutput + overclockOutput;
  const anyReady = run.tiers.some((ts) => !ts.manager && ts.ready > 0.01);
  const gain = migrateGain(run.lifetimeRun, eff.legacyGainMult);
  const singularityGain = Math.floor(Math.sqrt(meta.legacyCores));

  let unlockedUpTo = 0;
  for (let i = 1; i < TIER_DEFS.length; i++) {
    if (run.tiers[i - 1].owned >= 1) unlockedUpTo = i; else break;
  }
  const gridUnlocked = run.tiers[2].owned >= 1;
  const overclockUnlocked = run.tiers[3].owned >= 1;
  const singularityUnlocked = meta.legacyCores >= 50 || meta.stats.singularities > 0 || meta.singularityShards > 0;
  const ventDisabled = Date.now() < ventCooldownRef.current;
  const heatColor = run.heat < 50 ? '#4FC3B0' : run.heat < 80 ? '#E8A33D' : '#E05C4C';

  const ctx = { run, meta, totalOutputPerSec, unlockedUpTo };
  const xpNeeded = xpForLevel(meta.level);

  const claimEvent = () => {
    if (!eventState) return;
    const roll = Math.random();
    if (roll < 0.5) {
      const seconds = 30 + Math.random() * 60;
      const amount = Math.max(totalOutputPerSec * seconds, 20) * eff.eventRewardMult;
      setRun((prev) => ({ ...prev, credits: prev.credits + amount, lifetimeRun: prev.lifetimeRun + amount }));
      setModal({ type: 'eventClaim', text: `+${Math.round(amount)} FLOPS collected` });
    } else {
      const mult = [2, 3, 4][Math.floor(Math.random() * 3)];
      const duration = (45 + Math.random() * 30) * eff.eventRewardMult;
      setBoost({ mult, until: Date.now() + duration * 1000 });
      setModal({ type: 'eventClaim', text: `×${mult} output boost for ${Math.round(duration)}s` });
    }
    nextEligibleRef.current = Date.now() + randEventDelay();
    setEventState(null);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#0E141B',
        backgroundImage:
          'repeating-linear-gradient(0deg, rgba(255,255,255,0.03) 0px, rgba(255,255,255,0.03) 1px, transparent 1px, transparent 32px), repeating-linear-gradient(90deg, rgba(255,255,255,0.03) 0px, rgba(255,255,255,0.03) 1px, transparent 1px, transparent 32px)',
        color: '#EAEFF5',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      }}
      className="pb-24"
    >
      <style>{`
        @keyframes ledPulse { 0%,100% { opacity:1; } 50% { opacity:0.45; } }
        @keyframes floatIn { from { opacity:0; transform: translateY(8px);} to {opacity:1; transform:translateY(0);} }
        @keyframes popCollect { 0% {transform:scale(1);} 40% {transform:scale(1.06);} 100% {transform:scale(1);} }
        @keyframes eventPulse { 0%,100% {transform:scale(1);} 50% {transform:scale(1.15);} }
        .tier-card { animation: floatIn 0.35s ease both; }
        .led-on { animation: ledPulse 1.6s ease-in-out infinite; }
        .collect-pop { animation: popCollect 0.2s ease; }
        .event-icon { animation: eventPulse 0.9s ease-in-out infinite; }
      `}</style>

      <div className="sticky top-0 z-10 border-b" style={{ background: 'rgba(14,20,27,0.96)', backdropFilter: 'blur(6px)', borderColor: cardBorder }}>
        <div className="max-w-2xl mx-auto px-4 pt-3">
          <HeaderBar user={user} level={meta.level} onOpenProfile={() => setProfileOpen(true)} />
          <StatsRow run={run} meta={meta} totalOutputPerSec={totalOutputPerSec} xpNeeded={xpNeeded} boost={boost} boostMultNow={boostMultNow} />
          <MigrateBar gain={gain} anyReady={anyReady} onMigrate={() => setModal({ type: 'migrate' })} onCollectAll={collectAll} />
          <TabBar tabs={TABS} activeTab={activeTab} setActiveTab={setActiveTab} gridUnlocked={gridUnlocked} overclockUnlocked={overclockUnlocked} singularityUnlocked={singularityUnlocked} />
        </div>
      </div>

      {activeTab === 'racks' && (
        <RacksPanel run={run} unlockedUpTo={unlockedUpTo} racksMult={racksMult} thresholds={thresholds} eff={eff} onBuy={buy} onCollect={collectTier} onHire={hireManager} />
      )}

      {activeTab === 'grid' && (
        <GridPanel run={run} gridMult={gridMult} thresholds={thresholds} onBuy={buyGrid} />
      )}

      {activeTab === 'overclock' && (
        <OverclockPanel
          run={run}
          overclockMult={overclockMult}
          thresholds={thresholds}
          onBuy={buyOverclock}
          onVent={ventHeat}
          ventDisabled={ventDisabled}
          heatColor={heatColor}
          onCooldown={heatOnCooldown}
          cooldownSecondsLeft={cooldownSecondsLeft}
        />
      )}

      {activeTab === 'upgrades' && <UpgradesPanel meta={meta} onBuy={buyUpgrade} />}

      {activeTab === 'singularity' && (
        <SingularityPanel meta={meta} singularityGain={singularityGain} onOpenSingularityConfirm={() => setModal({ type: 'singularity' })} onBuyShard={buyShardUpgrade} />
      )}

      {activeTab === 'goals' && (
        <GoalsPanel ctx={ctx} meta={meta} onClaimGoal={claimGoal} onClaimRepeatable={(def) => claimRepeatable(def, ctx)} />
      )}

      {activeTab === 'games' && !minigame && (
        <GamesPanel
          onStartRush={startRushGame}
          onStartDebug={startDebugGame}
          onStartMatch={startMatchGame}
          onStartBalance={startBalanceGame}
          cooldowns={gameCooldownsRef.current}
        />
      )}

      {minigame && minigame.type === 'rush' && <RushOverlay minigame={minigame} onTap={tapRush} onCancel={cancelMinigame} />}
      {minigame && minigame.type === 'debug' && <DebugOverlay minigame={minigame} onTap={tapDebugTile} onCancel={cancelMinigame} />}
      {minigame && minigame.type === 'match' && <MatchOverlay minigame={minigame} onTap={tapMatchTile} onCancel={cancelMinigame} />}
      {minigame && minigame.type === 'balance' && <BalanceOverlay minigame={minigame} onBarHit={balanceHit} onMiss={balanceMiss} onCancel={cancelMinigame} />}

      <EventToast eventState={eventState} onClaim={claimEvent} />

      {profileOpen && (
        <ProfileView
          meta={meta}
          memberSince={user && user.memberSince}
          onClose={() => setProfileOpen(false)}
          onLogout={logout}
          onOpenReset={() => setModal({ type: 'reset' })}
        />
      )}

      <ModalRoot
        modal={modal}
        setModal={setModal}
        meta={meta}
        gain={gain}
        singularityGain={singularityGain}
        onMigrate={doMigrate}
        onSingularity={doSingularity}
        onHardReset={hardReset}
      />
    </div>
  );
}
