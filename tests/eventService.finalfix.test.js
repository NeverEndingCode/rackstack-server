// Regression tests for the v1.4 whole-branch final review's server-side
// findings. Each block names the finding it pins and, where it matters, what
// the pre-fix behaviour actually was - all six were reproduced against a real
// server before being fixed, and all six were invisible to the pre-existing
// suites.
process.env.DB_PATH = ':memory:';

import { describe, it, expect } from 'vitest';

const dbMod = await import('../server/db.js');
const { upsertUser, putEvent, getEvent, setEventStatus } = dbMod;
const { ensureConfig } = await import('../server/configService.js');
const eventService = await import('../server/eventService.js');
const {
  activateEvent, endEvent, runScheduler, joinEventIfEligible, resolvePlayerEvents,
} = eventService;
const { initialState } = await import('../shared/state.js');
const { applyAction, EVENT_CLAIM_GRACE_MS } = await import('../shared/reducer.js');
const { validateRecurrence } = await import('../shared/events.js');
const { DEFAULT_CONFIG } = await import('../shared/configSchema.js');

await ensureConfig();

// applyAction needs a FULL config document, not just the __claimableEvent /
// __pendingClaimables runtime fields these tests care about: v1.5's automatic
// achievement sweep runs goalCtx() after every successful action, and that
// reads real tunables (config.offline.*, config.production.*, ...). The bare
// `{ __claimableEvent }` objects these tests used to hand-build threw on the
// first successful claim once that sweep landed. Same convention
// tests/reducer.events.test.js's activeConfig() helper already uses.
function withDefaults(runtimeFields) {
  return { ...structuredClone(DEFAULT_CONFIG), ...runtimeFields };
}

const DAY_MS = 24 * 60 * 60 * 1000;
let seq = 0;

async function makeUser() {
  seq += 1;
  return await upsertUser({
    provider: 'discord', providerId: `ff${seq}`, username: `ffuser${seq}`, avatarUrl: null,
  });
}

async function makeEvent(overrides = {}) {
  seq += 1;
  return await putEvent({
    id: `ff-evt-${seq}`,
    name: `Final Fix Event ${seq}`,
    description: null,
    theme: null,
    modifiers: [],
    ladder: [{ metric: 'flopsEarned', target: 100, reward: { wafers: 20 } }],
    status: 'draft',
    recurrence: null,
    createdAt: Date.now(),
    createdBy: null,
    ...overrides,
  });
}

/** Clears every event row's status back to 'draft' with no window. */
async function quiesce() {
  for (const e of await dbMod.listEvents()) await setEventStatus(e.id, 'draft', { startsAt: null, endsAt: null });
}

// ---------------------------------------------------------------------------
// IMPORTANT 4 - the scheduler activated events whose window had fully elapsed
// ---------------------------------------------------------------------------

describe('activateEvent: refuses an already-elapsed window (guard in the primitive, so BOTH callers inherit it)', () => {
  it('rejects invalid_target when ends_at is already past', async () => {
    await quiesce();
    const now = Date.now();
    const evt = await makeEvent();
    await setEventStatus(evt.id, 'scheduled', { startsAt: now - 20 * DAY_MS, endsAt: now - 10 * DAY_MS });

    const result = await activateEvent(evt.id, now);
    expect(result).toEqual({ ok: false, error: 'invalid_target' });
    expect((await getEvent(evt.id)).status).toBe('scheduled');
  });

  it('still activates a window that is currently open', async () => {
    await quiesce();
    const now = Date.now();
    const evt = await makeEvent();
    await setEventStatus(evt.id, 'scheduled', { startsAt: now - 1000, endsAt: now + DAY_MS });

    expect(await activateEvent(evt.id, now)).toEqual({ ok: true });
    expect((await getEvent(evt.id)).status).toBe('active');
    await endEvent(evt.id, now);
  });
});

