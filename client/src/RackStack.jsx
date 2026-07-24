import React, { useState, useEffect, useRef } from 'react';
import {
  Cpu, HardDrive, Server, Database, Building2, Factory, Cloud, Landmark,
  Satellite, Sun, Moon, Radio, Orbit, Atom, RefreshCw, RotateCcw, Zap,
  Users, Wifi, GraduationCap, Briefcase, Globe, Layers, Network,
  ShoppingBag, ListChecks, Gamepad2, Gem, Bug, X, Wind, Droplets, Waves,
  Snowflake, Sparkles, Flame, Cable, Plug,
} from 'lucide-react';

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

const GROWTH = 1.14;
const TICK_MS = 250;
const MILESTONES = [25, 50, 100, 200, 500, 1000];
const EVENT_WINDOW = 15000;
const EVENT_MIN_DELAY = 70000;
const EVENT_MAX_DELAY = 150000;
const EVENT_LABELS = [
  'Anomalous compute spike detected',
  'Unscheduled maintenance window open',
  'Surplus cycles up for grabs',
  'Rogue background process found',
];

const TIER_DEFS = [
  { id: 0, name: 'Spare Raspberry Pi', Icon: Cpu, baseCost: 4, baseProd: 0.5, managerCost: 500 },
  { id: 1, name: 'Refurbished Gaming Rig', Icon: HardDrive, baseCost: 60, baseProd: 6, managerCost: 6000 },
  { id: 2, name: 'Home NAS Tower', Icon: Server, baseCost: 720, baseProd: 45, managerCost: 70000 },
  { id: 3, name: 'Colo Rack Unit', Icon: Database, baseCost: 8800, baseProd: 320, managerCost: 900000 },
  { id: 4, name: 'Server Room', Icon: Building2, baseCost: 110000, baseProd: 2200, managerCost: 12000000 },
  { id: 5, name: 'Regional Data Center', Icon: Factory, baseCost: 1400000, baseProd: 16000, managerCost: 170000000 },
  { id: 6, name: 'Cloud Availability Zone', Icon: Cloud, baseCost: 20000000, baseProd: 120000, managerCost: 2400000000 },
  { id: 7, name: 'Hyperscale Campus', Icon: Landmark, baseCost: 330000000, baseProd: 900000, managerCost: 40000000000 },
  { id: 8, name: 'Orbital Compute Platform', Icon: Satellite, baseCost: 5000000000, baseProd: 7000000, managerCost: 650000000000 },
  { id: 9, name: 'Dyson Swarm Cluster', Icon: Sun, baseCost: 80000000000, baseProd: 55000000, managerCost: 10000000000000 },
  { id: 10, name: 'Lunar Compute Colony', Icon: Moon, baseCost: 1250000000000, baseProd: 430000000, managerCost: 160000000000000 },
  { id: 11, name: 'Interstellar Relay Farm', Icon: Radio, baseCost: 19000000000000, baseProd: 3300000000, managerCost: 2400000000000000 },
  { id: 12, name: 'Galactic Mesh Network', Icon: Orbit, baseCost: 300000000000000, baseProd: 26000000000, managerCost: 37000000000000000 },
  { id: 13, name: 'Quantum Foam Harvester', Icon: Atom, baseCost: 4600000000000000, baseProd: 200000000000, managerCost: 580000000000000000 },
];

const GRID_DEFS = [
  { id: 0, name: 'Home Volunteer', Icon: Users, baseCost: 50, baseProd: 3 },
  { id: 1, name: "Internet Cafe Node", Icon: Wifi, baseCost: 900, baseProd: 28 },
  { id: 2, name: 'University Cluster', Icon: GraduationCap, baseCost: 15000, baseProd: 220 },
  { id: 3, name: 'Corporate Donor Farm', Icon: Briefcase, baseCost: 260000, baseProd: 1800 },
  { id: 4, name: 'Global BOINC Alliance', Icon: Globe, baseCost: 4500000, baseProd: 15000 },
];

const OVERCLOCK_DEFS = [
  { id: 0, name: 'Air-Cooled Overclock Rig', Icon: Wind, baseCost: 300, baseProd: 40, heatPerSec: 0.15 },
  { id: 1, name: 'Liquid-Cooled Blade', Icon: Droplets, baseCost: 5500, baseProd: 320, heatPerSec: 0.22 },
  { id: 2, name: 'Immersion Tank Cluster', Icon: Waves, baseCost: 95000, baseProd: 2600, heatPerSec: 0.30 },
  { id: 3, name: 'Cryo-Chilled Array', Icon: Snowflake, baseCost: 1600000, baseProd: 21000, heatPerSec: 0.40 },
  { id: 4, name: 'Superconducting Core', Icon: Sparkles, baseCost: 28000000, baseProd: 170000, heatPerSec: 0.55 },
];

const UPGRADE_DEFS = [
  { id: 'firmware', name: 'Overclocked Firmware', desc: '+10% output on every lane per level', baseCost: 5, costMult: 1.6, maxLevel: 20 },
  { id: 'psu', name: 'Redundant PSUs', desc: 'Automation costs -4% per level', baseCost: 8, costMult: 1.6, maxLevel: 10 },
  { id: 'uptime', name: 'Extended Uptime', desc: 'Offline earnings cap +1 hour per level', baseCost: 12, costMult: 1.8, maxLevel: 8 },
  { id: 'signal', name: 'Signal Boost', desc: 'Anomaly event rewards +20% per level', baseCost: 6, costMult: 1.5, maxLevel: 10 },
  { id: 'gridamp', name: 'Grid Amplifier', desc: 'Grid lane output +25% per level', baseCost: 10, costMult: 1.6, maxLevel: 15 },
  { id: 'legacy', name: 'Legacy Insight', desc: 'Migrate Legacy Core gain +10% per level', baseCost: 20, costMult: 2.0, maxLevel: 10 },
  { id: 'thermal', name: 'Thermal Regulators', desc: 'Overclock Bay heat generation -8% per level', baseCost: 8, costMult: 1.7, maxLevel: 8 },
  { id: 'autovent', name: 'Auto-Vent System', desc: 'Passively vents 0.5 heat/sec per level', baseCost: 15, costMult: 1.8, maxLevel: 8 },
  { id: 'occlock', name: 'Overclock Amplifier', desc: '+25% Overclock Bay output per level', baseCost: 12, costMult: 1.6, maxLevel: 15 },
  { id: 'lucky', name: 'Lucky Silicon', desc: 'Minigame wafer rewards +15% per level', baseCost: 6, costMult: 1.5, maxLevel: 10 },
  { id: 'deepcache', name: 'Deep Cache', desc: 'Start each Migrate with +10 Compute Balance per level', baseCost: 4, costMult: 1.4, maxLevel: 10 },
];

const SINGULARITY_DEFS = [
  { id: 'bootstrap', name: 'Quantum Bootstrap', desc: 'Starting Compute Balance after Migrate x10 per level', baseCost: 3, costMult: 2.2, maxLevel: 5 },
  { id: 'temporal', name: 'Temporal Compression', desc: 'Legacy Core gain from Migrate +25% per level', baseCost: 4, costMult: 2.4, maxLevel: 5 },
  { id: 'engine', name: 'Singularity Engine', desc: '+50% output on every lane per level', baseCost: 6, costMult: 2.6, maxLevel: 8 },
  { id: 'heatsink', name: 'Heat Sink Mastery', desc: 'Overclock Bay heat generation -25% per level', baseCost: 3, costMult: 2.2, maxLevel: 4 },
  { id: 'infiniteloop', name: 'Infinite Loop', desc: 'Milestone thresholds -10% per level, easier to reach', baseCost: 5, costMult: 2.5, maxLevel: 5 },
  { id: 'echocores', name: 'Echo Cores', desc: 'Instantly regain 1 free Legacy Core per level after every Migrate', baseCost: 4, costMult: 2.3, maxLevel: 10 },
];

