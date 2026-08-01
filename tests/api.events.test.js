process.env.JWT_SECRET = 'test-secret-for-supertest-events';
process.env.SUPER_ADMIN_IDS = 'test:events-owner';

import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { provisionDatabase } from './helpers/backend.js';

// Provision before importing the facade: DATABASE_URL/DB_PATH must be set
// before the dynamic import below, since the facade resolves its driver at
// module-evaluation time - same trick as tests/api.test.js.
const provisioned = await provisionDatabase();

const { buildApp } = await import('../server/app.js');
const { ensureConfig, getEffectiveConfig } = await import('../server/configService.js');
const { upsertUser, setRoles, driver } = await import('../server/db.js');
const { COOKIE_NAME } = await import('../server/auth.js');

await ensureConfig();
const app = buildApp();

afterAll(async () => {
  if (driver.__backend === 'pg') await driver.__raw.end();
  await provisioned.cleanup();
});

let seq = 0;
async function makeUser(overrides = {}) {
  seq += 1;
  return await upsertUser({
    provider: 'discord',
    providerId: `ev${seq}`,
    username: `evuser${seq}`,
    avatarUrl: null,
    ...overrides,
  });
}

async function makeCoordinator() {
  const u = await makeUser();
  await setRoles(u.id, ['event_coordinator']);
  return u;
}

function tokenFor(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, avatarUrl: user.avatar_url },
    process.env.JWT_SECRET,
    { expiresIn: '90d' },
  );
}

function cookieFor(user) {
  return `${COOKIE_NAME}=${tokenFor(user)}`;
}

// Valid per shared/configSchema.js's TUNABLES ranges - mirrors the fixture
// shape used in tests/eventService.test.js and tests/db.events.test.js.
function sampleBody(overrides = {}) {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    name: 'Test Event',
    description: 'A test event',
    theme: { icon: '🧪', color: '#123456' },
    modifiers: [{ path: 'production.gridMult', value: 3 }],
    ladder: [
      { metric: 'flopsEarned', target: 100, reward: { wafers: 5 } },
      { metric: 'flopsEarned', target: 500, reward: { wafers: 10 } },
    ],
    ...overrides,
  };
}

async function createEvent(coordinator, overrides = {}) {
  const res = await request(app)
    .post('/api/admin/events')
    .set('Cookie', cookieFor(coordinator))
    .send(sampleBody(overrides));
  expect(res.status).toBe(201);
  return res.body.event;
}

async function scheduleEvent(coordinator, id, { startsAt, endsAt }) {
  const res = await request(app)
    .post(`/api/admin/events/${id}/schedule`)
    .set('Cookie', cookieFor(coordinator))
    .send({ startsAt, endsAt });
  expect(res.status).toBe(200);
  return res.body.event;
}

async function activateEventReq(coordinator, id) {
  return request(app)
    .post(`/api/admin/events/${id}/activate`)
    .set('Cookie', cookieFor(coordinator));
}

async function endEventReq(coordinator, id) {
  return request(app)
    .post(`/api/admin/events/${id}/end`)
    .set('Cookie', cookieFor(coordinator));
}

// ---------------------------------------------------------------------------
// Must run before anything else activates an event - "nothing active" is
// only guaranteed here, at the very top (same convention as
// tests/eventService.test.js's "no active event (must run first)" block).
// ---------------------------------------------------------------------------

describe('GET /api/event (no active event, must run first)', () => {
  it('returns event: null, progress: null, leaderboard: [] when nothing is active', async () => {
    const user = await makeUser();
    const res = await request(app).get('/api/event').set('Cookie', cookieFor(user));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      event: null, progress: null, leaderboard: [], pendingClaims: [],
    });
  });
});

