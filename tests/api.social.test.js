process.env.JWT_SECRET = 'test-secret-for-supertest-social';

import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { provisionDatabase } from './helpers/backend.js';

// Provision before importing the facade: DATABASE_URL/DB_PATH must be set
// before the dynamic import below, since the facade resolves its driver at
// module-evaluation time.
const provisioned = await provisionDatabase();
if (provisioned.backend === 'pg') process.env.DATABASE_URL = provisioned.url;
else process.env.DB_PATH = provisioned.path;

const { buildApp } = await import('../server/app.js');
const { ensureConfig } = await import('../server/configService.js');
const { upsertUser, putSave, setLeaderboardOptOut, driver } = await import('../server/db.js');
const { invalidateLeaderboards } = await import('../server/leaderboardService.js');
const { COOKIE_NAME } = await import('../server/auth.js');
const { initialState } = await import('../shared/state.js');

await ensureConfig();
const app = buildApp();

afterAll(async () => {
  if (driver.__backend === 'pg') await driver.__raw.end();
  await provisioned.cleanup();
});

let seq = 0;
async function seedPlayer({
  flops = 0, level = 0, cores = 0, singularities = 0, tapes = 0, achievements = {},
} = {}) {
  seq += 1;
  const u = await upsertUser({
    provider: 'discord', providerId: `lb${seq}`, username: `lbuser${seq}`,
    avatarUrl: `https://x/${seq}.png`,
  });
  const s = initialState();
  s.meta.stats.lifetimeFlopsAllTime = flops;
  s.meta.level = level;
  s.meta.legacyCores = cores;
  s.meta.stats.singularities = singularities;
  s.meta.coldStorage.tapes = tapes;
  s.meta.achievements = achievements;
  await putSave(u.id, s, Date.now());
  return u;
}

function cookieFor(user) {
  const token = jwt.sign(
    { sub: user.id, username: user.username, avatarUrl: user.avatar_url },
    process.env.JWT_SECRET, { expiresIn: '90d' },
  );
  return `${COOKIE_NAME}=${token}`;
}

describe('GET /api/leaderboard', () => {
  it('401s when unauthenticated', async () => {
    expect((await request(app).get('/api/leaderboard')).status).toBe(401);
  });

  it('returns every board, ranked descending', async () => {
    const low = await seedPlayer({ flops: 100, level: 1 });
    const high = await seedPlayer({ flops: 999999, level: 40 });
    invalidateLeaderboards();
    const res = await request(app).get('/api/leaderboard').set('Cookie', cookieFor(low));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.boards).sort()).toEqual(
      ['allTimeFlops', 'latestEventRung', 'legacyCores', 'level', 'singularities', 'tapes'],
    );
    const flopsIds = res.body.boards.allTimeFlops.map((r) => r.userId);
    expect(flopsIds.indexOf(high.id)).toBeLessThan(flopsIds.indexOf(low.id));
    const row = res.body.boards.allTimeFlops.find((r) => r.userId === high.id);
    expect(row.username).toBe(high.username);
    expect(row.avatarUrl).toBe(high.avatar_url);
    expect(row.value).toBe(999999);
    expect(Array.isArray(row.badges)).toBe(true);
  });

  it('excludes opted-out players from every board', async () => {
    const shy = await seedPlayer({ flops: 1e12, level: 90 });
    const seen = await seedPlayer({ flops: 5, level: 1 });
    await setLeaderboardOptOut(shy.id, true);
    invalidateLeaderboards();
    const res = await request(app).get('/api/leaderboard').set('Cookie', cookieFor(seen));
    for (const board of Object.values(res.body.boards)) {
      expect(board.map((r) => r.userId)).not.toContain(shy.id);
    }
  });

  it('surfaces up to three badges per row, gold first', async () => {
    const decorated = await seedPlayer({
      flops: 42,
      achievements: {
        first_migrate: 1, first_singularity: 2, level_10: 3, jackpot: 4, level_50: 5,
      },
    });
    invalidateLeaderboards();
    const res = await request(app).get('/api/leaderboard').set('Cookie', cookieFor(decorated));
    const row = res.body.boards.allTimeFlops.find((r) => r.userId === decorated.id);
    expect(row.badges.length).toBeLessThanOrEqual(3);
    expect(row.badges).toContain('level_50'); // gold sorts first
  });

  it('serves a cached payload within the TTL and rebuilds after invalidation', async () => {
    const u = await seedPlayer({ flops: 1 });
    invalidateLeaderboards();
    const first = await request(app).get('/api/leaderboard').set('Cookie', cookieFor(u));
    const second = await request(app).get('/api/leaderboard').set('Cookie', cookieFor(u));
    expect(second.body.generatedAt).toBe(first.body.generatedAt); // same cached build

    await seedPlayer({ flops: 1e15 });
    const stale = await request(app).get('/api/leaderboard').set('Cookie', cookieFor(u));
    expect(stale.body.generatedAt).toBe(first.body.generatedAt); // still cached

    invalidateLeaderboards();
    const fresh = await request(app).get('/api/leaderboard').set('Cookie', cookieFor(u));
    expect(fresh.body.generatedAt).toBeGreaterThanOrEqual(first.body.generatedAt);
    expect(fresh.body.boards.allTimeFlops[0].value).toBe(1e15);
  });

  // Regression: the boards are cache-fronted, so opting out through the route
  // has to drop that cache or a player who just asked to be hidden keeps
  // appearing for up to social.leaderboardCacheMs (60s by default). The
  // per-event leaderboard has always been immediate - it live-joins
  // users.leaderboard_opt_out on every read (v1.4's "hard requirement 1") -
  // and this control must not silently mean something weaker on the newer
  // boards. Caught by tests/e2e/smoke-v15.mjs before it was fixed.
  it('opting out through the route takes effect immediately, not after the cache TTL', async () => {
    const shy = await seedPlayer({ flops: 7e14 });
    const observer = await seedPlayer({ flops: 3 });
    invalidateLeaderboards();

    const before = await request(app).get('/api/leaderboard').set('Cookie', cookieFor(observer));
    expect(before.body.boards.allTimeFlops.map((r) => r.userId)).toContain(shy.id);

    const optOut = await request(app)
      .put('/api/me/leaderboard-opt-out')
      .set('Cookie', cookieFor(shy))
      .send({ optOut: true });
    expect(optOut.status).toBe(200);

    // No invalidateLeaderboards() here on purpose - the route must have done it.
    const after = await request(app).get('/api/leaderboard').set('Cookie', cookieFor(observer));
    for (const [key, rows] of Object.entries(after.body.boards)) {
      expect(rows.map((r) => r.userId), key).not.toContain(shy.id);
    }
  });

  it('skips users with no save row without throwing', async () => {
    const u = await seedPlayer({ flops: 1 });
    await upsertUser({
      provider: 'discord', providerId: 'lb-nosave', username: 'nosave', avatarUrl: null,
    });
    invalidateLeaderboards();
    const res = await request(app).get('/api/leaderboard').set('Cookie', cookieFor(u));
    expect(res.status).toBe(200);
    expect(res.body.boards.allTimeFlops.map((r) => r.username)).not.toContain('nosave');
  });
});
