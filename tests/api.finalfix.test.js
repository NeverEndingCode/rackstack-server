// Route-level regressions for the v1.4 whole-branch final review's CRITICAL
// findings. These pin the SERVER halves; the client halves (what actually
// renders after a reload, what the client predicts, whether a claim confirms)
// are covered in tests/e2e/smoke-v14.mjs, because asserting only through the
// API is precisely how all six of these shipped green.
process.env.JWT_SECRET = 'test-secret-for-supertest-finalfix';
process.env.DB_PATH = ':memory:';
process.env.SUPER_ADMIN_IDS = 'test:finalfix-owner';

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { buildApp } = await import('../server/app.js');
const { ensureConfig } = await import('../server/configService.js');
const {
  upsertUser, setRoles, putEvent, setEventStatus, getSave, putSave,
} = await import('../server/db.js');
const { COOKIE_NAME } = await import('../server/auth.js');
const { activateEvent, endEvent } = await import('../server/eventService.js');

ensureConfig();
const app = buildApp();

const DAY_MS = 24 * 60 * 60 * 1000;
let seq = 0;

function makeUser() {
  seq += 1;
  return upsertUser({
    provider: 'discord', providerId: `ffa${seq}`, username: `ffauser${seq}`, avatarUrl: null,
  });
}

function makeCoordinator() {
  const u = makeUser();
  setRoles(u.id, ['event_coordinator']);
  return u;
}

function makeAdmin() {
  const u = makeUser();
  setRoles(u.id, ['admin']);
  return u;
}

function cookieFor(user) {
  const token = jwt.sign(
    { sub: user.id, username: user.username, avatarUrl: user.avatar_url },
    process.env.JWT_SECRET,
    { expiresIn: '90d' },
  );
  return `${COOKIE_NAME}=${token}`;
}

