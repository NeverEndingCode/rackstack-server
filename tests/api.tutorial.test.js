process.env.JWT_SECRET = 'test-secret-for-supertest-tours';
process.env.DB_PATH = ':memory:';

import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const { buildApp } = await import('../server/app.js');
const { ensureConfig } = await import('../server/configService.js');
const { upsertUser, getToursCompleted, setToursCompleted } = await import('../server/db.js');
const { COOKIE_NAME } = await import('../server/auth.js');
const { TOUR_IDS, ONBOARDING_TOUR_ID } = await import('../shared/tours.js');

await ensureConfig();
const app = buildApp();

let seq = 0;
async function seedUser() {
  seq += 1;
  const u = await upsertUser({
    provider: 'discord', providerId: `tour${seq}`, username: `touruser${seq}`, avatarUrl: null,
  });
  const token = jwt.sign(
    { sub: u.id, username: u.username, avatarUrl: null },
    process.env.JWT_SECRET,
  );
  return { user: u, cookie: `${COOKIE_NAME}=${token}` };
}

describe('GET /api/me toursCompleted', () => {
  it('reports an empty set for a fresh user', async () => {
    const { cookie } = await seedUser();
    const res = await request(app).get('/api/me').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.toursCompleted).toEqual([]);
  });

  it('reflects what is stored', async () => {
    const { user, cookie } = await seedUser();
    await setToursCompleted(user.id, [ONBOARDING_TOUR_ID]);
    const res = await request(app).get('/api/me').set('Cookie', cookie);
    expect(res.body.toursCompleted).toEqual([ONBOARDING_TOUR_ID]);
  });
});

describe('PUT /api/me/tours', () => {
  it('requires auth', async () => {
    const res = await request(app).put('/api/me/tours').send({ tourId: ONBOARDING_TOUR_ID, completed: true });
    expect(res.status).toBe(401);
  });

  it('rejects a non-string tourId', async () => {
    const { cookie } = await seedUser();
    const res = await request(app).put('/api/me/tours').set('Cookie', cookie).send({ tourId: 7, completed: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('rejects a non-boolean completed', async () => {
    const { cookie } = await seedUser();
    const res = await request(app).put('/api/me/tours').set('Cookie', cookie).send({ tourId: ONBOARDING_TOUR_ID, completed: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('rejects an unregistered tour id', async () => {
    const { cookie } = await seedUser();
    const res = await request(app).put('/api/me/tours').set('Cookie', cookie).send({ tourId: 'made-up', completed: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('rejects a missing body', async () => {
    const { cookie } = await seedUser();
    const res = await request(app).put('/api/me/tours').set('Cookie', cookie).send({});
    expect(res.status).toBe(400);
  });

  // Spec §4.7: onboarding is a superset of every feature tour, so finishing
  // it must not leave a brand-new player queued up for all of them.
  it('completing onboarding marks every registered tour complete', async () => {
    const { user, cookie } = await seedUser();
    const res = await request(app).put('/api/me/tours').set('Cookie', cookie)
      .send({ tourId: ONBOARDING_TOUR_ID, completed: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect([...res.body.toursCompleted].sort()).toEqual([...TOUR_IDS].sort());
    expect([...(await getToursCompleted(user.id))].sort()).toEqual([...TOUR_IDS].sort());
  });

  it('removes a single id when completed is false (replay)', async () => {
    const { user, cookie } = await seedUser();
    await setToursCompleted(user.id, [ONBOARDING_TOUR_ID]);
    const res = await request(app).put('/api/me/tours').set('Cookie', cookie)
      .send({ tourId: ONBOARDING_TOUR_ID, completed: false });
    expect(res.status).toBe(200);
    expect(res.body.toursCompleted).not.toContain(ONBOARDING_TOUR_ID);
    expect(await getToursCompleted(user.id)).not.toContain(ONBOARDING_TOUR_ID);
  });

  it('deduplicates and preserves ids from newer deployments', async () => {
    const { user, cookie } = await seedUser();
    // 'v99-future' is not in this build's registry - a rolled-back deploy
    // must not erase a completion recorded by a newer one.
    await setToursCompleted(user.id, [ONBOARDING_TOUR_ID, ONBOARDING_TOUR_ID, 'v99-future']);
    const res = await request(app).put('/api/me/tours').set('Cookie', cookie)
      .send({ tourId: ONBOARDING_TOUR_ID, completed: false });
    expect(res.status).toBe(200);
    expect(res.body.toursCompleted).toContain('v99-future');
    expect(res.body.toursCompleted).not.toContain(ONBOARDING_TOUR_ID);
  });
});
