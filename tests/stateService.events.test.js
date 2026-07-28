// Hotfix regression coverage for two confirmed v1.4 Live Events bugs found
// during Task 7's real-browser verification (see
// .superpowers/sdd/2026-07-27-v1.4-live-events/task-7-report.md's Concerns
// section, and hotfix-events-report.md for the fix writeup):
//
//   (a) The 48h post-event claim-grace period (spec §5.3) was unreachable:
//       claimEventRung's very first guard read config.__activeEvent, which
//       getEffectiveConfig() only attaches while an event's DB status is
//       still 'active' - the instant an event ended, every claim (even one
//       well within the player's own still-open personal window) failed
//       with invalid_target before the grace-period branch was ever
//       reached.
//   (b) event_participation.rungs_claimed was only ever written once, at
//       join time (hardcoded to 0) - nothing re-synced it after a claim, so
//       the leaderboard's own sort key was permanently 0 for every player.
//       (Covered end-to-end, over real HTTP, in
//       tests/api.events.hotfix.test.js - this file is the module-level
//       coverage for bug (a) plus the cache-isolation safety property the
//       fix for (a) depends on.)
//
// Deliberately exercises the REAL getEffectiveConfig() / stateService.js
// path (loadEvaluateAndSchedule / loadAndEvaluate / applyActions) rather
// than hand-constructing a config object, unlike tests/reducer.events.test.js
// - hand-building config.__activeEvent directly is exactly why the original
// bug was invisible to the existing suite (Task 7 report).
process.env.DB_PATH = ':memory:';

import { describe, it, expect } from 'vitest';

const dbMod = await import('../server/db.js');
const {
  upsertUser, putEvent, putSave,
} = dbMod;
const configService = await import('../server/configService.js');
const { ensureConfig, getConfig, getEffectiveConfig } = configService;
const eventService = await import('../server/eventService.js');
const { activateEvent, endEvent } = eventService;
const stateService = await import('../server/stateService.js');
const { loadEvaluateAndSchedule, loadAndEvaluate, applyActions } = stateService;
const { EVENT_CLAIM_GRACE_MS } = await import('../shared/reducer.js');
const { initialState } = await import('../shared/state.js');

ensureConfig();

let seq = 0;
function makeUser() {
  seq += 1;
  return upsertUser({
    provider: 'discord', providerId: `ss${seq}`, username: `ssuser${seq}`, avatarUrl: null,
  });
}

