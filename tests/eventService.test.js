process.env.DB_PATH = ':memory:';

import { describe, it, expect } from 'vitest';

const dbMod = await import('../server/db.js');
const {
  upsertUser, putEvent, getEvent, listEvents, getConfigRow, getParticipation,
} = dbMod;
const configService = await import('../server/configService.js');
const { ensureConfig, getConfig, getEffectiveConfig } = configService;
const eventService = await import('../server/eventService.js');
const {
  activateEvent, endEvent, runScheduler, joinEventIfEligible,
} = eventService;
const { initialState } = await import('../shared/state.js');

ensureConfig();

let seq = 0;
function makeUser() {
  seq += 1;
  return upsertUser({
    provider: 'discord', providerId: `es${seq}`, username: `esuser${seq}`, avatarUrl: null,
  });
}

function sampleEvent(overrides = {}) {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    name: 'Test Event',
    description: 'A test event',
    theme: { icon: '🧪', color: '#123456' },
    modifiers: [{ path: 'production.gridMult', value: 3 }],
    ladder: [
      { metric: 'flopsEarned', target: 100, reward: { wafers: 5 } },
    ],
    status: 'draft',
    recurrence: null,
    createdAt: Date.now(),
    createdBy: 'admin:1',
    ...overrides,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// These two must run before ANYTHING in this file activates an event -
// once one is active it stays active (or gets superseded by another) for
// the rest of the suite, so "nothing is active" is only guaranteed here, at
// the top.
// ---------------------------------------------------------------------------

describe('no active event (must run first)', () => {
  it('getEffectiveConfig returns the base config unchanged when no event is active', () => {
    const eff = getEffectiveConfig();
    const base = getConfig();
    expect(eff.eventId).toBeNull();
    expect(eff.data).toBe(base.data);
  });

  it('joinEventIfEligible does nothing when no event is active and there is no prior progress', () => {
    const u = makeUser();
    const state = initialState();
    const result = joinEventIfEligible(u.id, state, Date.now());
    expect(result).toBeFalsy();
    expect(state.meta.eventProgress).toBeNull();
  });
});

describe('getEffectiveConfig', () => {
  it('merges the active events modifiers without mutating the stored config row or baseline cache', () => {
    const now = Date.now();
    const before = getConfigRow().data;
    const baseData = getConfig().data;
    expect(baseData.production.gridMult).not.toBe(3);

    putEvent(sampleEvent({ id: 'ev-merge', startsAt: now - 1000, endsAt: now + 100000 }));
    expect(activateEvent('ev-merge', now)).toEqual({ ok: true });

    const eff = getEffectiveConfig();
    expect(eff.eventId).toBe('ev-merge');
    expect(eff.data.production.gridMult).toBe(3);
    expect(eff.data.__activeEvent).toEqual({
      id: 'ev-merge',
      ladder: sampleEvent().ladder,
      endsAt: now + 100000,
    });

    // baseline untouched, both in the in-process cache and in the DB row
    expect(getConfig().data).toBe(baseData);
    expect(baseData.production.gridMult).not.toBe(3);
    expect(getConfigRow().data).toBe(before);
  });

  it('reverts to the base config once the active event ends', () => {
    const now = Date.now();
    putEvent(sampleEvent({ id: 'ev-revert', startsAt: now - 1000, endsAt: now + 100000 }));
    activateEvent('ev-revert', now);
    expect(getEffectiveConfig().eventId).toBe('ev-revert');

    endEvent('ev-revert', now);
    const eff = getEffectiveConfig();
    expect(eff.eventId).toBeNull();
    expect(eff.data.__activeEvent).toBeUndefined();
  });
});

describe('activateEvent', () => {
  it('rejects an unknown id', () => {
    expect(activateEvent('nope-at-all', Date.now())).toEqual({ ok: false, error: 'not_found' });
  });

  it('rejects an event with no scheduled window', () => {
    putEvent(sampleEvent({ id: 'ev-unscheduled' }));
    expect(activateEvent('ev-unscheduled', Date.now())).toEqual({ ok: false, error: 'not_scheduled' });
  });

  it('ends any currently active event before activating the new one', () => {
    const now = Date.now();
    putEvent(sampleEvent({ id: 'ev-1', startsAt: now - 1000, endsAt: now + 100000 }));
    putEvent(sampleEvent({ id: 'ev-2', startsAt: now - 1000, endsAt: now + 100000 }));

    expect(activateEvent('ev-1', now)).toEqual({ ok: true });
    expect(getEvent('ev-1').status).toBe('active');

    expect(activateEvent('ev-2', now)).toEqual({ ok: true });
    expect(getEvent('ev-2').status).toBe('active');
    expect(getEvent('ev-1').status).toBe('ended');
  });
});

describe('endEvent', () => {
  it('sets status to ended without touching the window, and invalidates the effective config', () => {
    const now = Date.now();
    putEvent(sampleEvent({ id: 'ev-end', startsAt: now - 1000, endsAt: now + 100000 }));
    activateEvent('ev-end', now);
    expect(getEffectiveConfig().eventId).toBe('ev-end');

    expect(endEvent('ev-end', now)).toEqual({ ok: true });
    const row = getEvent('ev-end');
    expect(row.status).toBe('ended');
    expect(row.starts_at).toBe(now - 1000);
    expect(row.ends_at).toBe(now + 100000);
    expect(getEffectiveConfig().eventId).toBeNull();
  });

  it('rejects an unknown id', () => {
    expect(endEvent('nope-at-all', Date.now())).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('runScheduler', () => {
  it('activates scheduled events whose window has arrived and ends expired active ones, idempotently', () => {
    const now = Date.now();
    putEvent(sampleEvent({ id: 'ev-sched', status: 'scheduled', startsAt: now - 1000, endsAt: now + 100000 }));
    putEvent(sampleEvent({ id: 'ev-expiring', status: 'active', startsAt: now - 200000, endsAt: now - 1000 }));

    runScheduler(now);
    expect(getEvent('ev-sched').status).toBe('active');
    expect(getEvent('ev-expiring').status).toBe('ended');

    const snapshot1 = { sched: getEvent('ev-sched'), expiring: getEvent('ev-expiring') };
    runScheduler(now);
    const snapshot2 = { sched: getEvent('ev-sched'), expiring: getEvent('ev-expiring') };
    expect(snapshot2).toEqual(snapshot1);
  });

  it('when two scheduled events windows both arrive before a run, exactly one ends up active and the other is ended', () => {
    const now = Date.now();
    putEvent(sampleEvent({ id: 'ev-early', status: 'scheduled', startsAt: now - 5000, endsAt: now + 100000 }));
    putEvent(sampleEvent({ id: 'ev-late', status: 'scheduled', startsAt: now - 1000, endsAt: now + 100000 }));

    runScheduler(now);

    // Documented choice: within one scheduler tick, the later-starting
    // candidate (ties broken by id) is processed last and wins, since
    // activateEvent always ends whatever else is active. The earlier one is
    // left 'ended', not 'scheduled'.
    expect(getEvent('ev-late').status).toBe('active');
    expect(getEvent('ev-early').status).toBe('ended');

    runScheduler(now);
    expect(getEvent('ev-late').status).toBe('active');
    expect(getEvent('ev-early').status).toBe('ended');
  });

  it('materializes a draft recurrence into the next occurrence window', () => {
    const now = Date.UTC(2026, 0, 1); // Jan 1 2026, well before a July event
    putEvent(sampleEvent({
      id: 'ev-recur',
      status: 'draft',
      startsAt: null,
      endsAt: null,
      recurrence: { month: 7, day: 1, durationDays: 14 },
    }));

    runScheduler(now);
    const row = getEvent('ev-recur');
    expect(row.status).toBe('scheduled');
    expect(row.starts_at).toBe(Date.UTC(2026, 6, 1));
    expect(row.ends_at).toBe(Date.UTC(2026, 6, 1) + 14 * DAY_MS);

    // idempotent - a second call with the same `now` doesn't re-materialize
    runScheduler(now);
    expect(getEvent('ev-recur')).toEqual(row);
  });

  it('materializes into next year once this years occurrence has fully passed', () => {
    const now = Date.UTC(2026, 11, 31); // Dec 31 2026 - well past a July window
    putEvent(sampleEvent({
      id: 'ev-recur-past',
      status: 'draft',
      startsAt: null,
      endsAt: null,
      recurrence: { month: 7, day: 1, durationDays: 14 },
    }));

    runScheduler(now);
    expect(getEvent('ev-recur-past').starts_at).toBe(Date.UTC(2027, 6, 1));
  });

  it('does not clobber a coordinators hand-set window on a draft that also carries a recurrence', () => {
    const now = Date.now();
    putEvent(sampleEvent({
      id: 'ev-recur-handset',
      status: 'draft',
      startsAt: now + 500000,
      endsAt: now + 600000,
      recurrence: { month: 7, day: 1, durationDays: 14 },
    }));

    runScheduler(now);
    const row = getEvent('ev-recur-handset');
    expect(row.status).toBe('draft');
    expect(row.starts_at).toBe(now + 500000);
    expect(row.ends_at).toBe(now + 600000);
  });
});

describe('joinEventIfEligible', () => {
  it('snapshots baselines and writes participation on first join, and is a no-op on a second call', () => {
    const u = makeUser();
    const now = Date.now();
    putEvent(sampleEvent({ id: 'ev-join', startsAt: now, endsAt: now + 7 * DAY_MS }));
    activateEvent('ev-join', now);

    const state = initialState();
    state.meta.stats.lifetimeFlopsAllTime = 42;
    state.meta.stats.minigamesWon = 1;

    const active1 = joinEventIfEligible(u.id, state, now);
    expect(active1.id).toBe('ev-join');
    expect(state.meta.eventProgress).toEqual({
      eventId: 'ev-join',
      joinedAt: now,
      endsAt: now + 7 * DAY_MS,
      baseline: {
        flopsEarned: 42, minigamesWon: 1, blocksClaimed: 0, tapesEarned: 0, wafersEarned: 0,
      },
      rungsClaimed: [],
    });

    const participation = getParticipation(u.id, 'ev-join');
    expect(participation).toBeDefined();
    expect(participation.started_at).toBe(now);
    expect(participation.ends_at).toBe(now + 7 * DAY_MS);
    expect(participation.rungs_claimed).toBe(0);

    const snapshot = { ...state.meta.eventProgress };
    // second call, later `now`, more stats accrued - must be a pure no-op
    state.meta.stats.lifetimeFlopsAllTime = 999;
    const active2 = joinEventIfEligible(u.id, state, now + 5000);
    expect(active2.id).toBe('ev-join');
    expect(state.meta.eventProgress).toEqual(snapshot);
  });

  it('caps personal endsAt at 24h past the global end for a late joiner', () => {
    const u = makeUser();
    const now = Date.now();
    const start = now - 6 * DAY_MS;
    const end = now + 1 * DAY_MS; // 7-day event, 6 days already elapsed
    putEvent(sampleEvent({ id: 'ev-late-join', startsAt: start, endsAt: end }));
    activateEvent('ev-late-join', now);

    const state = initialState();
    joinEventIfEligible(u.id, state, now);

    const eventDurationMs = end - start;
    const uncapped = now + eventDurationMs;
    const cap = end + DAY_MS;
    expect(uncapped).toBeGreaterThan(cap); // sanity: this test exercises the cap
    expect(state.meta.eventProgress.endsAt).toBe(cap);
  });

  it('clears a superseded events progress once a different event is active, and reuses fresh baselines', () => {
    const u = makeUser();
    const now = Date.now();
    putEvent(sampleEvent({ id: 'ev-old', startsAt: now - 10000, endsAt: now + 10000 }));
    activateEvent('ev-old', now);

    const state = initialState();
    joinEventIfEligible(u.id, state, now);
    expect(state.meta.eventProgress.eventId).toBe('ev-old');

    putEvent(sampleEvent({ id: 'ev-new', startsAt: now, endsAt: now + 50000 }));
    activateEvent('ev-new', now); // force-ends ev-old

    const later = now + 1000;
    const active = joinEventIfEligible(u.id, state, later);
    expect(active.id).toBe('ev-new');
    expect(state.meta.eventProgress.eventId).toBe('ev-new');
    expect(state.meta.eventProgress.joinedAt).toBe(later);
  });

  it('leaves a lingering eventProgress untouched during its grace period once nothing is currently active', () => {
    const u = makeUser();
    const now = Date.now();
    putEvent(sampleEvent({ id: 'ev-grace', startsAt: now - 10000, endsAt: now + 1000 }));
    activateEvent('ev-grace', now);

    const state = initialState();
    joinEventIfEligible(u.id, state, now);
    expect(state.meta.eventProgress.eventId).toBe('ev-grace');

    endEvent('ev-grace', now + 2000); // ends, nothing new activated

    const result = joinEventIfEligible(u.id, state, now + 3000);
    expect(result).toBeFalsy();
    expect(state.meta.eventProgress.eventId).toBe('ev-grace'); // untouched
  });
});
