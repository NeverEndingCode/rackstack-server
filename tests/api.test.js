process.env.JWT_SECRET = 'test-secret-for-supertest';
process.env.SUPER_ADMIN_IDS = 'test:owner';

import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../shared/configSchema.js';
import { initialState } from '../shared/state.js';
import { provisionDatabase } from './helpers/backend.js';

// Provision before importing the facade: DATABASE_URL/DB_PATH must be set
// before the dynamic import below. Dynamic imports: server/auth.js reads
// JWT_SECRET (and server/db.js reads DB_PATH/DATABASE_URL) at
// module-evaluation time. Static imports get hoisted above the process.env
// assignments above per ES module semantics, so - same trick as
// tests/db.test.js - these have to be dynamic to see the env vars set here.
const provisioned = await provisionDatabase();

const { buildApp } = await import('../server/app.js');
const { ensureConfig } = await import('../server/configService.js');
const { upsertUser, putSave, setRoles, createMinigameSession, driver } = await import('../server/db.js');
const { COOKIE_NAME } = await import('../server/auth.js');

const v11Fixture = JSON.parse(readFileSync(new URL('./fixtures/v11-save.json', import.meta.url)));

await ensureConfig();
const app = await buildApp();

afterAll(async () => {
  if (driver.__backend === 'pg') await driver.__raw.end();
  await provisioned.cleanup();
});

