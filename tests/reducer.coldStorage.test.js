import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { initialState } from '../shared/state.js';
import { applyAction } from '../shared/reducer.js';
import { TOTAL_BLOCKS } from '../shared/coldStorageData.js';

const NOW = 1_000_000;
const SIX_HOURS = 6 * 3600 * 1000;

function stateWithTrackStarted(hoursAgo) {
  const s = initialState();
  s.meta.coldStorage.trackStartedAt = NOW - hoursAgo * 3600 * 1000;
  return s;
}

describe('coldStorage actions', () => {
  it('claimBlock rejects a block that has not arrived yet', () => {
    const s = stateWithTrackStarted(0); // track just started, block 0 needs 6h
    const { result } = applyAction(s, { type: 'claimBlock', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'not_met' });
  });
  it('claimBlock pays out once a block has arrived, rejects re-claim', () => {
    const s = stateWithTrackStarted(6.5); // block 0 arrived ~30min ago
    const a = applyAction(s, { type: 'claimBlock', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(a.result.ok).toBe(true);
    expect(a.result.tapes).toBe(5);
    expect(a.state.meta.coldStorage.blocksClaimed[0]).toBe(true);
    expect(a.state.meta.stats.blocksClaimedLifetime).toBe(1);
    const b = applyAction(a.state, { type: 'claimBlock', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(b.result).toEqual({ ok: false, error: 'invalid_target' });
  });
  it('claimBlock rejects out-of-range index', () => {
    const s = stateWithTrackStarted(100);
    expect(applyAction(s, { type: 'claimBlock', index: 16 }, DEFAULT_CONFIG, NOW).result.error).toBe('invalid_target');
    expect(applyAction(s, { type: 'claimBlock', index: -1 }, DEFAULT_CONFIG, NOW).result.error).toBe('invalid_target');
    expect(applyAction(s, { type: 'claimBlock', index: 'push' }, DEFAULT_CONFIG, NOW).result.error).toBe('invalid_target');
  });
  it('claimAllBlocks claims every arrived-but-unclaimed block in one action', () => {
    const s = stateWithTrackStarted(20); // floor(20/6) = 3 blocks arrived (indices 0,1,2)
    const { state, result } = applyAction(s, { type: 'claimAllBlocks' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(result.claimedCount).toBe(3);
    expect(state.meta.coldStorage.blocksClaimed.slice(0, 3)).toEqual([true, true, true]);
    expect(state.meta.coldStorage.blocksClaimed[3]).toBe(false);
  });
  it('claimAllBlocks rejects when nothing is claimable', () => {
    const s = stateWithTrackStarted(0);
    expect(applyAction(s, { type: 'claimAllBlocks' }, DEFAULT_CONFIG, NOW).result.error).toBe('invalid_target');
  });
  it('resetTrack rejects until all 16 blocks are claimed', () => {
    const s = stateWithTrackStarted(20);
    expect(applyAction(s, { type: 'resetTrack' }, DEFAULT_CONFIG, NOW).result.error).toBe('not_met');
  });
  it('resetTrack starts a new cycle once all 16 are claimed', () => {
    const s = stateWithTrackStarted(200); // way more than 96h - all 16 arrived
    s.meta.coldStorage.blocksClaimed = Array(16).fill(true);
    const { state, result } = applyAction(s, { type: 'resetTrack' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(state.meta.coldStorage.trackCycle).toBe(1);
    expect(state.meta.coldStorage.trackStartedAt).toBe(NOW);
    expect(state.meta.coldStorage.blocksClaimed.every((b) => b === false)).toBe(true);
  });
  it('resetTrack with headstart tape upgrade pre-claims blocks instantly', () => {
    const s = stateWithTrackStarted(200);
    s.meta.coldStorage.blocksClaimed = Array(16).fill(true);
    s.meta.coldStorage.upgrades.headstart = 3;
    const { state } = applyAction(s, { type: 'resetTrack' }, DEFAULT_CONFIG, NOW);
    expect(state.meta.coldStorage.blocksClaimed.slice(0, 3)).toEqual([true, true, true]);
    expect(state.meta.coldStorage.blocksClaimed[3]).toBe(false);
    expect(state.meta.coldStorage.tapes).toBeGreaterThan(0);
  });
  it('resetTrack cannot self-loop when headstart maxLevel is raised to 16 (regression: unbounded reward loop)', () => {
    // shared/configSchema.js allows upgrades.maxLevels.headstart up to 99 via
    // a live admin tunable; raising it to >= 16 previously let a single
    // headstart pre-claim ALL 16 blocks, which immediately re-satisfied
    // resetTrack's own `blocksClaimed.every(Boolean)` gate and let a reset
    // pay itself out forever with zero wall-clock time between resets.
    const cfg = structuredClone(DEFAULT_CONFIG);
    cfg.upgrades.maxLevels.headstart = TOTAL_BLOCKS;
    const s = stateWithTrackStarted(200); // way more than 96h - all 16 "arrived"
    s.meta.coldStorage.blocksClaimed = Array(TOTAL_BLOCKS).fill(true);
    s.meta.coldStorage.upgrades.headstart = TOTAL_BLOCKS;

    const first = applyAction(s, { type: 'resetTrack' }, cfg, NOW);
    expect(first.result.ok).toBe(true);
    // headStart is clamped to TOTAL_BLOCKS - 1 (15): blocks 0-14 pre-claimed,
    // block 15 must still arrive on wall-clock time.
    expect(first.state.meta.coldStorage.blocksClaimed.slice(0, TOTAL_BLOCKS - 1).every(Boolean)).toBe(true);
    expect(first.state.meta.coldStorage.blocksClaimed[TOTAL_BLOCKS - 1]).toBe(false);

    // Immediately reset again - no wall-clock time has passed, so block 15
    // hasn't arrived. This must be rejected, closing the self-satisfying loop.
    const second = applyAction(first.state, { type: 'resetTrack' }, cfg, NOW);
    expect(second.result).toEqual({ ok: false, error: 'not_met' });
  });
  it('startJob opens a job, rejects a second concurrent job, rejects bad type', () => {
    const s = initialState();
    const a = applyAction(s, { type: 'startJob', jobType: 'index' }, DEFAULT_CONFIG, NOW);
    expect(a.result.ok).toBe(true);
    expect(a.state.meta.coldStorage.job).toEqual({ type: 'index', accruedOfflineSec: 0, startedAt: NOW });
    expect(applyAction(a.state, { type: 'startJob', jobType: 'defrag' }, DEFAULT_CONFIG, NOW).result.error).toBe('invalid_target');
    expect(applyAction(s, { type: 'startJob', jobType: 'nonsense' }, DEFAULT_CONFIG, NOW).result.error).toBe('invalid_target');
  });
  it('cancelJob clears an in-progress job, rejects when none exists', () => {
    const s = initialState();
    s.meta.coldStorage.job = { type: 'defrag', accruedOfflineSec: 100, startedAt: NOW };
    const { state, result } = applyAction(s, { type: 'cancelJob' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(state.meta.coldStorage.job).toBeNull();
    expect(applyAction(state, { type: 'cancelJob' }, DEFAULT_CONFIG, NOW).result.error).toBe('invalid_target');
  });
  it('claimJob rejects before completion, pays out and clears the slot on completion', () => {
    const s = initialState();
    s.meta.coldStorage.job = { type: 'defrag', accruedOfflineSec: 1800, startedAt: NOW }; // half of 3600s
    expect(applyAction(s, { type: 'claimJob' }, DEFAULT_CONFIG, NOW).result.error).toBe('not_met');
    s.meta.coldStorage.job.accruedOfflineSec = 3600;
    const { state, result } = applyAction(s, { type: 'claimJob' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(result.tapes).toBe(20);
    expect(state.meta.coldStorage.job).toBeNull();
    expect(state.meta.coldStorage.tapes).toBe(20);
    expect(state.meta.stats.jobsCompletedLifetime).toBe(1);
    expect(state.meta.stats.deepJobsCompletedLifetime).toBe(0);
  });
  it('claimJob on a completed deep job bumps deepJobsCompletedLifetime too', () => {
    const s = initialState();
    s.meta.coldStorage.job = { type: 'deep', accruedOfflineSec: 86400, startedAt: NOW };
    const { state } = applyAction(s, { type: 'claimJob' }, DEFAULT_CONFIG, NOW);
    expect(state.meta.stats.deepJobsCompletedLifetime).toBe(1);
  });
  it('claimJob fails closed on an unrecognized job.type instead of paying the max reward', () => {
    const s = initialState();
    s.meta.coldStorage.job = { type: 'evil', accruedOfflineSec: 0, startedAt: NOW };
    const before = structuredClone(s);
    const { state, result } = applyAction(s, { type: 'claimJob' }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
    expect(state).toEqual(before);

    const s2 = initialState();
    s2.meta.coldStorage.job = { type: '__proto__', accruedOfflineSec: 0, startedAt: NOW };
    const before2 = structuredClone(s2);
    const { state: state2, result: result2 } = applyAction(s2, { type: 'claimJob' }, DEFAULT_CONFIG, NOW);
    expect(result2).toEqual({ ok: false, error: 'invalid_target' });
    expect(state2).toEqual(before2);
  });
  it('buyTapeUpgrade: happy path, max level, insufficient tapes, bad id', () => {
    const s = initialState();
    s.meta.coldStorage.tapes = 100;
    const a = applyAction(s, { type: 'buyTapeUpgrade', id: 'compression' }, DEFAULT_CONFIG, NOW);
    expect(a.result.ok).toBe(true);
    expect(a.state.meta.coldStorage.upgrades.compression).toBe(1);
    expect(a.state.meta.coldStorage.tapes).toBe(90); // baseCost 10 at level 0

    const poor = initialState();
    expect(applyAction(poor, { type: 'buyTapeUpgrade', id: 'compression' }, DEFAULT_CONFIG, NOW).result.error).toBe('insufficient_credits');

    const maxed = initialState();
    maxed.meta.coldStorage.tapes = 1e9;
    maxed.meta.coldStorage.upgrades.headstart = 5; // maxLevel
    expect(applyAction(maxed, { type: 'buyTapeUpgrade', id: 'headstart' }, DEFAULT_CONFIG, NOW).result.error).toBe('max_level');

    expect(applyAction(s, { type: 'buyTapeUpgrade', id: 'nonsense' }, DEFAULT_CONFIG, NOW).result.error).toBe('invalid_target');
  });
  it('none of the new handlers mutate their input state', () => {
    const s = stateWithTrackStarted(20);
    const snapshot = structuredClone(s);
    applyAction(s, { type: 'claimBlock', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(s).toEqual(snapshot);
  });
});