describe('coordinator gating: every admin event route 403s for a non-coordinator', () => {
  it('403s across the board', async () => {
    const plain = await makeUser();
    const coordinator = await makeCoordinator();
    const event = await createEvent(coordinator);

    const attempts = [
      request(app).get('/api/admin/events').set('Cookie', cookieFor(plain)),
      request(app).post('/api/admin/events').set('Cookie', cookieFor(plain)).send(sampleBody()),
      request(app).put(`/api/admin/events/${event.id}`).set('Cookie', cookieFor(plain)).send({ name: 'x' }),
      request(app).delete(`/api/admin/events/${event.id}`).set('Cookie', cookieFor(plain)),
      request(app).post(`/api/admin/events/${event.id}/schedule`).set('Cookie', cookieFor(plain)).send({ startsAt: 1, endsAt: 2 }),
      request(app).post(`/api/admin/events/${event.id}/activate`).set('Cookie', cookieFor(plain)),
      request(app).post(`/api/admin/events/${event.id}/end`).set('Cookie', cookieFor(plain)),
      request(app).get(`/api/admin/events/${event.id}/participation`).set('Cookie', cookieFor(plain)),
    ];

    const results = await Promise.all(attempts);
    for (const res of results) {
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('forbidden');
    }
  });

  it('401s without auth at all', async () => {
    const res = await request(app).get('/api/admin/events');
    expect(res.status).toBe(401);
  });
});

describe('coordinator lifecycle: create -> schedule -> activate -> end', () => {
  it('walks the full happy path and is reflected in GET /api/event for a player', async () => {
    const coordinator = await makeCoordinator();
    const now = Date.now();

    const created = await createEvent(coordinator, { id: 'lifecycle-evt' });
    expect(created.status).toBe('draft');
    expect(created.starts_at).toBeNull();
    expect(created.ends_at).toBeNull();

    const scheduled = await scheduleEvent(coordinator, 'lifecycle-evt', {
      startsAt: now - 1000,
      endsAt: now + 100000,
    });
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.starts_at).toBe(now - 1000);
    expect(scheduled.ends_at).toBe(now + 100000);

    const activateRes = await activateEventReq(coordinator, 'lifecycle-evt');
    expect(activateRes.status).toBe(200);
    expect(activateRes.body.event.status).toBe('active');

    const player = await makeUser();
    const playerRes = await request(app).get('/api/event').set('Cookie', cookieFor(player));
    expect(playerRes.status).toBe(200);
    expect(playerRes.body.event).toMatchObject({
      id: 'lifecycle-evt',
      name: 'Test Event',
    });
    expect(playerRes.body.event.ladder).toHaveLength(2);
    expect(playerRes.body.progress).toBeTruthy();
    expect(playerRes.body.progress.rungsClaimed).toEqual([]);
    expect(playerRes.body.progress.rungs).toHaveLength(2);
    expect(playerRes.body.leaderboard).toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: player.id })]),
    );

    const endRes = await endEventReq(coordinator, 'lifecycle-evt');
    expect(endRes.status).toBe(200);
    expect(endRes.body.event.status).toBe('ended');
  });

  it('GET /api/admin/events lists events with participation counts', async () => {
    const coordinator = await makeCoordinator();
    const created = await createEvent(coordinator);
    const res = await request(app).get('/api/admin/events').set('Cookie', cookieFor(coordinator));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    const found = res.body.events.find((e) => e.id === created.id);
    expect(found).toBeTruthy();
    expect(found.participationCount).toBe(0);
  });

  it('GET /api/admin/events/:id/participation returns the coordinator view', async () => {
    const coordinator = await makeCoordinator();
    const created = await createEvent(coordinator);
    const res = await request(app)
      .get(`/api/admin/events/${created.id}/participation`)
      .set('Cookie', cookieFor(coordinator));
    expect(res.status).toBe(200);
    expect(res.body.participation).toEqual([]);
  });
});

describe('activating a second event while one is active -> 409', () => {
  it('rejects; ending the first, then activating the second, succeeds', async () => {
    const coordinator = await makeCoordinator();
    const now = Date.now();

    await createEvent(coordinator, { id: 'conflict-a' });
    await scheduleEvent(coordinator, 'conflict-a', { startsAt: now - 1000, endsAt: now + 100000 });
    const activateA = await activateEventReq(coordinator, 'conflict-a');
    expect(activateA.status).toBe(200);

    await createEvent(coordinator, { id: 'conflict-b' });
    await scheduleEvent(coordinator, 'conflict-b', { startsAt: now - 1000, endsAt: now + 100000 });
    const activateB = await activateEventReq(coordinator, 'conflict-b');
    expect(activateB.status).toBe(409);
    expect(activateB.body.error).toBe('event_active');

    const endA = await endEventReq(coordinator, 'conflict-a');
    expect(endA.status).toBe(200);

    const activateBAgain = await activateEventReq(coordinator, 'conflict-b');
    expect(activateBAgain.status).toBe(200);
    expect(activateBAgain.body.event.status).toBe('active');

    // Clean up so later tests see "nothing active" again.
    await endEventReq(coordinator, 'conflict-b');
  });
});

