import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { initialState } from '../shared/state.js';
import { applyAction } from '../shared/reducer.js';
import { rolloverContracts, contractsForState } from '../shared/contracts.js';

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0); // 2026-07-31
const TOMORROW = NOW + 24 * 3600 * 1000;

// A state with today's board rolled over and contract slot 0 already met, by
// pushing that slot's own metric past its snapshotted target.
function stateWithMetContract() {
  const s = initialState();
  rolloverContracts(s, DEFAULT_CONFIG, NOW);
  const [first] = contractsForState(s.meta);
  s.meta.stats[first.def.metric] = s.meta.contracts.baseline[first.def.metric] + first.target;
  return s;
}

describe('claimContract', () => {
  it('pays wafers and tapes, marks the slot claimed, and bumps the lifetime counter', () => {
    const s = stateWithMetContract();
    const { state, result } = applyAction(s, { type: 'claimContract', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(result.reward.wafers).toBeGreaterThan(0);
    expect(result.reward.tapes).toBeGreaterThan(0);
    expect(state.meta.wafers).toBe(result.reward.wafers);
    expect(state.meta.stats.totalWafersEarned).toBe(result.reward.wafers);
    expect(state.meta.coldStorage.tapes).toBe(result.reward.tapes);
    expect(state.meta.stats.tapesEarnedLifetime).toBe(result.reward.tapes);
    expect(state.meta.contracts.claimed[0]).toBe(true);
    expect(state.meta.stats.contractsCompletedLifetime).toBe(1);
  });

  it('rejects a double claim', () => {
    const s = stateWithMetContract();
    const a = applyAction(s, { type: 'claimContract', index: 0 }, DEFAULT_CONFIG, NOW);
    const b = applyAction(a.state, { type: 'claimContract', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(b.result).toEqual({ ok: false, error: 'invalid_target' });
  });

  it('rejects an unmet contract with not_met', () => {
    const s = initialState();
    rolloverContracts(s, DEFAULT_CONFIG, NOW);
    const unmet = contractsForState(s.meta).find((c) => c.target > 0);
    const { result } = applyAction(s, { type: 'claimContract', index: unmet.index }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'not_met' });
  });

  it('rejects a claim against a stale board (dateKey is not today)', () => {
    const s = stateWithMetContract();
    const { result } = applyAction(s, { type: 'claimContract', index: 0 }, DEFAULT_CONFIG, TOMORROW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });

  it('rejects a claim before any rollover has happened', () => {
    const { result } = applyAction(initialState(), { type: 'claimContract', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });

  it.each([['__proto__'], ['push'], ['length'], [-1], [1.5], [3], [999], [null], [undefined], [{}]])(
    'rejects malformed index %p as invalid_target without throwing', (index) => {
      const s = stateWithMetContract();
      let out;
      expect(() => { out = applyAction(s, { type: 'claimContract', index }, DEFAULT_CONFIG, NOW); }).not.toThrow();
      expect(out.result).toEqual({ ok: false, error: 'invalid_target' });
    },
  );

  it('never mutates the input state', () => {
    const s = stateWithMetContract();
    const before = structuredClone(s);
    applyAction(s, { type: 'claimContract', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(s).toEqual(before);
  });
});

describe('claimStreak', () => {
  it('starts a streak at day 1 and pays FLOPS to both credits and lifetimeRun', () => {
    const s = initialState();
    s.run.tiers[0].owned = 50; // non-zero output so the day-1 FLOPS reward is > 0
    const { state, result } = applyAction(s, { type: 'claimStreak' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(result.day).toBe(1);
    expect(result.reward.flops).toBeGreaterThan(0);
    expect(state.run.credits).toBeCloseTo(s.run.credits + result.reward.flops);
    expect(state.run.lifetimeRun).toBeCloseTo(s.run.lifetimeRun + result.reward.flops);
    expect(state.meta.streak).toEqual({ count: 1, lastClaimDate: '2026-07-31' });
    expect(state.meta.stats.bestStreak).toBe(1);
  });

  it('rejects a second claim on the same UTC day', () => {
    const a = applyAction(initialState(), { type: 'claimStreak' }, DEFAULT_CONFIG, NOW);
    const b = applyAction(a.state, { type: 'claimStreak' }, DEFAULT_CONFIG, NOW + 3600 * 1000);
    expect(b.result).toEqual({ ok: false, error: 'invalid_target' });
  });

  it('advances on a consecutive day and records the best streak', () => {
    let s = initialState();
    for (let day = 0; day < 3; day++) {
      s = applyAction(s, { type: 'claimStreak' }, DEFAULT_CONFIG, NOW + day * 24 * 3600 * 1000).state;
    }
    expect(s.meta.streak.count).toBe(3);
    expect(s.meta.stats.bestStreak).toBe(3);
  });

  it('resets to day 1 after a missed day but keeps bestStreak', () => {
    let s = initialState();
    for (let day = 0; day < 4; day++) {
      s = applyAction(s, { type: 'claimStreak' }, DEFAULT_CONFIG, NOW + day * 24 * 3600 * 1000).state;
    }
    const after = applyAction(s, { type: 'claimStreak' }, DEFAULT_CONFIG, NOW + 6 * 24 * 3600 * 1000).state;
    expect(after.meta.streak.count).toBe(1);
    expect(after.meta.stats.bestStreak).toBe(4);
  });

  it('pays tapes on the final day of the streak', () => {
    let s = initialState();
    let last;
    for (let day = 0; day < DEFAULT_CONFIG.social.streakMaxDay; day++) {
      last = applyAction(s, { type: 'claimStreak' }, DEFAULT_CONFIG, NOW + day * 24 * 3600 * 1000);
      s = last.state;
    }
    expect(last.result.day).toBe(DEFAULT_CONFIG.social.streakMaxDay);
    expect(last.result.reward.tapes).toBe(DEFAULT_CONFIG.social.streakDay7Tapes);
    expect(s.meta.coldStorage.tapes).toBe(DEFAULT_CONFIG.social.streakDay7Tapes);
    expect(s.meta.stats.tapesEarnedLifetime).toBe(DEFAULT_CONFIG.social.streakDay7Tapes);
  });

  it('never mutates the input state', () => {
    const s = initialState();
    const before = structuredClone(s);
    applyAction(s, { type: 'claimStreak' }, DEFAULT_CONFIG, NOW);
    expect(s).toEqual(before);
  });
});

describe('achievement sweep on the action path', () => {
  it('reports newly-unlocked achievements on the action result', () => {
    const s = initialState();
    s.meta.legacyCores = 100; // enough for a Singularity
    const { state, result } = applyAction(s, { type: 'singularity' }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(result.unlockedAchievements).toContain('first_singularity');
    expect(state.meta.achievements.first_singularity).toBe(NOW);
  });

  it('omits the field entirely when nothing unlocked', () => {
    const s = initialState();
    s.run.credits = 1e6;
    const { result } = applyAction(s, { type: 'buy', lane: 'tiers', index: 0, mode: 1 }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(true);
    expect(result.unlockedAchievements).toBeUndefined();
  });

  it('does not sweep after a rejected action', () => {
    const s = initialState();
    s.meta.stats.singularities = 1; // condition is met...
    const { state, result } = applyAction(s, { type: 'claimContract', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(result.ok).toBe(false); // ...but the action failed
    expect(state.meta.achievements).toEqual({});
  });
});
