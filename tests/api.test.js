process.env.JWT_SECRET = 'test-secret-for-supertest';
process.env.DB_PATH = ':memory:';
process.env.SUPER_ADMIN_IDS = 'test:owner';

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';

// Dynamic imports: server/auth.js reads JWT_SECRET (and server/db.js reads
// DB_PATH) at module-evaluation time. Static imports get hoisted above the
// process.env assignments above per ES module semantics, so - same trick as
// tests/db.test.js - these have to be dynamic to see the env vars set here.
const { buildApp } = await import('../server/app.js');
const { ensureConfig } = await import('../server/configService.js');
const { upsertUser, putSave, setRoles } = await import('../server/db.js');
const { COOKIE_NAME } = await import('../server/auth.js');

const v11Fixture = JSON.parse(readFileSync(new URL('./fixtures/v11-save.json', import.meta.url)));

ensureConfig();
const app = buildApp();

let seq = 0;
function makeUser(overrides = {}) {
  seq += 1;
  return upsertUser({
    provider: 'discord',
    providerId: `u${seq}`,
    username: `user${seq}`,
    avatarUrl: null,
    ...overrides,
  });
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

describe('GET /api/state', () => {
  it('migrates a v1.1-shape save into canonical state, preserving credits/wafers', async () => {
    const user = makeUser();
    putSave(user.id, v11Fixture, Date.now());

    const res = await request(app).get('/api/state').set('Cookie', cookieFor(user));

    expect(res.status).toBe(200);
    expect(res.body.run.credits).toBe(123);
    expect(res.body.run.tiers).toHaveLength(14); // padded to full defs
    expect(res.body.meta.wafers).toBe(7);
    expect(res.body.server.gameCooldowns).toEqual({ rush: 0, debug: 0, match: 0, balance: 0 });
    expect(res.body.configVersion).toBeTypeOf('number');
    expect(res.body.serverTime).toBeTypeOf('number');
  });

  it('401s without a cookie', async () => {
    const res = await request(app).get('/api/state');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/actions', () => {
  it('400s when actions is not an array', async () => {
    const user = makeUser();
    const res = await request(app)
      .post('/api/actions')
      .set('Cookie', cookieFor(user))
      .send({ actions: 'nope' });
    expect(res.status).toBe(400);
  });

  it('400s when actions has more than 100 entries', async () => {
    const user = makeUser();
    const actions = Array.from({ length: 101 }, (_, i) => ({ id: i, type: 'collectAll' }));
    const res = await request(app)
      .post('/api/actions')
      .set('Cookie', cookieFor(user))
      .send({ actions });
    expect(res.status).toBe(400);
  });

  it('buy path mutates canon; a second identical unaffordable buy fails without undoing the first', async () => {
    const user = makeUser(); // fresh state: credits = 10

    const res = await request(app)
      .post('/api/actions')
      .set('Cookie', cookieFor(user))
      .send({
        actions: [
          { id: 'a1', type: 'buy', lane: 'tiers', index: 0, mode: 'max' },
          { id: 'a2', type: 'buy', lane: 'tiers', index: 0, mode: 'max' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0]).toMatchObject({ id: 'a1', ok: true });
    expect(res.body.results[1]).toMatchObject({ id: 'a2', ok: false, error: 'insufficient_credits' });
    // the first buy's effect stuck: tier 0 owned went up, credits dropped from 10.
    expect(res.body.state.run.tiers[0].owned).toBeGreaterThan(0);
    expect(res.body.state.run.credits).toBeLessThan(10);
  });
});

describe('config: admin gating and owner bump', () => {
  it('non-admin PUT /api/admin/config -> 403', async () => {
    const user = makeUser();
    const res = await request(app)
      .put('/api/admin/config')
      .set('Cookie', cookieFor(user))
      .send({ data: DEFAULT_CONFIG });
    expect(res.status).toBe(403);
  });

  it('owner (via SUPER_ADMIN_IDS) can update config, and GET /api/config reflects the bump', async () => {
    const owner = upsertUser({ provider: 'test', providerId: 'owner', username: 'owner', avatarUrl: null });
    const before = await request(app).get('/api/config').set('Cookie', cookieFor(owner));
    const nextData = structuredClone(DEFAULT_CONFIG);
    nextData.heat.capacity = 2500;

    const putRes = await request(app)
      .put('/api/admin/config')
      .set('Cookie', cookieFor(owner))
      .send({ data: nextData });
    expect(putRes.status).toBe(200);
    expect(putRes.body.version).toBe(before.body.version + 1);

    const after = await request(app).get('/api/config').set('Cookie', cookieFor(owner));
    expect(after.body.version).toBe(before.body.version + 1);
    expect(after.body.data.heat.capacity).toBe(2500);
  });

  it('PUT /api/admin/config with an invalid doc -> 400 with errors[]', async () => {
    const owner = upsertUser({ provider: 'test', providerId: 'owner', username: 'owner', avatarUrl: null });
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.heat.capacity = -5;
    const res = await request(app)
      .put('/api/admin/config')
      .set('Cookie', cookieFor(owner))
      .send({ data: bad });
    expect(res.status).toBe(400);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });
});

describe('roles', () => {
  it('a non-owner admin cannot grant the admin role (owner-only) -> 403', async () => {
    const admin = makeUser();
    setRoles(admin.id, ['admin']);
    const target = makeUser();

    const res = await request(app)
      .post('/api/admin/roles')
      .set('Cookie', cookieFor(admin))
      .send({ userId: target.id, role: 'admin', op: 'grant' });
    expect(res.status).toBe(403);
  });

  it('a non-admin cannot use the roles endpoint at all -> 403', async () => {
    const user = makeUser();
    const target = makeUser();
    const res = await request(app)
      .post('/api/admin/roles')
      .set('Cookie', cookieFor(user))
      .send({ userId: target.id, role: 'event_coordinator', op: 'grant' });
    expect(res.status).toBe(403);
  });

  it('a non-owner admin CAN grant event_coordinator', async () => {
    const admin = makeUser();
    setRoles(admin.id, ['admin']);
    const target = makeUser();

    const res = await request(app)
      .post('/api/admin/roles')
      .set('Cookie', cookieFor(admin))
      .send({ userId: target.id, role: 'event_coordinator', op: 'grant' });
    expect(res.status).toBe(200);
    expect(res.body.roles).toContain('event_coordinator');
  });

  it('owner can grant admin', async () => {
    const owner = upsertUser({ provider: 'test', providerId: 'owner', username: 'owner', avatarUrl: null });
    const target = makeUser();
    const res = await request(app)
      .post('/api/admin/roles')
      .set('Cookie', cookieFor(owner))
      .send({ userId: target.id, role: 'admin', op: 'grant' });
    expect(res.status).toBe(200);
    expect(res.body.roles).toContain('admin');
  });

  it('unknown role -> 400', async () => {
    const owner = upsertUser({ provider: 'test', providerId: 'owner', username: 'owner', avatarUrl: null });
    const target = makeUser();
    const res = await request(app)
      .post('/api/admin/roles')
      .set('Cookie', cookieFor(owner))
      .send({ userId: target.id, role: 'superuser', op: 'grant' });
    expect(res.status).toBe(400);
  });

  it('cannot modify a super-admin id -> 400', async () => {
    const owner = upsertUser({ provider: 'test', providerId: 'owner', username: 'owner', avatarUrl: null });
    const res = await request(app)
      .post('/api/admin/roles')
      .set('Cookie', cookieFor(owner))
      .send({ userId: owner.id, role: 'event_coordinator', op: 'revoke' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/me/username', () => {
  it('sets a valid username -> 200, then a case-insensitive collision from another user -> 409', async () => {
    const u1 = makeUser();
    const u2 = makeUser();

    const res1 = await request(app)
      .put('/api/me/username')
      .set('Cookie', cookieFor(u1))
      .send({ username: 'CoolName123' });
    expect(res1.status).toBe(200);

    const res2 = await request(app)
      .put('/api/me/username')
      .set('Cookie', cookieFor(u2))
      .send({ username: 'coolname123' });
    expect(res2.status).toBe(409);
    expect(res2.body.error).toBe('taken');
  });

  it('rejects an invalid username shape -> 400', async () => {
    const user = makeUser();
    const res = await request(app)
      .put('/api/me/username')
      .set('Cookie', cookieFor(user))
      .send({ username: 'no spaces allowed' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_username');
  });
});

describe('minigames', () => {
  it('start -> finish pays clamped wafers; a second start within cooldown -> 429', async () => {
    const user = makeUser();

    const startRes = await request(app)
      .post('/api/minigame/start')
      .set('Cookie', cookieFor(user))
      .send({ game: 'rush' });
    expect(startRes.status).toBe(200);
    const { sessionId } = startRes.body;
    expect(sessionId).toBeTypeOf('string');

    // rush: durationSec=10, maxTapsPerSec=15 -> bound is 150; send way over.
    const finishRes = await request(app)
      .post('/api/minigame/finish')
      .set('Cookie', cookieFor(user))
      .send({ sessionId, metric: 999999 });
    expect(finishRes.status).toBe(200);
    // clamped metric = 150, waferDivisor = 4, lucky mult = 1 -> floor(150/4) = 37
    expect(finishRes.body.wafers).toBe(37);
    expect(finishRes.body.state.meta.wafers).toBe(37);
    expect(finishRes.body.state.meta.stats.minigamesWon).toBe(1);
    expect(finishRes.body.state.server.gameCooldowns.rush).toBeGreaterThan(Date.now());

    const secondStart = await request(app)
      .post('/api/minigame/start')
      .set('Cookie', cookieFor(user))
      .send({ game: 'rush' });
    expect(secondStart.status).toBe(429);
  });

  it('an unknown session id -> 404', async () => {
    const user = makeUser();
    const res = await request(app)
      .post('/api/minigame/finish')
      .set('Cookie', cookieFor(user))
      .send({ sessionId: 'does-not-exist', metric: 1 });
    expect(res.status).toBe(404);
  });

  it('finishing the same session twice -> 410 on the second call', async () => {
    const user = makeUser();
    const startRes = await request(app)
      .post('/api/minigame/start')
      .set('Cookie', cookieFor(user))
      .send({ game: 'debug' });
    const { sessionId } = startRes.body;

    const first = await request(app)
      .post('/api/minigame/finish')
      .set('Cookie', cookieFor(user))
      .send({ sessionId, metric: 5 });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/minigame/finish')
      .set('Cookie', cookieFor(user))
      .send({ sessionId, metric: 5 });
    expect(second.status).toBe(410);
  });

  it('match pays 0 and no cooldown/win-bump when not won', async () => {
    const user = makeUser();
    const startRes = await request(app)
      .post('/api/minigame/start')
      .set('Cookie', cookieFor(user))
      .send({ game: 'match' });
    const { sessionId } = startRes.body;

    // pairCount defaults to 10; report fewer pairs matched than that -> not won.
    const finishRes = await request(app)
      .post('/api/minigame/finish')
      .set('Cookie', cookieFor(user))
      .send({ sessionId, metric: 3 });
    expect(finishRes.status).toBe(200);
    expect(finishRes.body.wafers).toBe(0);
    expect(finishRes.body.state.meta.stats.minigamesWon).toBe(0);
    expect(finishRes.body.state.server.gameCooldowns.match).toBe(0);
  });
});

describe('GET /api/me', () => {
  it('includes effective roles and isOwner', async () => {
    const owner = upsertUser({ provider: 'test', providerId: 'owner', username: 'owner', avatarUrl: null });
    const res = await request(app).get('/api/me').set('Cookie', cookieFor(owner));
    expect(res.status).toBe(200);
    expect(res.body.isOwner).toBe(true);
    expect(res.body.roles).toEqual(expect.arrayContaining(['admin', 'event_coordinator']));
  });
});

describe('GET /api/changelog', () => {
  it('returns text/plain, falling back gracefully if CHANGELOG.md does not exist yet', async () => {
    const user = makeUser();
    const res = await request(app).get('/api/changelog').set('Cookie', cookieFor(user));
    expect(res.status).toBe(200);
    expect(res.text.length).toBeGreaterThan(0);
  });
});

describe('retired routes', () => {
  it('GET/POST/DELETE /api/save no longer exist', async () => {
    const user = makeUser();
    const get = await request(app).get('/api/save').set('Cookie', cookieFor(user));
    const post = await request(app).post('/api/save').set('Cookie', cookieFor(user)).send({});
    const del = await request(app).delete('/api/save').set('Cookie', cookieFor(user));
    // No router.post/delete handler exists for /api/save any more, so those
    // 404 outright. GET falls through to the SPA catch-all (by design, for
    // client-side routes) rather than 404ing, so assert on content-type
    // instead of status: it's serving index.html, not the old save JSON.
    expect(post.status).toBe(404);
    expect(del.status).toBe(404);
    expect(get.headers['content-type']).toMatch(/text\/html/);
  });
});