const GOAL_DEFS = [
  { id: 'g1', desc: 'Own 5 Spare Raspberry Pis', xp: 10, wafers: 2, progress: (ctx) => [ctx.run.tiers[0].owned, 5] },
  { id: 'g2', desc: 'Reach 100 FLOPS/s total output', xp: 15, wafers: 3, progress: (ctx) => [Math.floor(ctx.totalOutputPerSec), 100] },
  { id: 'g3', desc: 'Automate your first rack', xp: 15, wafers: 3, progress: (ctx) => [ctx.run.tiers.some((t) => t.manager) ? 1 : 0, 1] },
  { id: 'g4', desc: 'Own a Home NAS Tower', xp: 12, wafers: 3, progress: (ctx) => [ctx.run.tiers[2].owned >= 1 ? 1 : 0, 1] },
  { id: 'g5', desc: 'Recruit 5 Grid volunteers', xp: 18, wafers: 5, progress: (ctx) => [ctx.run.grid.reduce((s, g) => s + g.owned, 0), 5] },
  { id: 'g6', desc: 'Reach 10K FLOPS/s total output', xp: 25, wafers: 8, progress: (ctx) => [Math.floor(ctx.totalOutputPerSec), 10000] },
  { id: 'g7', desc: 'Hit a x2 milestone on any rack (own 25)', xp: 20, wafers: 6, progress: (ctx) => [ctx.run.tiers.some((t) => t.owned >= 25) ? 1 : 0, 1] },
  { id: 'g8', desc: 'Complete your first Migrate', xp: 30, wafers: 10, progress: (ctx) => [ctx.meta.stats.migrates, 1] },
  { id: 'g9', desc: 'Win a minigame', xp: 15, wafers: 5, progress: (ctx) => [ctx.meta.stats.minigamesWon, 1] },
  { id: 'g10', desc: 'Unlock the Hyperscale Campus', xp: 35, wafers: 12, progress: (ctx) => [ctx.unlockedUpTo >= 7 ? 1 : 0, 1] },
  { id: 'g11', desc: 'Reach 1M FLOPS/s total output', xp: 50, wafers: 18, progress: (ctx) => [Math.floor(ctx.totalOutputPerSec), 1000000] },
  { id: 'g12', desc: 'Own 3 Legacy Cores', xp: 45, wafers: 15, progress: (ctx) => [ctx.meta.legacyCores, 3] },
  { id: 'g13', desc: 'Buy your first Upgrade', xp: 20, wafers: 8, progress: (ctx) => [Object.values(ctx.meta.upgrades).some((l) => l > 0) ? 1 : 0, 1] },
  { id: 'g14', desc: 'Unlock the Quantum Foam Harvester', xp: 80, wafers: 30, progress: (ctx) => [ctx.unlockedUpTo >= 13 ? 1 : 0, 1] },
  { id: 'g15', desc: 'Recruit your first Overclock node', xp: 25, wafers: 8, progress: (ctx) => [ctx.run.overclock.reduce((s, o) => s + o.owned, 0) >= 1 ? 1 : 0, 1] },
  { id: 'g16', desc: 'Trigger your first Singularity', xp: 100, wafers: 40, progress: (ctx) => [ctx.meta.stats.singularities >= 1 ? 1 : 0, 1] },
];

const REPEATABLE_DEFS = [
  { id: 'r_output', desc: (n) => `Reach ${fmt(n)} FLOPS/s total output`, target: (lvl) => 100 * Math.pow(8, lvl), xp: (lvl) => 15 + lvl * 8, wafers: (lvl) => 4 + lvl * 3, metric: (ctx) => ctx.totalOutputPerSec },
  { id: 'r_racks', desc: (n) => `Own ${n} of any single rack tier`, target: (lvl) => Math.round(10 * Math.pow(1.8, lvl)), xp: (lvl) => 12 + lvl * 6, wafers: (lvl) => 3 + lvl * 2, metric: (ctx) => Math.max(0, ...ctx.run.tiers.map((t) => t.owned)) },
  { id: 'r_grid', desc: (n) => `Recruit ${n} total Grid volunteers`, target: (lvl) => Math.round(10 * Math.pow(1.7, lvl)), xp: (lvl) => 12 + lvl * 6, wafers: (lvl) => 3 + lvl * 2, metric: (ctx) => ctx.run.grid.reduce((s, g) => s + g.owned, 0) },
  { id: 'r_overclock', desc: (n) => `Own ${n} total Overclock nodes`, target: (lvl) => Math.round(5 * Math.pow(1.7, lvl)), xp: (lvl) => 14 + lvl * 7, wafers: (lvl) => 4 + lvl * 2, metric: (ctx) => ctx.run.overclock.reduce((s, o) => s + o.owned, 0) },
  { id: 'r_migrate', desc: (n) => `Complete ${n} total Migrates`, target: (lvl) => lvl + 1, xp: (lvl) => 20 + lvl * 10, wafers: (lvl) => 6 + lvl * 3, metric: (ctx) => ctx.meta.stats.migrates },
  { id: 'r_wafers', desc: (n) => `Earn ${fmt(n)} Wafers lifetime`, target: (lvl) => Math.round(20 * Math.pow(2.2, lvl)), xp: (lvl) => 15 + lvl * 8, wafers: (lvl) => 5 + lvl * 3, metric: (ctx) => ctx.meta.stats.totalWafersEarned },
];

const MATCH_ICONS = [Wifi, Radio, Satellite, Cable, Plug, Zap];

function costAt(def, owned) {
  return def.baseCost * Math.pow(GROWTH, owned);
}
function costForN(def, owned, n) {
  if (n <= 0) return 0;
  const c0 = costAt(def, owned);
  return c0 * (Math.pow(GROWTH, n) - 1) / (GROWTH - 1);
}
function maxAffordable(def, owned, credits) {
  const c0 = costAt(def, owned);
  if (credits < c0) return 0;
  const n = Math.floor(Math.log(1 + (credits * (GROWTH - 1)) / c0) / Math.log(GROWTH));
  return Math.max(n, 0);
}
function milestoneMult(owned, thresholds) {
  let count = 0;
  for (const t of thresholds) if (owned >= t) count++;
  return Math.pow(2, count);
}
function nextMilestone(owned, thresholds) {
  return thresholds.find((t) => owned < t) || null;
}
function tierRate(owned, baseProd, mult, thresholds) {
  return owned * baseProd * mult * milestoneMult(owned, thresholds);
}
function fmt(n) {
  if (!isFinite(n)) return '\u221e';
  if (n < 0) return '-' + fmt(-n);
  if (n < 1000) {
    if (n === 0) return '0';
    if (n < 10) return n.toFixed(2);
    if (n < 100) return n.toFixed(1);
    return Math.floor(n).toString();
  }
  const suffixes = ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q'];
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier >= suffixes.length) return n.toExponential(2);
  const scaled = n / Math.pow(1000, tier);
  const decimals = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  return scaled.toFixed(decimals) + suffixes[tier];
}
function xpForLevel(level) {
  return Math.floor(50 * Math.pow(level + 1, 1.6));
}
function randEventDelay() {
  return EVENT_MIN_DELAY + Math.random() * (EVENT_MAX_DELAY - EVENT_MIN_DELAY);
}
function freshTiers() {
  return TIER_DEFS.map((t) => ({ id: t.id, owned: 0, manager: false, ready: 0 }));
}
function freshGrid() {
  return GRID_DEFS.map((g) => ({ id: g.id, owned: 0 }));
}
function freshOverclock() {
  return OVERCLOCK_DEFS.map((o) => ({ id: o.id, owned: 0 }));
}
function initialRun() {
  return { credits: 10, lifetimeRun: 0, tiers: freshTiers(), grid: freshGrid(), overclock: freshOverclock(), heat: 0 };
}
function initialMeta() {
  return {
    legacyCores: 0, wafers: 0, level: 0, xp: 0,
    goalsCompleted: {}, upgrades: {}, shardUpgrades: {}, repeatable: {},
    singularityShards: 0,
    stats: { migrates: 0, minigamesWon: 0, singularities: 0, totalWafersEarned: 0 },
  };
}
function computeEffects(meta) {
  const lv = meta.upgrades || {};
  const sv = meta.shardUpgrades || {};
  return {
    firmwareMult: 1 + 0.10 * (lv.firmware || 0),
    engineMult: 1 + 0.50 * (sv.engine || 0),
    automationDiscount: Math.max(0.5, 1 - 0.04 * (lv.psu || 0)),
    offlineCapHours: 4 + (lv.uptime || 0),
    eventRewardMult: 1 + 0.20 * (lv.signal || 0),
    gridExtraMult: 1 + 0.25 * (lv.gridamp || 0),
    overclockExtraMult: 1 + 0.25 * (lv.occlock || 0),
    legacyGainMult: (1 + 0.10 * (lv.legacy || 0)) * (1 + 0.25 * (sv.temporal || 0)),
    levelBonusMult: 1 + 0.02 * (meta.level || 0),
    heatDiscount: Math.max(0.15, 1 - 0.08 * (lv.thermal || 0) - 0.25 * (sv.heatsink || 0)),
    autoVentPerSec: 0.5 * (lv.autovent || 0),
    luckyMinigameMult: 1 + 0.15 * (lv.lucky || 0),
    deepCacheBonus: 10 * (lv.deepcache || 0),
    bootstrapMult: Math.pow(10, sv.bootstrap || 0),
    milestoneDiscount: Math.max(0.3, 1 - 0.10 * (sv.infiniteloop || 0)),
    echoCoresBonus: sv.echocores || 0,
  };
}
function migrateGain(lifetimeRun, legacyGainMult) {
  return Math.floor(Math.sqrt(lifetimeRun / 1e6) * legacyGainMult);
}

