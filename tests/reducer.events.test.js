import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { initialState } from '../shared/state.js';
import { applyAction } from '../shared/reducer.js';

const NOW = 1_000_000;
const GRACE_MS = 48 * 3600 * 1000;

const LADDER = [
  { metric: 'flopsEarned', target: 100, reward: { flops: 50 } },
  { metric: 'flopsEarned', target: 200, reward: { wafers: 3, tapes: 5, flops: 20 } },
];

function activeConfig(ladder = LADDER, endsAt = NOW + 100000, id = 'ev1') {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.__activeEvent = { id, ladder, endsAt };
  return cfg;
}

function joinedState({ eventId = 'ev1', endsAt = NOW + 100000, baseline = { flopsEarned: 0 }, rungsClaimed = [], flops = 0 } = {}) {
  const s = initialState();
  s.meta.eventProgress = { eventId, joinedAt: NOW - 1000, endsAt, baseline, rungsClaimed };
  s.meta.stats.lifetimeFlopsAllTime = flops;
  return s;
}

describe('reducer: claimEventRung', () => {
  it('happy path: credits flops to run.credits AND run.lifetimeRun, pushes index into rungsClaimed', () => {
    const s = joinedState({ flops: 150 }); // rung0 target 100, met
    const cfg = activeConfig();
    const { state: s2, result } = applyAction(s, { type: 'claimEventRung', index: 0 }, cfg, NOW);
    expect(result).toEqual({ ok: true, reward: { flops: 50 }, rungIndex: 0 });
    expect(s2.run.credits).toBe(10 + 50); // initial 10 + flops reward
    expect(s2.run.lifetimeRun).toBe(50);
    expect(s2.meta.eventProgress.rungsClaimed).toEqual([0]);
  });

  it('happy path: credits wafers, tapes (both counters), and flops (both fields) for a mixed-reward rung', () => {
    const s = joinedState({ flops: 250 }); // rung1 target 200, met
    const cfg = activeConfig();
    const { state: s2, result } = applyAction(s, { type: 'claimEventRung', index: 1 }, cfg, NOW);
    expect(result.ok).toBe(true);
    expect(result.reward).toEqual({ wafers: 3, tapes: 5, flops: 20 });
    expect(result.rungIndex).toBe(1);

    expect(s2.meta.wafers).toBe(3);
    expect(s2.meta.stats.totalWafersEarned).toBe(3);

    expect(s2.meta.coldStorage.tapes).toBe(5);
    expect(s2.meta.stats.tapesEarnedLifetime).toBe(5);

    expect(s2.run.credits).toBe(10 + 20);
    expect(s2.run.lifetimeRun).toBe(20);

    expect(s2.meta.eventProgress.rungsClaimed).toEqual([1]);
  });

  it('honors baseline: only progress since joining counts toward the target', () => {
    const s = joinedState({ flops: 250, baseline: { flopsEarned: 200 } }); // current = 250-200=50, rung0 target 100 -> not met
    const cfg = activeConfig();
    const { result } = applyAction(s, { type: 'claimEventRung', index: 0 }, cfg, NOW);
    expect(result).toEqual({ ok: false, error: 'not_met' });
  });

  it('rejects not_met when rung progress condition is unmet', () => {
    const s = joinedState({ flops: 10 }); // current 10 < target 100
    const cfg = activeConfig();
    const { result } = applyAction(s, { type: 'claimEventRung', index: 0 }, cfg, NOW);
    expect(result).toEqual({ ok: false, error: 'not_met' });
  });

  it('rejects invalid_target on double-claim of an already-claimed rung', () => {
    const s = joinedState({ flops: 500, rungsClaimed: [0] });
    const cfg = activeConfig();
    const { result } = applyAction(s, { type: 'claimEventRung', index: 0 }, cfg, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });

  it('rejects invalid_target when meta.eventProgress is null', () => {
    const s = initialState();
    const cfg = activeConfig();
    const { result } = applyAction(s, { type: 'claimEventRung', index: 0 }, cfg, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });

  it('rejects invalid_target when config.__activeEvent is absent', () => {
    const s = joinedState({ flops: 500 });
    const { result } = applyAction(s, { type: 'claimEventRung', index: 0 }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });

  it('rejects invalid_target when eventProgress.eventId does not match config.__activeEvent.id', () => {
    const s = joinedState({ eventId: 'stale-event', flops: 500 });
    const cfg = activeConfig(LADDER, NOW + 100000, 'ev1');
    const { result } = applyAction(s, { type: 'claimEventRung', index: 0 }, cfg, NOW);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
  });

  it('rejects cooldown_active once past the 48h grace period after endsAt', () => {
    const endsAt = NOW - 1000;
    const s = joinedState({ endsAt, flops: 500 });
    const cfg = activeConfig(LADDER, endsAt);
    const pastGrace = endsAt + GRACE_MS + 1;
    const { result } = applyAction(s, { type: 'claimEventRung', index: 0 }, cfg, pastGrace);
    expect(result).toEqual({ ok: false, error: 'cooldown_active' });
  });

  it('still allows a claim exactly within the 48h grace period after endsAt', () => {
    const endsAt = NOW - 1000;
    const s = joinedState({ endsAt, flops: 500 });
    const cfg = activeConfig(LADDER, endsAt);
    const withinGrace = endsAt + GRACE_MS - 1;
    const { result } = applyAction(s, { type: 'claimEventRung', index: 0 }, cfg, withinGrace);
    expect(result.ok).toBe(true);
  });

  it.each(['__proto__', 'push', -1, 1.5, 999])(
    'rejects invalid_target without throwing for malformed index %p',
    (badIndex) => {
      const s = joinedState({ flops: 500 });
      const cfg = activeConfig();
      let result;
      expect(() => {
        ({ result } = applyAction(s, { type: 'claimEventRung', index: badIndex }, cfg, NOW));
      }).not.toThrow();
      expect(result).toEqual({ ok: false, error: 'invalid_target' });
    },
  );

  it('does not mutate the input state', () => {
    const s = joinedState({ flops: 150 });
    const snapshotWafers = s.meta.wafers;
    const snapshotCredits = s.run.credits;
    applyAction(s, { type: 'claimEventRung', index: 0 }, activeConfig(), NOW);
    expect(s.meta.eventProgress.rungsClaimed).toEqual([]);
    expect(s.meta.wafers).toBe(snapshotWafers);
    expect(s.run.credits).toBe(snapshotCredits);
  });
});

describe('reducer: setLeaderboardOptOut', () => {
  it('records optOut=true in meta for client display', () => {
    const s = initialState();
    const { state: s2, result } = applyAction(s, { type: 'setLeaderboardOptOut', optOut: true }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: true });
    expect(s2.meta.leaderboardOptOut).toBe(true);
  });

  it('records optOut=false', () => {
    const s = initialState();
    const { state: s2, result } = applyAction(s, { type: 'setLeaderboardOptOut', optOut: false }, DEFAULT_CONFIG, NOW);
    expect(result).toEqual({ ok: true });
    expect(s2.meta.leaderboardOptOut).toBe(false);
  });

  it.each([1, 0, 'true', null, undefined, {}])(
    'rejects invalid_target for non-boolean optOut value %p',
    (badValue) => {
      const s = initialState();
      const { result } = applyAction(s, { type: 'setLeaderboardOptOut', optOut: badValue }, DEFAULT_CONFIG, NOW);
      expect(result).toEqual({ ok: false, error: 'invalid_target' });
    },
  );

  it('does not mutate the input state', () => {
    const s = initialState();
    applyAction(s, { type: 'setLeaderboardOptOut', optOut: true }, DEFAULT_CONFIG, NOW);
    expect(s.meta.leaderboardOptOut).toBeUndefined();
  });
});
