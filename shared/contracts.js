// Daily contracts board (v1.5, spec §6.1 + design §4.2).
//
// Three contracts a day, rotating at midnight UTC, generated
// DETERMINISTICALLY from the date: every player gets the same three contract
// TYPES on the same day, while the numeric targets scale to each player's own
// progress. That determinism is why the type ids aren't stored in the save -
// they're re-derived from `meta.contracts.dateKey`, so the client and the
// server can never disagree about what today's contracts are.

import { utcDateKey } from './daily.js';
import { goalCtx } from './goals.js';

// Every metric here is a MONOTONIC lifetime counter on meta.stats, so a delta
// against a snapshotted baseline is always well-defined and can never go
// backwards. `coldStorage.tapes` (a spendable balance) is deliberately NOT
// usable for this reason - `tapesEarnedLifetime` is its monotonic twin.
//
// `lane` gates availability: the three 'cold' defs are impossible for a player
// who hasn't unlocked Cold Storage (rack tier 5), so dailyContractTypes
// substitutes base-lane defs for them rather than handing such a player two
// dead contracts. There must always be at least three base-lane defs for that
// substitution to have enough to draw from - tests/contracts.test.js asserts
// exactly this.
export const CONTRACT_DEFS = [
  {
    id: 'c_flops', metric: 'lifetimeFlopsAllTime', lane: 'base',
    desc: (target, fmt) => `Earn ${fmt(target)} FLOPS`,
    target: (ctx, config) => Math.max(
      ctx.totalOutputPerSec * config.social.contractFlopsSeconds,
      config.social.contractFlopsMin,
    ),
  },
  {
    id: 'c_minigames', metric: 'minigamesWon', lane: 'base',
    desc: (target) => `Win ${target} minigame${target === 1 ? '' : 's'}`,
    target: (ctx, config) => config.social.contractMinigamesTarget,
  },
  {
    id: 'c_wafers', metric: 'totalWafersEarned', lane: 'base',
    desc: (target, fmt) => `Earn ${fmt(target)} Wafers`,
    target: (ctx, config) => Math.round(
      config.social.contractWafersBase
      * Math.pow(config.social.contractWafersGrowth, ctx.meta.level || 0),
    ),
  },
  {
    id: 'c_blocks', metric: 'blocksClaimedLifetime', lane: 'cold',
    desc: (target) => `Claim ${target} Cold Storage block${target === 1 ? '' : 's'}`,
    target: (ctx, config) => config.social.contractBlocksTarget,
  },
  {
    id: 'c_tapes', metric: 'tapesEarnedLifetime', lane: 'cold',
    desc: (target, fmt) => `Earn ${fmt(target)} Tapes`,
    target: (ctx, config) => Math.round(
      config.social.contractTapesBase
      + config.social.contractTapesPerLevel * (ctx.meta.level || 0),
    ),
  },
  {
    id: 'c_jobs', metric: 'jobsCompletedLifetime', lane: 'cold',
    desc: () => 'Complete a Cold Storage job',
    target: () => 1,
  },
];

/** `.find()` lookup - `id` may come from a save or a payload, so it is never used as a bare key. */
export function contractDef(id) {
  if (typeof id !== 'string' || id === '') return null;
  return CONTRACT_DEFS.find((d) => d.id === id) || null;
}

// FNV-1a over the date key, then mulberry32. Both are tiny, well-known and
// stable across engines - the requirement is only that every player's client
// and the server derive the SAME shuffle from the same date, not that the bits
// are cryptographically good.
function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The day's three contract type ids, a pure function of (dateKey,
 * coldUnlocked). Fisher-Yates over CONTRACT_DEFS seeded by the date, take
 * three. When Cold Storage is locked, each 'cold' pick is replaced by the next
 * unused 'base' id from the SAME shuffled order - so two locked players still
 * match each other exactly, and the result is stable across calls. Returns []
 * for a malformed key rather than throwing.
 */
export function dailyContractTypes(dateKey, coldUnlocked) {
  if (typeof dateKey !== 'string' || !DATE_KEY_RE.test(dateKey)) return [];

  const rng = mulberry32(hashSeed(dateKey));
  const order = CONTRACT_DEFS.map((d) => d.id);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const picked = [];
  const used = new Set();
  const takeBase = () => order.find((id) => !used.has(id) && contractDef(id).lane === 'base');

  for (const id of order) {
    if (picked.length === 3) break;
    if (used.has(id)) continue;
    let chosen = id;
    if (!coldUnlocked && contractDef(id).lane === 'cold') {
      chosen = takeBase();
      if (!chosen) continue; // no base def left to substitute; skip this pick
    }
    used.add(chosen);
    picked.push(chosen);
  }
  return picked;
}

export function contractProgress(def, meta, baseline, target) {
  const stats = (meta && meta.stats) || {};
  const raw = Object.prototype.hasOwnProperty.call(stats, def.metric) ? stats[def.metric] : 0;
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
  const base = typeof baseline === 'number' && Number.isFinite(baseline) ? baseline : 0;
  const current = Math.max(0, value - base);
  return { current, target, met: current >= target };
}

/** Cold Storage unlocks with the Server Room (rack tier index 4) - the same gate RackStack.jsx uses. */
function isColdUnlocked(state) {
  const t = state.run && state.run.tiers && state.run.tiers[4];
  return !!(t && t.owned >= 1);
}

/**
 * Rolls the board over to `now`'s UTC day if it isn't already there.
 * Idempotent - returns false and touches nothing when the stored dateKey is
 * already today's. Snapshots BOTH the targets and the per-metric baselines
 * (see design §4.2.1: a rate-scaled target recomputed on every read would
 * recede as fast as the player approached it).
 *
 * Mutates `state` in place, matching the scheduleAnomaly/joinEventIfEligible
 * convention on the server's load path.
 */
export function rolloverContracts(state, config, now) {
  const today = utcDateKey(now);
  if (today === null) return false;
  if (state.meta.contracts && state.meta.contracts.dateKey === today) return false;

  const ctx = goalCtx(state, config, now);
  const types = dailyContractTypes(today, isColdUnlocked(state));
  const baseline = {};
  const targets = [];
  for (const id of types) {
    const def = contractDef(id);
    const raw = state.meta.stats[def.metric];
    baseline[def.metric] = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    targets.push(def.target(ctx, config));
  }

  state.meta.contracts = {
    dateKey: today,
    targets,
    baseline,
    claimed: [false, false, false],
  };
  return true;
}

/**
 * The three resolved contracts for the CURRENTLY STORED dateKey - the single
 * place both the reducer and the client turn `meta.contracts` into something
 * with defs attached, so the two can't disagree. Returns [] before the first
 * rollover.
 *
 * `coldUnlocked` is re-derived from the stored BASELINE's metrics rather than
 * from live run state, so the day's snapshot stays stable even if the player
 * unlocks Cold Storage mid-day. (A board that drew three base-lane types
 * anyway resolves identically either way, since substitution is a no-op when
 * there's nothing cold to substitute.)
 */
export function contractsForState(meta) {
  const c = meta && meta.contracts;
  if (!c || typeof c.dateKey !== 'string') return [];
  const baseline = c.baseline || {};
  const hadCold = CONTRACT_DEFS.some(
    (d) => d.lane === 'cold' && Object.prototype.hasOwnProperty.call(baseline, d.metric),
  );
  const types = dailyContractTypes(c.dateKey, hadCold);
  return types.map((id, index) => ({
    def: contractDef(id),
    target: c.targets[index],
    claimed: c.claimed[index] === true,
    index,
  }));
}