describe('rejecting activation of an event whose window has already fully passed (hard requirement 2)', () => {
  it('400s with invalid_target rather than activating with an already-expired window', async () => {
    const coordinator = await makeCoordinator();
    const now = Date.now();

    await createEvent(coordinator, { id: 'past-window' });
    await scheduleEvent(coordinator, 'past-window', {
      startsAt: now - 100000,
      endsAt: now - 1000, // already fully elapsed
    });

    const res = await activateEventReq(coordinator, 'past-window');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_target');
  });
});

describe('editing an active event (ladder/modifiers locked, cache invalidation on window edit)', () => {
  it('rejects ladder/modifiers edits on an active event with 409, but allows name edits', async () => {
    const coordinator = await makeCoordinator();
    const now = Date.now();

    await createEvent(coordinator, { id: 'edit-locked' });
    await scheduleEvent(coordinator, 'edit-locked', { startsAt: now - 1000, endsAt: now + 100000 });
    await activateEventReq(coordinator, 'edit-locked');

    const ladderEdit = await request(app)
      .put('/api/admin/events/edit-locked')
      .set('Cookie', cookieFor(coordinator))
      .send({ ladder: [{ metric: 'flopsEarned', target: 999, reward: { wafers: 1 } }] });
    expect(ladderEdit.status).toBe(409);
    expect(ladderEdit.body.error).toBe('event_active');

    const modifiersEdit = await request(app)
      .put('/api/admin/events/edit-locked')
      .set('Cookie', cookieFor(coordinator))
      .send({ modifiers: [{ path: 'production.gridMult', value: 5 }] });
    expect(modifiersEdit.status).toBe(409);
    expect(modifiersEdit.body.error).toBe('event_active');

    const nameEdit = await request(app)
      .put('/api/admin/events/edit-locked')
      .set('Cookie', cookieFor(coordinator))
      .send({ name: 'Renamed While Active' });
    expect(nameEdit.status).toBe(200);
    expect(nameEdit.body.event.name).toBe('Renamed While Active');

    await endEventReq(coordinator, 'edit-locked');
  });

  it('invalidates the effective-config cache when an active event window edit changes endsAt (hard requirement 3)', async () => {
    const coordinator = await makeCoordinator();
    const now = Date.now();

    await createEvent(coordinator, { id: 'cache-invalidate' });
    await scheduleEvent(coordinator, 'cache-invalidate', { startsAt: now - 1000, endsAt: now + 100000 });
    await activateEventReq(coordinator, 'cache-invalidate');

    // Populate the effective-config cache with the original endsAt.
    const before = await getEffectiveConfig();
    expect(before.data.__activeEvent.id).toBe('cache-invalidate');
    expect(before.data.__activeEvent.endsAt).toBe(now + 100000);

    const newEndsAt = now + 500000;
    const windowEdit = await request(app)
      .put('/api/admin/events/cache-invalidate')
      .set('Cookie', cookieFor(coordinator))
      .send({ startsAt: now - 1000, endsAt: newEndsAt });
    expect(windowEdit.status).toBe(200);

    const after = await getEffectiveConfig();
    expect(after.data.__activeEvent.endsAt).toBe(newEndsAt);

    await endEventReq(coordinator, 'cache-invalidate');
  });
});