function sampleEvent(overrides = {}) {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    name: 'Test Event',
    description: 'A test event',
    theme: { icon: '🧪', color: '#123456' },
    modifiers: [],
    ladder: [{ metric: 'flopsEarned', target: 0, reward: { wafers: 7 } }],
    status: 'draft',
    recurrence: null,
    createdAt: Date.now(),
    createdBy: 'admin:1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cache-isolation safety property: this is the single most dangerous part of
// the bug (a) fix per the hotfix brief - getEffectiveConfig()'s
// (version, eventId)-keyed cache is SHARED across every user's request, so
// attaching a per-user __claimableEvent must never mutate it, or one user's
// claimable event would leak onto every other request that hits the same
// cache before it next invalidates.
// ---------------------------------------------------------------------------
describe('loadEvaluateAndSchedule: __claimableEvent per-user isolation (hotfix bug a safety property)', () => {
  it('does not mutate configService\'s shared effective-config cache when attaching a per-user __claimableEvent', () => {
    const now = Date.now();
    const alice = makeUser();

    putEvent(sampleEvent({ id: 'isolation-evt', startsAt: now - 1000, endsAt: now + 100000 }));
    activateEvent('isolation-evt', now);

    const sharedBefore = getEffectiveConfig();
    expect(sharedBefore.data.__claimableEvent).toBeUndefined();

    const { config: configA } = loadEvaluateAndSchedule(alice.id, now);
    expect(configA.__claimableEvent).toEqual({
      id: 'isolation-evt',
      ladder: sampleEvent().ladder,
      endsAt: now + 100000,
    });

    // The cached object itself - same (version, eventId) key, so
    // getEffectiveConfig() hands back the identical cached reference - must
    // remain untouched by attaching Alice's claimable event to her own
    // per-request copy.
    const sharedAfter = getEffectiveConfig();
    expect(sharedAfter.data).toBe(sharedBefore.data);
    expect(sharedAfter.data.__claimableEvent).toBeUndefined();

    // configA must be a distinct object from the shared cached data, not the
    // same reference with a field bolted on.
    expect(configA).not.toBe(sharedAfter.data);
  });

  it('two different users never see each other\'s __claimableEvent', () => {
    const now = Date.now();
    const alice = makeUser();
    const bob = makeUser();

    putEvent(sampleEvent({ id: 'leak-evt', startsAt: now - 1000, endsAt: now + 5000 }));
    activateEvent('leak-evt', now);

    // Alice joins while the event is active (persisted via loadAndEvaluate).
    const { state: aliceState } = loadAndEvaluate(alice.id, now);
    expect(aliceState.meta.eventProgress.eventId).toBe('leak-evt');
    const { config: configAAfterJoin } = loadEvaluateAndSchedule(alice.id, now);
    expect(configAAfterJoin.__claimableEvent.id).toBe('leak-evt');

    // The event ends globally with nothing new activated, and Bob loads his
    // state for the very first time - he never joined anything, so
    // joinEventIfEligible's "no event active" branch must leave his
    // eventProgress null. If the shared cache had somehow been mutated by
    // Alice's request, Bob's config could incorrectly inherit her
    // __claimableEvent.
    endEvent('leak-evt', now + 6000);
    const { state: bobState, config: configB } = loadEvaluateAndSchedule(bob.id, now + 7000);
    expect(bobState.meta.eventProgress).toBeNull();
    expect(configB.__claimableEvent).toBeUndefined();

    // Alice's own lingering grace-period progress must still resolve
    // correctly and independently of Bob's load.
    const { config: configAAfterBob } = loadEvaluateAndSchedule(alice.id, now + 7000);
    expect(configAAfterBob.__claimableEvent).toEqual({
      id: 'leak-evt',
      ladder: sampleEvent().ladder,
      endsAt: now + 5000,
    });
    expect(configAAfterBob).not.toBe(configB);
  });
});

// ---------------------------------------------------------------------------
// Bug (a): the 48h claim grace period itself.
// ---------------------------------------------------------------------------
describe('claimEventRung end-to-end: 48h grace period reachable after the event globally ends (hotfix bug a)', () => {
  it('an ended event stops applying its modifiers immediately, but its ladder stays claimable (and actually pays out) within the grace period', () => {
    const now = Date.now();
    const user = makeUser();
    const baseGridMult = getConfig().data.production.gridMult;

    putEvent(sampleEvent({
      id: 'grace-evt',
      startsAt: now - 1000,
      endsAt: now + 5000,
      modifiers: [{ path: 'production.gridMult', value: baseGridMult + 5 }],
    }));
    activateEvent('grace-evt', now);
    expect(getEffectiveConfig().data.production.gridMult).toBe(baseGridMult + 5);

    // Join while the event is still active.
    const { state: joined } = loadAndEvaluate(user.id, now);
    expect(joined.meta.eventProgress.eventId).toBe('grace-evt');
    const startingWafers = joined.meta.wafers;

    // Global end, well before the player's own personal window/grace has
    // elapsed - this is precisely the case that returned invalid_target
    // before the fix, because config.__activeEvent disappeared the instant
    // status left 'active'.
    endEvent('grace-evt', now + 2000);

    // The modifier overlay must be gone immediately - that part already
    // worked correctly and must not regress.
    expect(getEffectiveConfig().data.__activeEvent).toBeUndefined();
    expect(getEffectiveConfig().data.production.gridMult).toBe(baseGridMult);

    // The claim, made after the global end but well within grace, must now
    // succeed and actually pay out.
    const { state: claimed, results } = applyActions(
      user.id,
      [{ type: 'claimEventRung', index: 0 }],
      now + 3000,
    );
    expect(results[0]).toMatchObject({ ok: true, rungIndex: 0, reward: { wafers: 7 } });
    expect(claimed.meta.wafers).toBe(startingWafers + 7);
    expect(claimed.meta.eventProgress.rungsClaimed).toEqual([0]);
  });

  it('rejects with cooldown_active - not invalid_target - once the 48h grace period after the personal endsAt has truly passed', () => {
    const now = Date.now();
    const user = makeUser();

    putEvent(sampleEvent({
      id: 'grace-expired-evt',
      startsAt: now - 1000,
      endsAt: now + 1000,
    }));
    activateEvent('grace-expired-evt', now);

    const { state: joined } = loadAndEvaluate(user.id, now);
    const personalEndsAt = joined.meta.eventProgress.endsAt;

    endEvent('grace-expired-evt', now + 1500);

    const pastGrace = personalEndsAt + EVENT_CLAIM_GRACE_MS + 1;
    const { results } = applyActions(user.id, [{ type: 'claimEventRung', index: 0 }], pastGrace);
    expect(results[0]).toEqual({ ok: false, error: 'cooldown_active' });
  });

  it('fails closed with invalid_target (never throws) when eventProgress references an event id no longer in the DB at all', () => {
    // Simulates a save whose eventProgress points at an event id that has
    // since been deleted (or, as constructed here, simply never existed) -
    // event_participation's FK to live_events(id) means a row that was ever
    // actually joined can't be deleted while participation references it, so
    // this exercises the same code path (getEvent(id) returns undefined)
    // directly via a hand-placed save rather than via a real delete.
    const now = Date.now();
    const user = makeUser();

    const s = initialState();
    s.meta.eventProgress = {
      eventId: 'never-existed',
      joinedAt: now - 1000,
      endsAt: now + 100000,
      baseline: { flopsEarned: 0 },
      rungsClaimed: [],
    };
    putSave(user.id, s, now);

    let results;
    expect(() => {
      ({ results } = applyActions(user.id, [{ type: 'claimEventRung', index: 0 }], now + 1000));
    }).not.toThrow();
    expect(results[0]).toEqual(expect.objectContaining({ ok: false, error: 'invalid_target' }));
  });
});