describe('runScheduler: a scheduled window that fully elapsed while the server was down', () => {
  // The failure this pins: the ends_at<=now guard originally shipped on the
  // manual /activate route ONLY, and runScheduler called the same primitive
  // with no such check. A server down across a scheduled event's whole window
  // (host reboot, container redeploy, Unraid update) would activate the dead
  // event on next boot - wiping mid-grace players' progress and joining them
  // to a window that expired days earlier.
  it('marks it ended instead of activating it, and never activates it on a later tick', async () => {
    await quiesce();
    const now = Date.now();
    const evt = await makeEvent();
    await setEventStatus(evt.id, 'scheduled', { startsAt: now - 20 * DAY_MS, endsAt: now - 10 * DAY_MS });

    await runScheduler(now);
    expect((await getEvent(evt.id)).status).toBe('ended');

    // Idempotent: it must not bounce back to 'scheduled' and become a
    // candidate again on the next hourly tick.
    await runScheduler(now + 3600 * 1000);
    expect((await getEvent(evt.id)).status).toBe('ended');
  });

  it('still activates a scheduled event whose window is genuinely open', async () => {
    await quiesce();
    const now = Date.now();
    const evt = await makeEvent();
    await setEventStatus(evt.id, 'scheduled', { startsAt: now - 1000, endsAt: now + DAY_MS });

    await runScheduler(now);
    expect((await getEvent(evt.id)).status).toBe('active');
    await endEvent(evt.id, now);
  });
});

// ---------------------------------------------------------------------------
// IMPORTANT 6 - "recurring" seasonal events ran exactly once, ever
// ---------------------------------------------------------------------------

describe('runScheduler: annual recurrence re-arms after the event has ended', () => {
  it('re-schedules an ended recurring event to next year once its window is past + grace', async () => {
    await quiesce();
    // A July 1-15 recurrence that already ran in 2026 and ended.
    const evt = await makeEvent({ recurrence: { month: 7, day: 1, durationDays: 14 } });
    const ran2026Start = Date.UTC(2026, 6, 1);
    const ran2026End = ran2026Start + 14 * DAY_MS;
    await setEventStatus(evt.id, 'ended', { startsAt: ran2026Start, endsAt: ran2026End });

    // Pre-fix this stayed 'ended' with its 2026 window forever, so every
    // seasonal was permanently dead after its first year despite the README
    // promising annual materialization.
    await runScheduler(Date.UTC(2026, 8, 1));
    const rearmed = await getEvent(evt.id);
    expect(rearmed.status).toBe('scheduled');
    expect(rearmed.starts_at).toBe(Date.UTC(2027, 6, 1));
    expect(rearmed.ends_at).toBe(Date.UTC(2027, 6, 1) + 14 * DAY_MS);
  });

  it('does not re-arm inside the claim-grace settle period right after ending', async () => {
    await quiesce();
    const evt = await makeEvent({ recurrence: { month: 7, day: 1, durationDays: 14 } });
    const endedAt = Date.UTC(2026, 6, 15);
    await setEventStatus(evt.id, 'ended', { startsAt: Date.UTC(2026, 6, 1), endsAt: endedAt });

    await runScheduler(endedAt + EVENT_CLAIM_GRACE_MS - 1000);
    expect((await getEvent(evt.id)).status).toBe('ended');
  });

  it('exempts an event a coordinator ended EARLY, mid-window', async () => {
    await quiesce();
    const now = Date.UTC(2026, 6, 5);
    const evt = await makeEvent({ recurrence: { month: 7, day: 1, durationDays: 14 } });
    // Window still open (ends 2026-07-15) but the coordinator ended it now.
    await setEventStatus(evt.id, 'ended', { startsAt: Date.UTC(2026, 6, 1), endsAt: Date.UTC(2026, 6, 15) });

    await runScheduler(now);
    expect((await getEvent(evt.id)).status).toBe('ended');
    expect((await getEvent(evt.id)).starts_at).toBe(Date.UTC(2026, 6, 1));
  });

  it('skips a row whose stored recurrence is not a valid {month, day, durationDays}', async () => {
    await quiesce();
    const evt = await makeEvent({ recurrence: 'weekly' });
    await setEventStatus(evt.id, 'ended', { startsAt: Date.UTC(2026, 0, 1), endsAt: Date.UTC(2026, 0, 8) });

    await runScheduler(Date.UTC(2027, 0, 1));
    // Not re-armed with a NaN window - left alone.
    expect((await getEvent(evt.id)).status).toBe('ended');
    expect((await getEvent(evt.id)).ends_at).toBe(Date.UTC(2026, 0, 8));
  });
});

// ---------------------------------------------------------------------------
// IMPORTANT 5 - a new event activating inside a grace window destroyed
// every unclaimed rung
// ---------------------------------------------------------------------------