function makeEvent(overrides = {}) {
  seq += 1;
  return putEvent({
    id: `ffa-evt-${seq}`,
    name: `Final Fix API Event ${seq}`,
    description: 'desc',
    theme: null,
    modifiers: [],
    ladder: [
      { metric: 'flopsEarned', target: 100, reward: { wafers: 20 } },
      { metric: 'flopsEarned', target: 10000000, reward: { wafers: 5 } },
    ],
    status: 'draft',
    recurrence: null,
    createdAt: Date.now(),
    createdBy: null,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// CRITICAL 1 - the 48h claim grace was unreachable through the UI
// ---------------------------------------------------------------------------

describe('GET /api/event and GET /api/state during the post-end claim grace', () => {
  it('still serves the ladder, progress and a claimable rung after the event ends globally', async () => {
    const now = Date.now();
    const user = makeUser();
    const evt = makeEvent();
    setEventStatus(evt.id, 'scheduled', { startsAt: now - 1000, endsAt: now + DAY_MS });
    activateEvent(evt.id, now);

    // Join, then earn enough to meet rung 0.
    await request(app).get('/api/event').set('Cookie', cookieFor(user));
    const row = getSave(user.id);
    const data = JSON.parse(row.data);
    data.meta.stats.lifetimeFlopsAllTime += 300;
    putSave(user.id, data, Date.now());

    // The event ends globally. The player's personal window (and its 48h
    // grace) is untouched.
    endEvent(evt.id, Date.now());

    // Pre-fix this returned { event: null, progress: null, leaderboard: [] }
    // because the route gated the entire response on getActiveEvent(), so a
    // client that reloaded here had no ladder and no Claim buttons - ever.
    const res = await request(app).get('/api/event').set('Cookie', cookieFor(user));
    expect(res.status).toBe(200);
    expect(res.body.event).toBeTruthy();
    expect(res.body.event.id).toBe(evt.id);
    expect(res.body.event.ladder).toHaveLength(2);
    expect(res.body.progress).toBeTruthy();
    expect(res.body.progress.rungs[0].met).toBe(true);
    expect(res.body.progress.rungs[0].claimed).toBe(false);

    // GET /api/state carries the same identity, so a cold page load inside
    // grace can seed the ladder without a second round trip.
    const state = await request(app).get('/api/state').set('Cookie', cookieFor(user));
    expect(state.body.activeEvent).toBeNull();
    expect(state.body.claimableEvent).toBeTruthy();
    expect(state.body.claimableEvent.id).toBe(evt.id);
    expect(state.body.claimableEvent.ladder).toHaveLength(2);

    // And the claim the UI can now offer actually works.
    const claim = await request(app)
      .post('/api/actions')
      .set('Cookie', cookieFor(user))
      .send({ actions: [{ _cid: 1, type: 'claimEventRung', index: 0, eventId: evt.id }] });
    expect(claim.body.results[0]).toMatchObject({ ok: true, rungIndex: 0, eventId: evt.id });
    expect(claim.body.results[0].reward.wafers).toBe(20);
  });

  it('reports no event once the grace window itself has lapsed', async () => {
    const now = Date.now();
    const user = makeUser();
    const evt = makeEvent();
    setEventStatus(evt.id, 'scheduled', { startsAt: now - 1000, endsAt: now + DAY_MS });
    activateEvent(evt.id, now);
    await request(app).get('/api/event').set('Cookie', cookieFor(user));
    endEvent(evt.id, Date.now());

    // Push the personal window (and its grace) fully into the past.
    const row = getSave(user.id);
    const data = JSON.parse(row.data);
    data.meta.eventProgress.endsAt = Date.now() - 100 * DAY_MS;
    putSave(user.id, data, Date.now());

    const res = await request(app).get('/api/event').set('Cookie', cookieFor(user));
    expect(res.body.event).toBeNull();
    const state = await request(app).get('/api/state').set('Cookie', cookieFor(user));
    expect(state.body.claimableEvent).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CRITICAL 2 - the client ran the whole game on the un-overlaid config
// ---------------------------------------------------------------------------

describe('GET /api/config (gameplay) vs GET /api/admin/config (baseline)', () => {
  it('serves the event-overlaid config to players and the untouched baseline to admins', async () => {
    const now = Date.now();
    const player = makeUser();
    const admin = makeAdmin();
    const evt = makeEvent({
      modifiers: [
        { path: 'production.gridMult', value: 3 },
        { path: 'heat.capacity', value: 4000 },
      ],
    });
    setEventStatus(evt.id, 'scheduled', { startsAt: now - 1000, endsAt: now + DAY_MS });
    activateEvent(evt.id, now);

    // Pre-fix BOTH of these read the baseline, so the client predicted
    // production from gridMult 1 while the server used 3, and crossed its own
    // stale 2000-heat cap into a false "Overheated!" meltdown while the
    // server saw a healthy rack at capacity 4000.
    const gameplay = await request(app).get('/api/config').set('Cookie', cookieFor(player));
    expect(gameplay.status).toBe(200);
    expect(gameplay.body.data.production.gridMult).toBe(3);
    expect(gameplay.body.data.heat.capacity).toBe(4000);
    expect(gameplay.body.activeEventId).toBe(evt.id);

    // The runtime-only field must never reach the client (it is not part of
    // the tunables schema - validateConfig rejects it).
    expect(gameplay.body.data.__activeEvent).toBeUndefined();
    expect(Object.keys(gameplay.body.data).some((k) => k.startsWith('__'))).toBe(false);
    expect(gameplay.body.data.__claimableEvent).toBeUndefined();

    const baseline = await request(app).get('/api/admin/config').set('Cookie', cookieFor(admin));
    expect(baseline.status).toBe(200);
    expect(baseline.body.data.production.gridMult).toBe(1);
    expect(baseline.body.data.heat.capacity).toBe(2000);

    endEvent(evt.id, Date.now());

    // Once the event ends, the gameplay read falls back to the baseline and
    // its cache key changes - which is the client's refetch signal, since the
    // config VERSION never moved through any of this.
    const after = await request(app).get('/api/config').set('Cookie', cookieFor(player));
    expect(after.body.data.production.gridMult).toBe(1);
    expect(after.body.activeEventId).toBeNull();
    expect(after.body.version).toBe(gameplay.body.version);
  });

  it('gates the baseline route on admin', async () => {
    const plain = makeUser();
    const res = await request(app).get('/api/admin/config').set('Cookie', cookieFor(plain));
    expect(res.status).toBe(403);
  });

  it('an admin round-tripping the baseline never bakes event modifiers into the stored config', async () => {
    const now = Date.now();
    const admin = makeAdmin();
    const evt = makeEvent({ modifiers: [{ path: 'production.gridMult', value: 3 }] });
    setEventStatus(evt.id, 'scheduled', { startsAt: now - 1000, endsAt: now + DAY_MS });
    activateEvent(evt.id, now);

    const loaded = await request(app).get('/api/admin/config').set('Cookie', cookieFor(admin));
    const saved = await request(app)
      .put('/api/admin/config')
      .set('Cookie', cookieFor(admin))
      .send({ data: loaded.body.data });
    expect(saved.status).toBe(200);

    endEvent(evt.id, Date.now());

    const stored = await request(app).get('/api/admin/config').set('Cookie', cookieFor(admin));
    expect(stored.body.data.production.gridMult).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ALSO REQUIRED - recurrence shape validation on POST
// ---------------------------------------------------------------------------

describe('POST /api/admin/events: recurrence validation', () => {
  function body(overrides = {}) {
    seq += 1;
    return {
      id: `ffa-rec-${seq}`,
      name: 'Recurring',
      modifiers: [],
      ladder: [{ metric: 'flopsEarned', target: 100, reward: { wafers: 5 } }],
      ...overrides,
    };
  }

  it('accepts a well-formed annual recurrence', async () => {
    const coord = makeCoordinator();
    const res = await request(app)
      .post('/api/admin/events')
      .set('Cookie', cookieFor(coord))
      .send(body({ recurrence: { month: 7, day: 1, durationDays: 14 } }));
    expect(res.status).toBe(201);
  });

  it('rejects shapes that would strand the event or expire it instantly', async () => {
    const coord = makeCoordinator();
    for (const recurrence of [{}, 'weekly', [], { month: 7, day: 1, durationDays: -5 }, { month: 0, day: 1, durationDays: 5 }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .post('/api/admin/events')
        .set('Cookie', cookieFor(coord))
        .send(body({ recurrence }));
      expect(res.status).toBe(400);
      expect(Array.isArray(res.body.errors)).toBe(true);
    }
  });

  it('still accepts an event with no recurrence at all', async () => {
    const coord = makeCoordinator();
    const res = await request(app)
      .post('/api/admin/events')
      .set('Cookie', cookieFor(coord))
      .send(body());
    expect(res.status).toBe(201);
  });
});