let seq = 0;
async function makeUser(overrides = {}) {
  seq += 1;
  return await upsertUser({
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
    const user = await makeUser();
    await putSave(user.id, v11Fixture, Date.now());

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
    const user = await makeUser();
    const res = await request(app)
      .post('/api/actions')
      .set('Cookie', cookieFor(user))
      .send({ actions: 'nope' });
    expect(res.status).toBe(400);
  });

  it('400s when actions has more than 100 entries', async () => {
    const user = await makeUser();
    const actions = Array.from({ length: 101 }, (_, i) => ({ _cid: i, type: 'collectAll' }));
    const res = await request(app)
      .post('/api/actions')
      .set('Cookie', cookieFor(user))
      .send({ actions });
    expect(res.status).toBe(400);
  });

  it('buy path mutates canon; a second identical unaffordable buy fails without undoing the first', async () => {
    const user = await makeUser(); // fresh state: credits = 10

    const res = await request(app)
      .post('/api/actions')
      .set('Cookie', cookieFor(user))
      .send({
        actions: [
          { _cid: 'a1', type: 'buy', lane: 'tiers', index: 0, mode: 'max' },
          { _cid: 'a2', type: 'buy', lane: 'tiers', index: 0, mode: 'max' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0]).toMatchObject({ _cid: 'a1', ok: true });
    expect(res.body.results[1]).toMatchObject({ _cid: 'a2', ok: false, error: 'insufficient_credits' });
    // the first buy's effect stuck: tier 0 owned went up, credits dropped from 10.
    expect(res.body.state.run.tiers[0].owned).toBeGreaterThan(0);
    expect(res.body.state.run.credits).toBeLessThan(10);
  });

  it('rejects a malicious non-numeric index payload with a normal ok:false result, not a 500', async () => {
    const user = await makeUser(); // fresh state: credits = 10

    const res = await request(app)
      .post('/api/actions')
      .set('Cookie', cookieFor(user))
      .send({
        actions: [
          { _cid: 'm1', type: 'buy', lane: 'tiers', index: 'push', mode: 1 },
          { _cid: 'm2', type: 'buy', lane: 'tiers', index: 'length', mode: 1 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    expect(res.body.results[0]).toEqual({ _cid: 'm1', ok: false, error: 'invalid_target' });
    expect(res.body.results[1]).toEqual({ _cid: 'm2', ok: false, error: 'invalid_target' });
    expect(res.body.state.run.credits).toBe(10); // unchanged, not NaN
  });

  it('rejects a prototype-key action type (__proto__) with a normal ok:false result, not a 500', async () => {
    const user = await makeUser();

    const res = await request(app)
      .post('/api/actions')
      .set('Cookie', cookieFor(user))
      .send({
        actions: [{ _cid: 'p1', type: '__proto__' }],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
    expect(res.body.results[0]).toEqual({ _cid: 'p1', ok: false, error: 'unknown_action' });
  });
});

// Task 5: proves the existing, unmodified POST /api/actions route (and
// applyActions() in server/stateService.js) dispatches all 7 Cold Storage
// action types registered in shared/reducer.js's HANDLERS table correctly,
// with zero server route/service code changes. Business-logic edge cases for
// these handlers are already covered exhaustively at the reducer-unit level
// in tests/reducer.coldStorage.test.js (Task 3); these tests only need to
// prove the generic HTTP dispatch pipeline reaches them.
describe('POST /api/actions: Cold Storage', () => {
  it('dispatches claimBlock through the existing generic action pipeline', async () => {
    const user = await makeUser();
    const state = initialState();
    // DEFAULT_CONFIG.batchQueue.blockDurationMs is 6h; starting the track 20h
    // ago means floor(20/6) = 3 blocks (indices 0-2) have arrived.
    state.meta.coldStorage.trackStartedAt = Date.now() - 20 * 3600 * 1000;
    await putSave(user.id, state, Date.now());

    const res = await request(app)
      .post('/api/actions')
      .set('Cookie', cookieFor(user))
      .send({ actions: [{ _cid: 1, type: 'claimBlock', index: 0 }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ _cid: 1, ok: true });
    expect(res.body.state.meta.coldStorage.blocksClaimed[0]).toBe(true);
  });

  it('dispatches claimAllBlocks, resetTrack, startJob, and cancelJob in one batch', async () => {
    const user = await makeUser();
    const state = initialState();
    state.meta.coldStorage.trackStartedAt = Date.now() - 200 * 3600 * 1000; // all 16 blocks arrived
    await putSave(user.id, state, Date.now());

    const res = await request(app)
      .post('/api/actions')
      .set('Cookie', cookieFor(user))
      .send({
        actions: [
          { _cid: 1, type: 'claimAllBlocks' },
          { _cid: 2, type: 'resetTrack' },
          { _cid: 3, type: 'startJob', jobType: 'defrag' },
          { _cid: 4, type: 'cancelJob' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(4);
    expect(res.body.results[0]).toMatchObject({ _cid: 1, ok: true, claimedCount: 16 });
    expect(res.body.results[1]).toMatchObject({ _cid: 2, ok: true });
    expect(res.body.results[2]).toMatchObject({ _cid: 3, ok: true });
    expect(res.body.results[3]).toMatchObject({ _cid: 4, ok: true });
    expect(res.body.state.meta.coldStorage.trackCycle).toBe(1);
    expect(res.body.state.meta.coldStorage.job).toBeNull();
  });

  // buyTapeUpgrade's `id` field is semantic (the upgrade identifier -
  // shared/reducer.js's handler destructures `action.id`, exactly like the
  // pre-existing buyUpgrade/buyShardUpgrade buyFromDefs() handlers already
  // do) and is completely independent from `_cid`, the action queue's own
  // correlation id (see client/game/api.js and server/stateService.js's
  // applyActions - a prior bug conflated the two into a single `id` field,
  // which silently broke this and four other action types end-to-end; see
  // the hotfix that split them). A real client sends both fields at once;
  // this test includes `_cid` too to prove the split doesn't disturb the
  // semantic `id` the reducer actually keys off of.
  it('rejects buyTapeUpgrade at max level via the existing config-driven check', async () => {
    const user = await makeUser();
    const state = initialState();
    state.meta.coldStorage.upgrades.headstart = 5; // DEFAULT_CONFIG.upgrades.maxLevels.headstart
    state.meta.coldStorage.tapes = 1e9; // plenty of tapes - proves this is max_level, not insufficient_credits
    await putSave(user.id, state, Date.now());

    const res = await request(app)
      .post('/api/actions')
      .set('Cookie', cookieFor(user))
      .send({ actions: [{ _cid: 1, type: 'buyTapeUpgrade', id: 'headstart' }] });

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ _cid: 1, ok: false, error: 'max_level' });
    expect(res.body.state.meta.coldStorage.upgrades.headstart).toBe(5); // unchanged
  });
});

describe('config: admin gating and owner bump', () => {
  it('non-admin PUT /api/admin/config -> 403', async () => {
    const user = await makeUser();
    const res = await request(app)
      .put('/api/admin/config')
      .set('Cookie', cookieFor(user))
      .send({ data: DEFAULT_CONFIG });
    expect(res.status).toBe(403);
  });

  it('owner (via SUPER_ADMIN_IDS) can update config, and GET /api/config reflects the bump', async () => {
    const owner = await upsertUser({ provider: 'test', providerId: 'owner', username: 'owner', avatarUrl: null });
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
    const owner = await upsertUser({ provider: 'test', providerId: 'owner', username: 'owner', avatarUrl: null });
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
    const admin = await makeUser();
    await setRoles(admin.id, ['admin']);
    const target = await makeUser();

    const res = await request(app)
      .post('/api/admin/roles')
      .set('Cookie', cookieFor(admin))
      .send({ userId: target.id, role: 'admin', op: 'grant' });
    expect(res.status).toBe(403);
  });

  it('a non-admin cannot use the roles endpoint at all -> 403', async () => {
    const user = await makeUser();
    const target = await makeUser();
    const res = await request(app)
      .post('/api/admin/roles')
      .set('Cookie', cookieFor(user))
      .send({ userId: target.id, role: 'event_coordinator', op: 'grant' });
    expect(res.status).toBe(403);
  });

  it('a non-owner admin CAN grant event_coordinator', async () => {
    const admin = await makeUser();
    await setRoles(admin.id, ['admin']);
    const target = await makeUser();

    const res = await request(app)
      .post('/api/admin/roles')
      .set('Cookie', cookieFor(admin))
      .send({ userId: target.id, role: 'event_coordinator', op: 'grant' });
    expect(res.status).toBe(200);
    expect(res.body.roles).toContain('event_coordinator');
  });

  it('owner can grant admin', async () => {
    const owner = await upsertUser({ provider: 'test', providerId: 'owner', username: 'owner', avatarUrl: null });
    const target = await makeUser();
    const res = await request(app)
      .post('/api/admin/roles')
      .set('Cookie', cookieFor(owner))
      .send({ userId: target.id, role: 'admin', op: 'grant' });
    expect(res.status).toBe(200);
    expect(res.body.roles).toContain('admin');
  });

  it('unknown role -> 400', async () => {
    const owner = await upsertUser({ provider: 'test', providerId: 'owner', username: 'owner', avatarUrl: null });
    const target = await makeUser();
    const res = await request(app)
      .post('/api/admin/roles')
      .set('Cookie', cookieFor(owner))
      .send({ userId: target.id, role: 'superuser', op: 'grant' });
    expect(res.status).toBe(400);
  });

  it('cannot modify a super-admin id -> 400', async () => {
    const owner = await upsertUser({ provider: 'test', providerId: 'owner', username: 'owner', avatarUrl: null });
    const res = await request(app)
      .post('/api/admin/roles')
      .set('Cookie', cookieFor(owner))
      .send({ userId: owner.id, role: 'event_coordinator', op: 'revoke' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /api/me/username', () => {
  it('sets a valid username -> 200, then a case-insensitive collision from another user -> 409', async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();

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
    const user = await makeUser();
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
    const user = await makeUser();

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

  it('a second concurrently-open session for the same game is rejected -> 409 (burst-start regression)', async () => {
    const user = await makeUser();

    const first = await request(app)
      .post('/api/minigame/start')
      .set('Cookie', cookieFor(user))
      .send({ game: 'rush' });
    expect(first.status).toBe(200);

    // Same game, still unfinished - must not be allowed to open a second
    // one just because the first hasn't been redeemed yet.
    const second = await request(app)
      .post('/api/minigame/start')
      .set('Cookie', cookieFor(user))
      .send({ game: 'rush' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('session_open');

    // A different game for the same user is unaffected.
    const otherGame = await request(app)
      .post('/api/minigame/start')
      .set('Cookie', cookieFor(user))
      .send({ game: 'debug' });
    expect(otherGame.status).toBe(200);
  });

  it('a session that predates a win cannot be redeemed once the win cooldown is set -> 429, no credit, still marked finished (burst-finish regression)', async () => {
    const user = await makeUser();

    // Win once, which sets server.gameCooldowns.rush.
    const startRes = await request(app)
      .post('/api/minigame/start')
      .set('Cookie', cookieFor(user))
      .send({ game: 'rush' });
    const winFinish = await request(app)
      .post('/api/minigame/finish')
      .set('Cookie', cookieFor(user))
      .send({ sessionId: startRes.body.sessionId, metric: 999999 });
    expect(winFinish.status).toBe(200);
    const wafersAfterWin = winFinish.body.state.meta.wafers;
    expect(wafersAfterWin).toBeGreaterThan(0);

    // Craft a second session directly via the db layer, bypassing the
    // start-time session_open/cooldown gate entirely, to simulate one that
    // was opened concurrently before the win landed.
    const craftedSession = await createMinigameSession(user.id, 'rush');

    const blockedFinish = await request(app)
      .post('/api/minigame/finish')
      .set('Cookie', cookieFor(user))
      .send({ sessionId: craftedSession.id, metric: 999999 });
    expect(blockedFinish.status).toBe(429);
    expect(blockedFinish.body).toEqual({ error: 'cooldown_active' });

    // No further credit landed...
    const stateRes = await request(app).get('/api/state').set('Cookie', cookieFor(user));
    expect(stateRes.body.meta.wafers).toBe(wafersAfterWin);

    // ...and the blocked session was still marked finished, so it can't be
    // replayed once the cooldown clears.
    const replay = await request(app)
      .post('/api/minigame/finish')
      .set('Cookie', cookieFor(user))
      .send({ sessionId: craftedSession.id, metric: 1 });
    expect(replay.status).toBe(410);
  });

  it('an unknown session id -> 404', async () => {
    const user = await makeUser();
    const res = await request(app)
      .post('/api/minigame/finish')
      .set('Cookie', cookieFor(user))
      .send({ sessionId: 'does-not-exist', metric: 1 });
    expect(res.status).toBe(404);
  });

  it('finishing the same session twice -> 410 on the second call', async () => {
    const user = await makeUser();
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
    const user = await makeUser();
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
    const owner = await upsertUser({ provider: 'test', providerId: 'owner', username: 'owner', avatarUrl: null });
    const res = await request(app).get('/api/me').set('Cookie', cookieFor(owner));
    expect(res.status).toBe(200);
    expect(res.body.isOwner).toBe(true);
    expect(res.body.roles).toEqual(expect.arrayContaining(['admin', 'event_coordinator']));
  });
});

describe('GET /api/changelog', () => {
  it('returns text/plain, falling back gracefully if CHANGELOG.md does not exist yet', async () => {
    const user = await makeUser();
    const res = await request(app).get('/api/changelog').set('Cookie', cookieFor(user));
    expect(res.status).toBe(200);
    expect(res.text.length).toBeGreaterThan(0);
  });
});

describe('retired routes', () => {
  it('GET/POST/DELETE /api/save no longer exist', async () => {
    const user = await makeUser();
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