describe('deleting a non-draft event -> 409', () => {
  it('rejects deleting a scheduled event, allows deleting a draft', async () => {
    const coordinator = await makeCoordinator();
    const now = Date.now();

    const scheduled = await createEvent(coordinator, { id: 'delete-scheduled' });
    await scheduleEvent(coordinator, scheduled.id, { startsAt: now + 10000, endsAt: now + 100000 });
    const delRes = await request(app)
      .delete(`/api/admin/events/${scheduled.id}`)
      .set('Cookie', cookieFor(coordinator));
    expect(delRes.status).toBe(409);
    expect(delRes.body.error).toBe('not_draft');

    const draft = await createEvent(coordinator, { id: 'delete-draft' });
    const delDraft = await request(app)
      .delete(`/api/admin/events/${draft.id}`)
      .set('Cookie', cookieFor(coordinator));
    expect(delDraft.status).toBe(200);

    const getAfter = await request(app)
      .get('/api/admin/events')
      .set('Cookie', cookieFor(coordinator));
    expect(getAfter.body.events.find((e) => e.id === 'delete-draft')).toBeUndefined();
  });
});

describe('POST /api/admin/events validation', () => {
  it('400s with errors[] for invalid modifiers', async () => {
    const coordinator = await makeCoordinator();
    const res = await request(app)
      .post('/api/admin/events')
      .set('Cookie', cookieFor(coordinator))
      .send(sampleBody({ modifiers: [{ path: 'not.a.real.path', value: 1 }] }));
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  it('400s with errors[] for invalid ladder', async () => {
    const coordinator = await makeCoordinator();
    const res = await request(app)
      .post('/api/admin/events')
      .set('Cookie', cookieFor(coordinator))
      .send(sampleBody({ ladder: [{ metric: 'not-a-metric', target: 1, reward: { wafers: 1 } }] }));
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  it('409s on a duplicate id', async () => {
    const coordinator = await makeCoordinator();
    await createEvent(coordinator, { id: 'dup-id' });
    const res = await request(app)
      .post('/api/admin/events')
      .set('Cookie', cookieFor(coordinator))
      .send(sampleBody({ id: 'dup-id' }));
    expect(res.status).toBe(409);
  });

  it('400s on a non-slug-safe id', async () => {
    const coordinator = await makeCoordinator();
    const res = await request(app)
      .post('/api/admin/events')
      .set('Cookie', cookieFor(coordinator))
      .send(sampleBody({ id: 'Not A Slug!' }));
    expect(res.status).toBe(400);
  });
});

describe('leaderboard opt-out must be live, not snapshot-only (hard requirement 1)', () => {
  it('a user who opts out AFTER joining an active event vanishes from the leaderboard', async () => {
    const coordinator = await makeCoordinator();
    const now = Date.now();

    await createEvent(coordinator, { id: 'optout-evt' });
    await scheduleEvent(coordinator, 'optout-evt', { startsAt: now - 1000, endsAt: now + 100000 });
    await activateEventReq(coordinator, 'optout-evt');

    const alice = await makeUser();
    const bob = await makeUser();

    // Both join by hitting a state-reading route.
    await request(app).get('/api/event').set('Cookie', cookieFor(alice));
    await request(app).get('/api/event').set('Cookie', cookieFor(bob));

    let lb = await request(app).get('/api/event').set('Cookie', cookieFor(alice));
    expect(lb.body.leaderboard.map((r) => r.userId)).toEqual(
      expect.arrayContaining([alice.id, bob.id]),
    );

    // Bob opts out AFTER already having joined.
    const optOutRes = await request(app)
      .put('/api/me/leaderboard-opt-out')
      .set('Cookie', cookieFor(bob))
      .send({ optOut: true });
    expect(optOutRes.status).toBe(200);

    lb = await request(app).get('/api/event').set('Cookie', cookieFor(alice));
    const ids = lb.body.leaderboard.map((r) => r.userId);
    expect(ids).toContain(alice.id);
    expect(ids).not.toContain(bob.id);

    await endEventReq(coordinator, 'optout-evt');
  });
});

describe('PUT /api/me/leaderboard-opt-out', () => {
  it('400s on a non-boolean optOut', async () => {
    const user = await makeUser();
    const res = await request(app)
      .put('/api/me/leaderboard-opt-out')
      .set('Cookie', cookieFor(user))
      .send({ optOut: 'yes' });
    expect(res.status).toBe(400);
  });

  it('401s without auth', async () => {
    const res = await request(app).put('/api/me/leaderboard-opt-out').send({ optOut: true });
    expect(res.status).toBe(401);
  });
});