describe('joinEventIfEligible: superseding preserves the claim right', () => {
  function joinedState(eventId, endsAt) {
    const s = initialState();
    s.meta.stats.lifetimeFlopsAllTime = 500;
    s.meta.eventProgress = {
      eventId,
      joinedAt: endsAt - DAY_MS,
      endsAt,
      baseline: {
        flopsEarned: 0, minigamesWon: 0, blocksClaimed: 0, tapesEarned: 0, wafersEarned: 0,
      },
      rungsClaimed: [],
    };
    s.meta.pendingEventClaims = [];
    return s;
  }

  it('moves the superseded window into meta.pendingEventClaims instead of destroying it', async () => {
    await quiesce();
    const now = Date.now();
    const eventA = await makeEvent();
    const eventB = await makeEvent();
    await setEventStatus(eventA.id, 'ended', { startsAt: now - 3 * DAY_MS, endsAt: now - DAY_MS });
    await setEventStatus(eventB.id, 'scheduled', { startsAt: now - 1000, endsAt: now + DAY_MS });
    expect(await activateEvent(eventB.id, now)).toEqual({ ok: true });

    const user = await makeUser();
    // Personal window for A ended an hour ago -> still 47h of claim grace.
    const state = joinedState(eventA.id, now - 3600 * 1000);
    await joinEventIfEligible(user.id, state, now);

    expect(state.meta.eventProgress.eventId).toBe(eventB.id);
    expect(state.meta.pendingEventClaims).toHaveLength(1);
    expect(state.meta.pendingEventClaims[0].eventId).toBe(eventA.id);

    await endEvent(eventB.id, now);
  });

  it('the preserved rung is still claimable, and pays out', async () => {
    await quiesce();
    const now = Date.now();
    const eventA = await makeEvent();
    const eventB = await makeEvent();
    await setEventStatus(eventA.id, 'ended', { startsAt: now - 3 * DAY_MS, endsAt: now - DAY_MS });
    await setEventStatus(eventB.id, 'scheduled', { startsAt: now - 1000, endsAt: now + DAY_MS });
    await activateEvent(eventB.id, now);

    const user = await makeUser();
    const state = joinedState(eventA.id, now - 3600 * 1000);
    await joinEventIfEligible(user.id, state, now);

    // Exactly what stateService attaches for this player.
    const { current, pending } = await resolvePlayerEvents(state);
    const config = withDefaults({
      __claimableEvent: {
        id: current.event.id, ladder: current.event.ladder, endsAt: current.event.ends_at,
      },
      __pendingClaimables: pending.map(({ event }) => ({
        id: event.id, ladder: event.ladder, endsAt: event.ends_at,
      })),
    });

    // Pre-fix this returned not_met with eventProgress already replaced and
    // the 20 wafers gone for good.
    const { state: after, result } = applyAction(
      state, { type: 'claimEventRung', index: 0, eventId: eventA.id }, config, now,
    );
    expect(result).toMatchObject({ ok: true, rungIndex: 0, eventId: eventA.id });
    expect(result.reward.wafers).toBe(20);
    expect(after.meta.pendingEventClaims[0].rungsClaimed).toEqual([0]);
    // ...and it can't be claimed twice.
    const second = applyAction(after, { type: 'claimEventRung', index: 0, eventId: eventA.id }, config, now).result;
    expect(second).toEqual({ ok: false, error: 'invalid_target' });

    await endEvent(eventB.id, now);
  });

  // The window is FORCE-ENDED, not merely preserved: a superseded ladder must
  // stop climbing. Otherwise it keeps advancing against live meta alongside
  // the new event's ladder and a single grind pays out BOTH - spec §5.3 keeps
  // open only the rungs already qualified at the moment of the supersede.
  it('freezes the superseded ladder: rungs met only AFTER the supersede are not claimable', async () => {
    await quiesce();
    const now = Date.now();
    // Rung 0 is met at supersede time (500 lifetime FLOPS vs target 100);
    // rung 1 is nowhere near it, and only becomes met from post-supersede
    // earnings that belong entirely to the NEW event.
    const eventA = await makeEvent({
      ladder: [
        { metric: 'flopsEarned', target: 100, reward: { wafers: 20 } },
        { metric: 'flopsEarned', target: 10000, reward: { wafers: 40 } },
      ],
    });
    const eventB = await makeEvent();
    await setEventStatus(eventA.id, 'ended', { startsAt: now - 3 * DAY_MS, endsAt: now - DAY_MS });
    await setEventStatus(eventB.id, 'scheduled', { startsAt: now - 1000, endsAt: now + DAY_MS });
    await activateEvent(eventB.id, now);

    const user = await makeUser();
    const state = joinedState(eventA.id, now - 3600 * 1000);
    await joinEventIfEligible(user.id, state, now);

    const record = state.meta.pendingEventClaims[0];
    expect(record.claimableRungs).toEqual([0]);
    // Force-ended means the personal end is NOW, so grace runs from here.
    expect(record.endsAt).toBeLessThanOrEqual(now);

    // Grind 20k FLOPS entirely under event B. Rung 1 is now met on live meta.
    state.meta.stats.lifetimeFlopsAllTime += 20000;

    const { current, pending } = await resolvePlayerEvents(state);
    const config = withDefaults({
      __claimableEvent: {
        id: current.event.id, ladder: current.event.ladder, endsAt: current.event.ends_at,
      },
      __pendingClaimables: pending.map(({ event }) => ({
        id: event.id, ladder: event.ladder, endsAt: event.ends_at,
      })),
    });

    const late = applyAction(
      state, { type: 'claimEventRung', index: 1, eventId: eventA.id }, config, now,
    ).result;
    expect(late).toEqual({ ok: false, error: 'not_met' });

    // The rung that WAS qualified still pays, exactly once.
    const early = applyAction(
      state, { type: 'claimEventRung', index: 0, eventId: eventA.id }, config, now,
    ).result;
    expect(early).toMatchObject({ ok: true, rungIndex: 0, eventId: eventA.id });

    await endEvent(eventB.id, now);
  });

  it('drops a superseded window whose own grace has already run out', async () => {
    await quiesce();
    const now = Date.now();
    const eventA = await makeEvent();
    const eventB = await makeEvent();
    await setEventStatus(eventB.id, 'scheduled', { startsAt: now - 1000, endsAt: now + DAY_MS });
    await activateEvent(eventB.id, now);

    const user = await makeUser();
    const state = joinedState(eventA.id, now - EVENT_CLAIM_GRACE_MS - DAY_MS);
    await joinEventIfEligible(user.id, state, now);

    expect(state.meta.pendingEventClaims).toEqual([]);
    await endEvent(eventB.id, now);
  });

  it('prunes pending records once their grace lapses, on a later load', async () => {
    await quiesce();
    const now = Date.now();
    const user = await makeUser();
    const evt = await makeEvent();
    const state = initialState();
    state.meta.pendingEventClaims = [{
      eventId: evt.id, joinedAt: now - DAY_MS, endsAt: now - 1000, baseline: {}, rungsClaimed: [],
    }];

    await joinEventIfEligible(user.id, state, now);
    expect(state.meta.pendingEventClaims).toHaveLength(1);

    await joinEventIfEligible(user.id, state, now + EVENT_CLAIM_GRACE_MS + 1000);
    expect(state.meta.pendingEventClaims).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ALSO REQUIRED - recurrence shape validation
// ---------------------------------------------------------------------------

describe('validateRecurrence', () => {
  it('accepts null/undefined (no recurrence at all)', async () => {
    expect(validateRecurrence(null)).toEqual({ ok: true });
    expect(validateRecurrence(undefined)).toEqual({ ok: true });
  });

  it('accepts a well-formed annual recurrence', async () => {
    expect(validateRecurrence({ month: 7, day: 1, durationDays: 14 })).toEqual({ ok: true });
  });

  it('rejects the shapes that permanently stranded an event', async () => {
    // `{}` and a bare string both promoted the event to 'scheduled' with a
    // NaN window it could never leave (DELETE is draft-only, activate answers
    // not_scheduled).
    expect(validateRecurrence({}).ok).toBe(false);
    expect(validateRecurrence('weekly').ok).toBe(false);
    expect(validateRecurrence([]).ok).toBe(false);
    // Negative duration materialized endsAt < startsAt - an instantly-expired
    // personal window for every joiner.
    expect(validateRecurrence({ month: 7, day: 1, durationDays: -5 }).ok).toBe(false);
    expect(validateRecurrence({ month: 13, day: 1, durationDays: 5 }).ok).toBe(false);
    expect(validateRecurrence({ month: 7, day: 0, durationDays: 5 }).ok).toBe(false);
    expect(validateRecurrence({ month: 7, day: 1, durationDays: 1.5 }).ok).toBe(false);
  });

  it('rejects an authoring typo rather than silently defaulting it to NaN', async () => {
    const res = validateRecurrence({ month: 7, day: 1, durationDay: 14 });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('durationDay'))).toBe(true);
  });
});