const cardBg = '#161F2B';
const cardBorder = '#26313F';
const inset = '#1D2836';
const textMain = '#EAEFF5';
const textDim = '#7C8AA0';
const amber = '#E8A33D';
const teal = '#4FC3B0';
const violet = '#9C8CF2';
const danger = '#E05C4C';

function buyBtnStyle(afford) {
  return {
    background: afford ? inset : cardBg,
    border: `1px solid ${cardBorder}`,
    color: afford ? textMain : textDim,
    opacity: afford ? 1 : 0.55,
    cursor: afford ? 'pointer' : 'not-allowed',
  };
}

const TABS = [
  { id: 'racks', label: 'Racks', Icon: Layers },
  { id: 'grid', label: 'Grid', Icon: Network },
  { id: 'overclock', label: 'Overclock', Icon: Flame },
  { id: 'upgrades', label: 'Upgrades', Icon: ShoppingBag },
  { id: 'singularity', label: 'Singular.', Icon: Sparkles },
  { id: 'goals', label: 'Goals', Icon: ListChecks },
  { id: 'games', label: 'Games', Icon: Gamepad2 },
];

export default function RackStack({ user }) {
  const [run, setRun] = useState(initialRun());
  const [meta, setMeta] = useState(initialMeta());
  const [loaded, setLoaded] = useState(false);
  const [modal, setModal] = useState(null);
  const [eventState, setEventState] = useState(null);
  const [boost, setBoost] = useState(null);
  const [activeTab, setActiveTab] = useState('racks');
  const [minigame, setMinigame] = useState(null);
  const [showCompleted, setShowCompleted] = useState(false);

  const saveRef = useRef({ run, meta });
  const metaRef = useRef(meta);
  const boostRef = useRef(null);
  const minigameRef = useRef(null);
  const nextEligibleRef = useRef(Date.now() + randEventDelay());
  const debugSpawnRef = useRef(null);
  const ventCooldownRef = useRef(0);

  useEffect(() => { saveRef.current = { run, meta }; }, [run, meta]);
  useEffect(() => { metaRef.current = meta; }, [meta]);
  useEffect(() => { boostRef.current = boost; }, [boost]);
  useEffect(() => { minigameRef.current = minigame; }, [minigame]);
  useEffect(() => () => { if (debugSpawnRef.current) clearInterval(debugSpawnRef.current); }, []);

  // Load save on mount. The server is authoritative for offline production
  // (capped at 72h server-side, see server/gameLogic.js) - it returns the
  // already-caught-up run/meta plus how much was gained while away, so the
  // client does no offline math of its own here.
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
        prev.overclock.forEach((o, i) => {
          if (o.owned === 0) return;
          const produced = tierRate(o.owned, OVERCLOCK_DEFS[i].baseProd, overclockMult, thresholds) * dt;
          creditsGain += produced;
          lifetimeGain += produced;
        });
        const heatGain = prev.overclock.reduce((s, o, i) => s + o.owned * OVERCLOCK_DEFS[i].heatPerSec, 0) * eff.heatDiscount;
        const netHeat = heatGain - eff.autoVentPerSec;
        let newHeat = Math.min(100, Math.max(0, prev.heat + netHeat * dt));
        let overclock = prev.overclock;
        if (newHeat >= 100) {
          meltdown = true;
          overclock = prev.overclock.map((o) => ({ ...o, owned: Math.floor(o.owned * 0.5) }));
          newHeat = 0;
        }
        return { ...prev, credits: prev.credits + creditsGain, lifetimeRun: prev.lifetimeRun + lifetimeGain, tiers, overclock, heat: newHeat };
      });
      if (meltdown) setModal({ type: 'meltdown' });

      const mg = minigameRef.current;
      if (mg && mg.type === 'timing' && mg.timeLeft > 0) {
        let pos = mg.pos + mg.dir * 6;
        let dir = mg.dir;
        if (pos >= 100) { pos = 100; dir = -1; } else if (pos <= 0) { pos = 0; dir = 1; }
        setMinigame((m) => (m && m.type === 'timing' ? { ...m, pos, dir } : m));
      }
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
      if (mg && mg.timeLeft > 0 && (mg.type === 'rush' || mg.type === 'debug' || mg.type === 'match' || mg.type === 'timing')) {
        const newTimeLeft = mg.timeLeft - 1;
        if (newTimeLeft <= 0) {
          if (mg.type === 'debug' && debugSpawnRef.current) { clearInterval(debugSpawnRef.current); debugSpawnRef.current = null; }
          setMinigame(null);
          if (mg.type === 'rush') finishRush(mg.taps);
          else if (mg.type === 'debug') finishDebug(mg.score);
          else if (mg.type === 'match') finishMatch(mg.pairsFound);
          else if (mg.type === 'timing') finishTiming(mg.score);
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
    setRun((prev) => ({ ...prev, heat: Math.max(0, prev.heat - 25) }));
    ventCooldownRef.current = Date.now() + 2500;
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
    setModal({ type: 'minigameResult', text: `${taps} taps \u2014 +${wafers} wafers` });
  }
  function finishDebug(score) {
    const eff = computeEffects(metaRef.current);
    const wafers = Math.max(1, Math.floor((score / 2) * eff.luckyMinigameMult));
    setMeta((prev) => ({ ...prev, wafers: prev.wafers + wafers, stats: { ...prev.stats, minigamesWon: prev.stats.minigamesWon + 1, totalWafersEarned: (prev.stats.totalWafersEarned || 0) + wafers } }));
    setModal({ type: 'minigameResult', text: `${score} bugs squashed \u2014 +${wafers} wafers` });
  }
  function finishMatch(pairsFound) {
    const eff = computeEffects(metaRef.current);
    const wafers = Math.max(1, Math.floor(pairsFound * 2 * eff.luckyMinigameMult));
    setMeta((prev) => ({ ...prev, wafers: prev.wafers + wafers, stats: { ...prev.stats, minigamesWon: prev.stats.minigamesWon + 1, totalWafersEarned: (prev.stats.totalWafersEarned || 0) + wafers } }));
    setModal({ type: 'minigameResult', text: `${pairsFound}/6 pairs matched \u2014 +${wafers} wafers` });
  }
  function finishTiming(score) {
    const eff = computeEffects(metaRef.current);
    const wafers = Math.max(1, Math.floor(score * 1.5 * eff.luckyMinigameMult));
    setMeta((prev) => ({ ...prev, wafers: prev.wafers + wafers, stats: { ...prev.stats, minigamesWon: prev.stats.minigamesWon + 1, totalWafersEarned: (prev.stats.totalWafersEarned || 0) + wafers } }));
    setModal({ type: 'minigameResult', text: `${score} stabilizations \u2014 +${wafers} wafers` });
  }
  function startRushGame() { setMinigame({ type: 'rush', timeLeft: 10, taps: 0 }); }
  function tapRush() { setMinigame((m) => (m && m.type === 'rush' ? { ...m, taps: m.taps + 1 } : m)); }
  function startDebugGame() {
    setMinigame({ type: 'debug', timeLeft: 15, score: 0, lit: null });
    if (debugSpawnRef.current) clearInterval(debugSpawnRef.current);
    debugSpawnRef.current = setInterval(() => {
      setMinigame((m) => (m && m.type === 'debug' ? { ...m, lit: Math.floor(Math.random() * 9) } : m));
    }, 800);
  }
  function tapDebugTile(idx) {
    setMinigame((m) => {
      if (!m || m.type !== 'debug') return m;
      if (idx === m.lit) return { ...m, score: m.score + 1, lit: null };
      return m;
    });
  }
  function startMatchGame() {
    const deck = [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5];
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = deck[i]; deck[i] = deck[j]; deck[j] = tmp;
    }
    setMinigame({ type: 'match', order: deck, revealed: Array(12).fill(false), matched: Array(12).fill(false), picks: [], timeLeft: 40, pairsFound: 0 });
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
          next = { ...next, matched, picks: [], pairsFound: m.pairsFound + 1 };
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
  function startTimingGame() { setMinigame({ type: 'timing', timeLeft: 12, score: 0, pos: 0, dir: 1 }); }
  function tapTiming() {
    setMinigame((m) => {
      if (!m || m.type !== 'timing') return m;
      const inZone = m.pos >= 35 && m.pos <= 65;
      return inZone ? { ...m, score: m.score + 1 } : m;
    });
  }
  function cancelMinigame() {
    if (minigame && minigame.type === 'debug' && debugSpawnRef.current) { clearInterval(debugSpawnRef.current); debugSpawnRef.current = null; }
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
  const racksOutput = run.tiers.reduce((sum, ts, i) => sum + tierRate(ts.owned, TIER_DEFS[i].baseProd, racksMult, thresholds), 0);
  const gridOutput = run.grid.reduce((sum, g, i) => sum + tierRate(g.owned, GRID_DEFS[i].baseProd, gridMult, thresholds), 0);
  const overclockOutput = run.overclock.reduce((sum, o, i) => sum + tierRate(o.owned, OVERCLOCK_DEFS[i].baseProd, overclockMult, thresholds), 0);
  const totalOutputPerSec = racksOutput + gridOutput + overclockOutput;
  const anyReady = run.tiers.some((ts) => !ts.manager && ts.ready > 0.01);
  const gain = migrateGain(run.lifetimeRun, eff.legacyGainMult);
  const singularityGain = Math.floor(Math.sqrt(meta.legacyCores));

  let unlockedUpTo = 0;
  for (let i = 1; i < TIER_DEFS.length; i++) {
    if (run.tiers[i - 1].owned >= 1) unlockedUpTo = i; else break;
  }
  const LockedIcon = unlockedUpTo + 1 < TIER_DEFS.length ? TIER_DEFS[unlockedUpTo + 1].Icon : null;
  const gridUnlocked = run.tiers[2].owned >= 1;
  const overclockUnlocked = run.tiers[3].owned >= 1;
  const singularityUnlocked = meta.legacyCores >= 50 || meta.stats.singularities > 0 || meta.singularityShards > 0;
  const ventDisabled = Date.now() < ventCooldownRef.current;
  const heatColor = run.heat < 50 ? teal : run.heat < 80 ? amber : danger;

  const ctx = { run, meta, totalOutputPerSec, unlockedUpTo };
  const xpNeeded = xpForLevel(meta.level);
  const completedCount = Object.keys(meta.goalsCompleted).length;

  const claimEvent = () => {
    if (!eventState) return;
    const roll = Math.random();
    if (roll < 0.5) {
      const seconds = 30 + Math.random() * 60;
      const amount = Math.max(totalOutputPerSec * seconds, 20) * eff.eventRewardMult;
      setRun((prev) => ({ ...prev, credits: prev.credits + amount, lifetimeRun: prev.lifetimeRun + amount }));
      setModal({ type: 'eventClaim', text: `+${fmt(amount)} FLOPS collected` });
    } else {
      const mult = [2, 3, 4][Math.floor(Math.random() * 3)];
      const duration = (45 + Math.random() * 30) * eff.eventRewardMult;
      setBoost({ mult, until: Date.now() + duration * 1000 });
      setModal({ type: 'eventClaim', text: `\u00d7${mult} output boost for ${Math.round(duration)}s` });
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
        color: textMain,
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
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold tracking-widest" style={{ color: '#EDEDE3' }}>RACKSTACK</h1>
              <p className="text-xs tracking-wide" style={{ color: textDim }}>spare pi to hyperscale</p>
            </div>
            <div className="flex items-center gap-2">
              {user && (
                <button onClick={logout} className="text-xs font-mono truncate max-w-[90px]" style={{ color: textDim }} title="Log out">
                  {user.username}
                </button>
              )}
              <div className="rounded-lg px-2 py-1 text-xs font-mono" style={{ background: inset, border: `1px solid ${cardBorder}`, color: violet }}>Lv {meta.level}</div>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-lg p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
              <div className="text-xs uppercase tracking-wide" style={{ color: textDim }}>Compute Balance</div>
              <div className="font-mono text-2xl tabular-nums" style={{ color: amber }}>{fmt(run.credits)} <span className="text-sm">F</span></div>
            </div>
            <div className="rounded-lg p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
              <div className="text-xs uppercase tracking-wide" style={{ color: textDim }}>Total Output</div>
              <div className="font-mono text-2xl tabular-nums" style={{ color: teal }}>{fmt(totalOutputPerSec)} <span className="text-sm">F/s</span></div>
            </div>
          </div>

          <div className="mt-2 flex items-center gap-3 text-xs font-mono" style={{ color: textDim }}>
            <span style={{ color: teal }}>\u25c8 {meta.legacyCores} cores</span>
            <span style={{ color: violet }}>\u25c6 {fmt(meta.wafers)} wafers</span>
            <span className="flex-1 h-1 rounded" style={{ background: cardBorder }}>
              <span className="block h-1 rounded" style={{ background: violet, width: `${Math.min(100, (meta.xp / xpNeeded) * 100)}%` }} />
            </span>
            <span>{meta.xp}/{xpNeeded} xp</span>
          </div>

          {boostMultNow > 1 && (
            <div className="mt-2 rounded-lg px-3 py-1.5 text-xs font-mono flex items-center justify-between" style={{ background: 'rgba(232,163,61,0.12)', border: `1px solid ${amber}`, color: amber }}>
              <span>\u26a1 Surge active &times;{boost.mult}</span>
              <span>{Math.max(0, Math.ceil((boost.until - Date.now()) / 1000))}s</span>
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <button
              onClick={() => setModal({ type: 'migrate' })}
              disabled={gain <= 0}
              className="flex-1 rounded-lg py-2 text-sm font-semibold tracking-wide flex items-center justify-center gap-2"
              style={{ background: gain > 0 ? amber : cardBg, color: gain > 0 ? '#0E141B' : textDim, cursor: gain > 0 ? 'pointer' : 'not-allowed' }}
            >
              <RefreshCw size={16} /> Migrate{gain > 0 ? ` (+${gain} cores)` : ''}
            </button>
            {anyReady && (
              <button onClick={collectAll} className="rounded-lg px-4 py-2 text-sm font-semibold" style={{ background: inset, border: `1px solid ${cardBorder}`, color: textMain }}>
                Collect All
              </button>
            )}
          </div>

          <div className="mt-3 flex gap-1 -mx-4 px-4 overflow-x-auto">
            {TABS.map((tab) => {
              const locked = (tab.id === 'grid' && !gridUnlocked) || (tab.id === 'overclock' && !overclockUnlocked) || (tab.id === 'singularity' && !singularityUnlocked);
              const active = activeTab === tab.id;
              const TabIcon = tab.Icon;
              return (
                <button
                  key={tab.id}
                  disabled={locked}
                  onClick={() => setActiveTab(tab.id)}
                  className="flex flex-col items-center gap-0.5 py-2 px-3 rounded-t-lg text-xs whitespace-nowrap"
                  style={{
                    color: locked ? textDim : active ? amber : textDim,
                    borderBottom: active ? `2px solid ${amber}` : '2px solid transparent',
                    opacity: locked ? 0.45 : 1,
                    cursor: locked ? 'not-allowed' : 'pointer',
                  }}
                  title={locked ? 'Keep progressing to unlock' : undefined}
                >
                  <TabIcon size={16} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {activeTab === 'racks' && (
        <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3">
          {TIER_DEFS.slice(0, unlockedUpTo + 1).map((def, i) => {
            const ts = run.tiers[i];
            const rate = tierRate(ts.owned, def.baseProd, racksMult, thresholds);
            const cost1 = costAt(def, ts.owned);
            const cost10 = costForN(def, ts.owned, 10);
            const maxN = maxAffordable(def, ts.owned, run.credits);
            const affordable1 = run.credits >= cost1;
            const Icon = def.Icon;
            const msMult = milestoneMult(ts.owned, thresholds);
            const nextMs = nextMilestone(ts.owned, thresholds);
            const managerCost = def.managerCost * eff.automationDiscount;
            return (
              <div key={def.id} className="tier-card rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}`, animationDelay: `${i * 40}ms` }}>
                <div className="flex items-center gap-3">
                  <div className="rounded-lg p-2" style={{ background: inset }}>
                    <Icon size={22} color={ts.owned > 0 ? amber : textDim} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-sm truncate" style={{ color: textMain }}>{def.name}</div>
                      <div className="font-mono text-xs" style={{ color: textDim }}>&times;{ts.owned}</div>
                    </div>
                    <div className="text-xs font-mono" style={{ color: textDim }}>
                      {fmt(rate)} F/s{ts.manager ? ' \u00b7 automated' : ''}
                      {msMult > 1 && <span style={{ color: teal }}> \u00b7 &times;{msMult} milestone</span>}
                    </div>
                  </div>
                </div>

                {ts.owned > 0 && (
                  <div className="flex items-center gap-1 mt-2">
                    {Array.from({ length: Math.min(ts.owned, 10) }).map((_, k) => (
                      <div key={k} className="led-on" style={{ width: 6, height: 6, borderRadius: 2, background: amber, animationDelay: `${k * 90}ms` }} />
                    ))}
                    {ts.owned > 10 && <span className="text-xs font-mono ml-1" style={{ color: textDim }}>+{ts.owned - 10}</span>}
                  </div>
                )}

                {nextMs && (
                  <div className="mt-1.5">
                    <div className="h-1 rounded" style={{ background: cardBorder }}>
                      <div className="h-1 rounded" style={{ background: teal, width: `${Math.min(100, (ts.owned / nextMs) * 100)}%` }} />
                    </div>
                    <div className="text-xs font-mono mt-0.5" style={{ color: textDim }}>{ts.owned}/{nextMs} to next &times;2</div>
                  </div>
                )}

                <div className="flex items-center gap-2 mt-3">
                  {!ts.manager && ts.ready > 0.01 && (
                    <button onClick={() => collectTier(i)} className="collect-pop rounded-lg px-3 py-2 text-xs font-semibold flex-1" style={{ background: teal, color: '#0E141B' }}>
                      Collect {fmt(ts.ready)}
                    </button>
                  )}
                  {!ts.manager && ts.owned >= 1 && (
                    <button onClick={() => hireManager(i)} disabled={run.credits < managerCost} className="rounded-lg px-3 py-2 text-xs font-semibold" style={buyBtnStyle(run.credits >= managerCost)}>
                      Automate ({fmt(managerCost)})
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2 mt-2">
                  <button onClick={() => buy(i, 1)} disabled={!affordable1} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(affordable1)}>
                    +1 &middot; {fmt(cost1)}
                  </button>
                  <button onClick={() => buy(i, 10)} disabled={run.credits < cost10} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(run.credits >= cost10)}>
                    +10 &middot; {fmt(cost10)}
                  </button>
                  <button onClick={() => buy(i, 'max')} disabled={maxN < 1} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(maxN >= 1)}>
                    Max{maxN >= 1 ? ` +${maxN}` : ''}
                  </button>
                </div>
              </div>
            );
          })}

          {LockedIcon && (
            <div className="rounded-xl p-3 flex items-center gap-3" style={{ background: 'rgba(22,31,43,0.5)', border: `1px dashed ${cardBorder}` }}>
              <div className="rounded-lg p-2" style={{ background: inset, opacity: 0.5 }}>
                <LockedIcon size={22} color={textDim} />
              </div>
              <div>
                <div className="font-semibold text-sm" style={{ color: textDim }}>{TIER_DEFS[unlockedUpTo + 1].name}</div>
                <div className="text-xs" style={{ color: textDim }}>Own 1 {TIER_DEFS[unlockedUpTo].name} to unlock</div>
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'grid' && (
        <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3">
          <div className="rounded-lg p-3 text-xs" style={{ background: cardBg, border: `1px solid ${cardBorder}`, color: textDim }}>
            The Grid runs on its own &mdash; no automation needed. Volunteers contribute FLOPS straight to your total, all the time.
          </div>
          {GRID_DEFS.map((def, i) => {
            const g = run.grid[i];
            const rate = tierRate(g.owned, def.baseProd, gridMult, thresholds);
            const cost1 = costAt(def, g.owned);
            const cost10 = costForN(def, g.owned, 10);
            const maxN = maxAffordable(def, g.owned, run.credits);
            const affordable1 = run.credits >= cost1;
            const Icon = def.Icon;
            const msMult = milestoneMult(g.owned, thresholds);
            const nextMs = nextMilestone(g.owned, thresholds);
            return (
              <div key={def.id} className="tier-card rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}`, animationDelay: `${i * 40}ms` }}>
                <div className="flex items-center gap-3">
                  <div className="rounded-lg p-2" style={{ background: inset }}>
                    <Icon size={22} color={g.owned > 0 ? teal : textDim} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-sm truncate" style={{ color: textMain }}>{def.name}</div>
                      <div className="font-mono text-xs" style={{ color: textDim }}>&times;{g.owned}</div>
                    </div>
                    <div className="text-xs font-mono" style={{ color: textDim }}>
                      {fmt(rate)} F/s
                      {msMult > 1 && <span style={{ color: teal }}> \u00b7 &times;{msMult} milestone</span>}
                    </div>
                  </div>
                </div>
                {nextMs && (
                  <div className="mt-1.5">
                    <div className="h-1 rounded" style={{ background: cardBorder }}>
                      <div className="h-1 rounded" style={{ background: teal, width: `${Math.min(100, (g.owned / nextMs) * 100)}%` }} />
                    </div>
                    <div className="text-xs font-mono mt-0.5" style={{ color: textDim }}>{g.owned}/{nextMs} to next &times;2</div>
                  </div>
                )}
                <div className="grid grid-cols-3 gap-2 mt-3">
                  <button onClick={() => buyGrid(i, 1)} disabled={!affordable1} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(affordable1)}>
                    +1 &middot; {fmt(cost1)}
                  </button>
                  <button onClick={() => buyGrid(i, 10)} disabled={run.credits < cost10} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(run.credits >= cost10)}>
                    +10 &middot; {fmt(cost10)}
                  </button>
                  <button onClick={() => buyGrid(i, 'max')} disabled={maxN < 1} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(maxN >= 1)}>
                    Max{maxN >= 1 ? ` +${maxN}` : ''}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'overclock' && (
        <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3">
          <div className="rounded-xl p-4" style={{ background: cardBg, border: `1px solid ${heatColor}` }}>
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: textMain }}><Flame size={16} color={heatColor} /> Heat</div>
              <div className="font-mono text-sm" style={{ color: heatColor }}>{Math.round(run.heat)}%</div>
            </div>
            <div className="h-2 rounded" style={{ background: cardBorder }}>
              <div className="h-2 rounded" style={{ background: heatColor, width: `${run.heat}%` }} />
            </div>
            {run.heat > 80 && <div className="text-xs mt-1" style={{ color: danger }}>\u26a0 Meltdown risk &mdash; vent now, or you'll lose half your Overclock nodes</div>}
            <button onClick={ventHeat} disabled={ventDisabled} className="mt-3 w-full rounded-lg py-2 text-sm font-semibold flex items-center justify-center gap-2" style={{ background: ventDisabled ? cardBg : teal, color: ventDisabled ? textDim : '#0E141B', border: `1px solid ${cardBorder}`, cursor: ventDisabled ? 'not-allowed' : 'pointer' }}>
              <Snowflake size={16} /> Vent Heat
            </button>
          </div>
          <div className="rounded-lg p-3 text-xs" style={{ background: cardBg, border: `1px solid ${cardBorder}`, color: textDim }}>
            Overclock nodes run on their own like the Grid, but generate heat. Let it hit 100% and half your nodes melt down. Keep venting.
          </div>
          {OVERCLOCK_DEFS.map((def, i) => {
            const o = run.overclock[i];
            const rate = tierRate(o.owned, def.baseProd, overclockMult, thresholds);
            const cost1 = costAt(def, o.owned);
            const cost10 = costForN(def, o.owned, 10);
            const maxN = maxAffordable(def, o.owned, run.credits);
            const affordable1 = run.credits >= cost1;
            const Icon = def.Icon;
            const msMult = milestoneMult(o.owned, thresholds);
            const nextMs = nextMilestone(o.owned, thresholds);
            return (
              <div key={def.id} className="tier-card rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}`, animationDelay: `${i * 40}ms` }}>
                <div className="flex items-center gap-3">
                  <div className="rounded-lg p-2" style={{ background: inset }}>
                    <Icon size={22} color={o.owned > 0 ? danger : textDim} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <div className="font-semibold text-sm truncate" style={{ color: textMain }}>{def.name}</div>
                      <div className="font-mono text-xs" style={{ color: textDim }}>&times;{o.owned}</div>
                    </div>
                    <div className="text-xs font-mono" style={{ color: textDim }}>
                      {fmt(rate)} F/s &middot; {def.heatPerSec.toFixed(2)} heat/s each
                      {msMult > 1 && <span style={{ color: teal }}> \u00b7 &times;{msMult} milestone</span>}
                    </div>
                  </div>
                </div>
                {nextMs && (
                  <div className="mt-1.5">
                    <div className="h-1 rounded" style={{ background: cardBorder }}>
                      <div className="h-1 rounded" style={{ background: teal, width: `${Math.min(100, (o.owned / nextMs) * 100)}%` }} />
                    </div>
                    <div className="text-xs font-mono mt-0.5" style={{ color: textDim }}>{o.owned}/{nextMs} to next &times;2</div>
                  </div>
                )}
                <div className="grid grid-cols-3 gap-2 mt-3">
                  <button onClick={() => buyOverclock(i, 1)} disabled={!affordable1} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(affordable1)}>
                    +1 &middot; {fmt(cost1)}
                  </button>
                  <button onClick={() => buyOverclock(i, 10)} disabled={run.credits < cost10} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(run.credits >= cost10)}>
                    +10 &middot; {fmt(cost10)}
                  </button>
                  <button onClick={() => buyOverclock(i, 'max')} disabled={maxN < 1} className="rounded-lg py-2 text-xs font-mono" style={buyBtnStyle(maxN >= 1)}>
                    Max{maxN >= 1 ? ` +${maxN}` : ''}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'upgrades' && (
        <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3">
          <div className="rounded-lg p-3 text-xs" style={{ background: cardBg, border: `1px solid ${cardBorder}`, color: textDim }}>
            Bought with Silicon Wafers, earned from Goals and minigames. These upgrades survive Migrate.
          </div>
          {UPGRADE_DEFS.map((u) => {
            const level = meta.upgrades[u.id] || 0;
            const maxed = level >= u.maxLevel;
            const cost = Math.ceil(u.baseCost * Math.pow(u.costMult, level));
            const afford = meta.wafers >= cost;
            return (
              <div key={u.id} className="rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm" style={{ color: textMain }}>{u.name}</div>
                  <div className="font-mono text-xs" style={{ color: violet }}>Lv {level}/{u.maxLevel}</div>
                </div>
                <div className="text-xs mt-0.5" style={{ color: textDim }}>{u.desc}</div>
                <button
                  onClick={() => buyUpgrade(u)}
                  disabled={maxed || !afford}
                  className="mt-2 w-full rounded-lg py-2 text-xs font-mono flex items-center justify-center gap-1"
                  style={buyBtnStyle(!maxed && afford)}
                >
                  {maxed ? 'MAXED' : (<><Gem size={12} /> {fmt(cost)} wafers</>)}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'singularity' && (
        <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3">
          <div className="rounded-xl p-4" style={{ background: cardBg, border: `1px solid ${violet}` }}>
            <div className="flex items-center gap-2 mb-1">
              <Sparkles size={16} color={violet} />
              <div className="font-semibold text-sm" style={{ color: violet }}>Trigger a Singularity</div>
            </div>
            <div className="text-xs mb-3" style={{ color: textDim }}>
              Converts all {meta.legacyCores} Legacy Cores into Singularity Shards, spent below on permanent perks. Wipes your current run AND your Legacy Cores. Wafers, Upgrades, Level, and Goals are untouched.
            </div>
            <div className="font-mono text-lg mb-3" style={{ color: violet }}>+{singularityGain} Shards</div>
            <button onClick={() => setModal({ type: 'singularity' })} disabled={singularityGain <= 0} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: singularityGain > 0 ? violet : cardBg, color: singularityGain > 0 ? '#0E141B' : textDim, cursor: singularityGain > 0 ? 'pointer' : 'not-allowed' }}>
              Trigger Singularity
            </button>
          </div>
          <div className="font-mono text-sm" style={{ color: violet }}>\u25c6 {meta.singularityShards} Shards available</div>
          {SINGULARITY_DEFS.map((u) => {
            const level = meta.shardUpgrades[u.id] || 0;
            const maxed = level >= u.maxLevel;
            const cost = Math.ceil(u.baseCost * Math.pow(u.costMult, level));
            const afford = meta.singularityShards >= cost;
            return (
              <div key={u.id} className="rounded-xl p-3" style={{ background: cardBg, border: `1px solid ${violet}` }}>
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-sm" style={{ color: textMain }}>{u.name}</div>
                  <div className="font-mono text-xs" style={{ color: violet }}>Lv {level}/{u.maxLevel}</div>
                </div>
                <div className="text-xs mt-0.5" style={{ color: textDim }}>{u.desc}</div>
                <button
                  onClick={() => buyShardUpgrade(u)}
                  disabled={maxed || !afford}
                  className="mt-2 w-full rounded-lg py-2 text-xs font-mono flex items-center justify-center gap-1"
                  style={{ background: !maxed && afford ? violet : cardBg, color: !maxed && afford ? '#0E141B' : textDim, opacity: !maxed && afford ? 1 : 0.55, cursor: !maxed && afford ? 'pointer' : 'not-allowed' }}
                >
                  {maxed ? 'MAXED' : `${cost} shards`}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'goals' && (
        <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-2">
          <div className="flex items-center justify-between text-xs font-mono mb-1" style={{ color: textDim }}>
            <span>{completedCount}/{GOAL_DEFS.length} completed</span>
            <button onClick={() => setShowCompleted((s) => !s)} style={{ color: violet }}>{showCompleted ? 'Hide completed' : 'Show completed'}</button>
          </div>
          {GOAL_DEFS.filter((g) => showCompleted || !meta.goalsCompleted[g.id]).map((g) => {
            const done = !!meta.goalsCompleted[g.id];
            const [cur, target] = g.progress(ctx);
            const met = cur >= target;
            return (
              <div key={g.id} className="rounded-xl p-3 flex items-center gap-3" style={{ background: cardBg, border: `1px solid ${done ? teal : cardBorder}`, opacity: done ? 0.6 : 1 }}>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold" style={{ color: textMain }}>{done && '\u2713 '}{g.desc}</div>
                  <div className="text-xs font-mono mt-0.5" style={{ color: textDim }}>
                    {done ? 'Completed' : `${fmt(cur)}/${fmt(target)}`} &middot; +{g.xp} xp &middot; +{g.wafers} wafers
                  </div>
                </div>
                {!done && met && (
                  <button onClick={() => claimGoal(g)} className="rounded-lg px-3 py-2 text-xs font-semibold" style={{ background: amber, color: '#0E141B' }}>Claim</button>
                )}
              </div>
            );
          })}

          <div className="mt-4 mb-1 text-xs font-mono uppercase tracking-wide" style={{ color: violet }}>Ongoing &mdash; always another one</div>
          {REPEATABLE_DEFS.map((def) => {
            const level = meta.repeatable[def.id] || 0;
            const target = def.target(level);
            const cur = def.metric(ctx);
            const met = cur >= target;
            return (
              <div key={def.id} className="rounded-xl p-3 flex items-center gap-3" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold" style={{ color: textMain }}>{def.desc(target)}</div>
                  <div className="text-xs font-mono mt-0.5" style={{ color: textDim }}>
                    {fmt(cur)}/{fmt(target)} &middot; +{def.xp(level)} xp &middot; +{def.wafers(level)} wafers &middot; tier {level + 1}
                  </div>
                </div>
                {met && (
                  <button onClick={() => claimRepeatable(def, ctx)} className="rounded-lg px-3 py-2 text-xs font-semibold" style={{ background: violet, color: '#0E141B' }}>Claim</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'games' && !minigame && (
        <div className="max-w-2xl mx-auto px-4 py-4 flex flex-col gap-3">
          <div className="rounded-xl p-4" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
            <div className="flex items-center gap-2 mb-1">
              <Zap size={18} color={amber} />
              <div className="font-semibold text-sm" style={{ color: textMain }}>Overclock Rush</div>
            </div>
            <div className="text-xs mb-3" style={{ color: textDim }}>Tap as fast as you can for 10 seconds.</div>
            <button onClick={startRushGame} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: amber, color: '#0E141B' }}>Play</button>
          </div>
          <div className="rounded-xl p-4" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
            <div className="flex items-center gap-2 mb-1">
              <Bug size={18} color={teal} />
              <div className="font-semibold text-sm" style={{ color: textMain }}>Debug Sprint</div>
            </div>
            <div className="text-xs mb-3" style={{ color: textDim }}>Squash the highlighted bug before it hides. 15 seconds.</div>
            <button onClick={startDebugGame} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: teal, color: '#0E141B' }}>Play</button>
          </div>
          <div className="rounded-xl p-4" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
            <div className="flex items-center gap-2 mb-1">
              <Cable size={18} color={violet} />
              <div className="font-semibold text-sm" style={{ color: textMain }}>Cable Match</div>
            </div>
            <div className="text-xs mb-3" style={{ color: textDim }}>Find all 6 matching pairs before time runs out. 40 seconds.</div>
            <button onClick={startMatchGame} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: violet, color: '#0E141B' }}>Play</button>
          </div>
          <div className="rounded-xl p-4" style={{ background: cardBg, border: `1px solid ${cardBorder}` }}>
            <div className="flex items-center gap-2 mb-1">
              <Flame size={18} color={danger} />
              <div className="font-semibold text-sm" style={{ color: textMain }}>Overclock Balance</div>
            </div>
            <div className="text-xs mb-3" style={{ color: textDim }}>Tap STABILIZE while the needle is in the safe zone. 12 seconds.</div>
            <button onClick={startTimingGame} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: danger, color: textMain }}>Play</button>
          </div>
        </div>
      )}

      {minigame && minigame.type === 'rush' && (
        <div className="fixed inset-0 z-30 flex items-center justify-center p-4" style={{ background: 'rgba(10,14,19,0.96)' }}>
          <div className="w-full max-w-sm text-center">
            <button onClick={cancelMinigame} className="absolute top-4 right-4" style={{ color: textDim }}><X size={22} /></button>
            <div className="font-mono text-sm mb-2" style={{ color: textDim }}>{minigame.timeLeft}s left</div>
            <div className="font-mono text-3xl mb-6" style={{ color: amber }}>{minigame.taps} taps</div>
            <button onClick={tapRush} className="w-full rounded-2xl py-16 text-xl font-bold" style={{ background: amber, color: '#0E141B' }}>TAP</button>
          </div>
        </div>
      )}

      {minigame && minigame.type === 'debug' && (
        <div className="fixed inset-0 z-30 flex items-center justify-center p-4" style={{ background: 'rgba(10,14,19,0.96)' }}>
          <div className="w-full max-w-sm text-center">
            <button onClick={cancelMinigame} className="absolute top-4 right-4" style={{ color: textDim }}><X size={22} /></button>
            <div className="flex justify-between font-mono text-sm mb-4" style={{ color: textDim }}>
              <span>{minigame.timeLeft}s left</span>
              <span style={{ color: teal }}>{minigame.score} squashed</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {Array.from({ length: 9 }).map((_, idx) => (
                <button
                  key={idx}
                  onClick={() => tapDebugTile(idx)}
                  className="aspect-square rounded-xl flex items-center justify-center"
                  style={{ background: minigame.lit === idx ? teal : inset, border: `1px solid ${cardBorder}` }}
                >
                  {minigame.lit === idx && <Bug size={26} color="#0E141B" />}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {minigame && minigame.type === 'match' && (
        <div className="fixed inset-0 z-30 flex items-center justify-center p-4" style={{ background: 'rgba(10,14,19,0.96)' }}>
          <div className="w-full max-w-sm text-center">
            <button onClick={cancelMinigame} className="absolute top-4 right-4" style={{ color: textDim }}><X size={22} /></button>
            <div className="flex justify-between font-mono text-sm mb-4" style={{ color: textDim }}>
              <span>{minigame.timeLeft}s left</span>
              <span style={{ color: violet }}>{minigame.pairsFound}/6 pairs</span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {minigame.order.map((iconIdx, idx) => {
                const shown = minigame.revealed[idx] || minigame.matched[idx];
                const TileIcon = MATCH_ICONS[iconIdx];
                return (
                  <button
                    key={idx}
                    onClick={() => tapMatchTile(idx)}
                    className="aspect-square rounded-xl flex items-center justify-center"
                    style={{ background: minigame.matched[idx] ? teal : shown ? violet : inset, border: `1px solid ${cardBorder}` }}
                  >
                    {shown && <TileIcon size={22} color="#0E141B" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {minigame && minigame.type === 'timing' && (
        <div className="fixed inset-0 z-30 flex items-center justify-center p-4" style={{ background: 'rgba(10,14,19,0.96)' }}>
          <div className="w-full max-w-sm text-center">
            <button onClick={cancelMinigame} className="absolute top-4 right-4" style={{ color: textDim }}><X size={22} /></button>
            <div className="flex justify-between font-mono text-sm mb-6" style={{ color: textDim }}>
              <span>{minigame.timeLeft}s left</span>
              <span style={{ color: danger }}>{minigame.score} stabilized</span>
            </div>
            <div className="relative h-8 rounded-full mb-8" style={{ background: inset, border: `1px solid ${cardBorder}` }}>
              <div className="absolute top-0 bottom-0" style={{ left: '35%', width: '30%', background: 'rgba(79,195,176,0.25)', borderLeft: `1px solid ${teal}`, borderRight: `1px solid ${teal}` }} />
              <div className="absolute top-0 bottom-0 w-1.5 rounded" style={{ left: `calc(${minigame.pos}% - 3px)`, background: danger }} />
            </div>
            <button onClick={tapTiming} className="w-full rounded-2xl py-10 text-lg font-bold" style={{ background: danger, color: textMain }}>STABILIZE</button>
          </div>
        </div>
      )}

      <div className="max-w-2xl mx-auto px-4 pb-8 flex justify-center">
        <button onClick={() => setModal({ type: 'reset' })} className="text-xs flex items-center gap-1" style={{ color: textDim }}>
          <RotateCcw size={12} /> Reset progress
        </button>
      </div>

      {eventState && (
        <div className="fixed left-4 right-4 bottom-4 z-20 max-w-sm mx-auto">
          <button onClick={claimEvent} className="w-full rounded-xl p-3 text-left flex items-center gap-3" style={{ background: inset, border: `1px solid ${amber}`, boxShadow: '0 8px 24px rgba(0,0,0,0.45)' }}>
            <Zap size={20} color={amber} className="event-icon" />
            <div className="flex-1">
              <div className="text-sm font-semibold" style={{ color: textMain }}>{eventState.label}</div>
              <div className="text-xs" style={{ color: textDim }}>tap to investigate</div>
              <div className="h-1 rounded mt-1" style={{ background: cardBorder }}>
                <div className="h-1 rounded" style={{ background: amber, width: `${Math.max(0, ((eventState.expiresAt - Date.now()) / EVENT_WINDOW) * 100)}%` }} />
              </div>
            </div>
          </button>
        </div>
      )}

      {modal && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)' }}
          onClick={() => { if (!['migrate', 'reset', 'singularity'].includes(modal.type)) setModal(null); }}
        >
          <div className="rounded-xl p-5 max-w-sm w-full" style={{ background: cardBg, border: `1px solid ${cardBorder}` }} onClick={(e) => e.stopPropagation()}>
            {modal.type === 'welcome' && (
              <>
                <h2 className="text-lg font-bold mb-2">Welcome back</h2>
                <p className="text-sm mb-4" style={{ color: textDim }}>Your automated racks, Grid, and Overclock Bay kept humming while you were away.</p>
                <div className="font-mono text-2xl mb-4" style={{ color: amber }}>+{fmt(modal.amount)} FLOPS</div>
                <button onClick={() => setModal(null)} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: amber, color: '#0E141B' }}>Nice</button>
              </>
            )}
            {(modal.type === 'eventClaim' || modal.type === 'minigameResult') && (
              <>
                <h2 className="text-lg font-bold mb-2">Resolved</h2>
                <p className="text-sm mb-4" style={{ color: textDim }}>{modal.text}</p>
                <button onClick={() => setModal(null)} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: amber, color: '#0E141B' }}>Nice</button>
              </>
            )}
            {modal.type === 'goalClaim' && (
              <>
                <h2 className="text-lg font-bold mb-2">Goal complete</h2>
                <p className="text-sm mb-4" style={{ color: textDim }}>+{modal.goal.xp} xp &middot; +{modal.goal.wafers} wafers</p>
                <button onClick={() => setModal(null)} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: amber, color: '#0E141B' }}>Nice</button>
              </>
            )}
            {modal.type === 'levelUp' && (
              <>
                <h2 className="text-lg font-bold mb-2" style={{ color: violet }}>Level Up! &rarr; Lv {modal.level}</h2>
                <p className="text-sm mb-4" style={{ color: textDim }}>+{modal.goal.xp} xp &middot; +{modal.goal.wafers} wafers. Every level adds a small permanent output bonus.</p>
                <button onClick={() => setModal(null)} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: violet, color: '#0E141B' }}>Nice</button>
              </>
            )}
            {modal.type === 'meltdown' && (
              <>
                <h2 className="text-lg font-bold mb-2" style={{ color: danger }}>\u26a0 Thermal Meltdown!</h2>
                <p className="text-sm mb-4" style={{ color: textDim }}>Your Overclock Bay overheated and half your nodes were lost. Keep an eye on the heat gauge and vent regularly, or invest in Thermal Regulators / Auto-Vent upgrades.</p>
                <button onClick={() => setModal(null)} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: danger, color: textMain }}>Understood</button>
              </>
            )}
            {modal.type === 'singularity' && (
              <>
                <h2 className="text-lg font-bold mb-2" style={{ color: violet }}>Trigger Singularity?</h2>
                <p className="text-sm mb-4" style={{ color: textDim }}>Converts {meta.legacyCores} Legacy Cores into +{singularityGain} Singularity Shards. Your run AND Legacy Cores reset to zero.</p>
                <div className="flex gap-2">
                  <button onClick={() => setModal(null)} className="flex-1 rounded-lg py-2 text-sm" style={{ background: inset, color: textMain, border: `1px solid ${cardBorder}` }}>Cancel</button>
                  <button onClick={doSingularity} className="flex-1 rounded-lg py-2 text-sm font-semibold" style={{ background: violet, color: '#0E141B' }}>Trigger</button>
                </div>
              </>
            )}
            {modal.type === 'singularityDone' && (
              <>
                <h2 className="text-lg font-bold mb-2" style={{ color: violet }}>Singularity achieved</h2>
                <p className="text-sm mb-4" style={{ color: textDim }}>+{modal.shards} Singularity Shards. Spend them in the Singularity tab for permanent perks.</p>
                <button onClick={() => setModal(null)} className="w-full rounded-lg py-2 text-sm font-semibold" style={{ background: violet, color: '#0E141B' }}>Nice</button>
              </>
            )}
            {modal.type === 'migrate' && (
              <>
                <h2 className="text-lg font-bold mb-2">Migrate to a new facility?</h2>
                <p className="text-sm mb-4" style={{ color: textDim }}>Wipes your current Racks, Grid, Overclock Bay, and balance, converts everything you've produced into Legacy Cores &mdash; a permanent +5% output boost each, forever. Wafers, Upgrades, Level, and Goals are unaffected.</p>
                <div className="font-mono text-xl mb-4" style={{ color: teal }}>+{gain} Legacy Cores</div>
                <div className="flex gap-2">
                  <button onClick={() => setModal(null)} className="flex-1 rounded-lg py-2 text-sm" style={{ background: inset, color: textMain, border: `1px solid ${cardBorder}` }}>Cancel</button>
                  <button onClick={doMigrate} className="flex-1 rounded-lg py-2 text-sm font-semibold" style={{ background: amber, color: '#0E141B' }}>Migrate</button>
                </div>
              </>
            )}
            {modal.type === 'reset' && (
              <>
                <h2 className="text-lg font-bold mb-2">Reset everything?</h2>
                <p className="text-sm mb-4" style={{ color: textDim }}>Permanently deletes your save, including Legacy Cores, Shards, Wafers, Upgrades, Level, and Goals. No undo.</p>
                <div className="flex gap-2">
                  <button onClick={() => setModal(null)} className="flex-1 rounded-lg py-2 text-sm" style={{ background: inset, color: textMain, border: `1px solid ${cardBorder}` }}>Cancel</button>
                  <button onClick={hardReset} className="flex-1 rounded-lg py-2 text-sm font-semibold" style={{ background: danger, color: textMain }}>Delete save</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
