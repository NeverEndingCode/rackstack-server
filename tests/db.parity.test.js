import { describe, it, expect, afterAll } from 'vitest';
import { provisionDatabase } from './helpers/backend.js';

// Provision before importing the facade: DATABASE_URL/DB_PATH must be set
// before the dynamic import below, since the facade resolves its driver at
// module-evaluation time (a static import would be hoisted above this).
const provisioned = await provisionDatabase();

// Top-level await, not beforeAll: if the import below throws (e.g. the RED
// step of this task, where driver.pg.js didn't exist yet), a beforeAll-set
// `db` would still be undefined when afterAll ran, throwing a TypeError on
// `db.driver` that masks the real error and skips cleanup() - leaking the
// provisioned database. A top-level await fails the whole module before
// afterAll is ever registered, so vitest's own teardown for a failed-to-load
// file applies instead.
const db = await import('../server/db/index.js');
afterAll(async () => {
  // Close the pg pool before dropping its database: DROP DATABASE ... FORCE
  // terminates any live connections, which the pool would otherwise surface
  // as an unhandled 'error' event during teardown.
  if (db.driver.__backend === 'pg') await db.driver.__raw.end();
  await provisioned.cleanup();
});

describe('cross-dialect parity', () => {
  it('returns undefined - not null - for a missing row', async () => {
    expect(await db.getUserById('nope:1')).toBeUndefined();
    expect(await db.getSave('nope:1')).toBeUndefined();
    expect(await db.getEvent('nope')).toBeUndefined();
  });

  it('round-trips epoch-ms timestamps as numbers', async () => {
    const now = 1784859388645;
    await db.upsertUser({ provider: 'github', providerId: 't1', username: 'ts', avatarUrl: null });
    await db.putSave('github:t1', { hello: 'world' }, now);
    const row = await db.getSave('github:t1');
    expect(typeof row.last_save).toBe('number');
    expect(row.last_save).toBe(now);
  });

  it('round-trips a save byte-for-byte, including key order', async () => {
    const payload = { z: 1, a: { nested: [1, 2, 3] }, m: 'x' };
    await db.upsertUser({ provider: 'github', providerId: 't2', username: 'bytes', avatarUrl: null });
    await db.putSave('github:t2', payload, 1);
    const row = await db.getSave('github:t2');
    expect(row.data).toBe(JSON.stringify(payload));
  });

  it('enforces case-insensitive username uniqueness', async () => {
    await db.upsertUser({ provider: 'github', providerId: 'c1', username: 'CaseTest', avatarUrl: null });
    await db.upsertUser({ provider: 'discord', providerId: 'c2', username: 'casetest', avatarUrl: null });
    const a = await db.getUserById('github:c1');
    const b = await db.getUserById('discord:c2');
    expect(a.username).toBe('CaseTest');
    expect(b.username).toBe('casetest-2'); // suffixed, not rejected
  });

  it('setUsername rejects a case-variant of another user\'s name', async () => {
    await db.upsertUser({ provider: 'github', providerId: 'c3', username: 'Taken', avatarUrl: null });
    await db.upsertUser({ provider: 'github', providerId: 'c4', username: 'Other', avatarUrl: null });
    expect(await db.setUsername('github:c4', 'taken')).toEqual({ ok: false, error: 'taken' });
  });

  it('returns config history newest-first', async () => {
    await db.putConfigRow(1, { v: 1 }, null);
    await db.putConfigRow(2, { v: 2 }, null);
    await db.putConfigRow(3, { v: 3 }, null);
    const history = await db.getConfigHistory();
    expect(history.map((h) => h.version)).toEqual([3, 2, 1]);
  });

  it('preserves camelCase aliases in listLeaderboard', async () => {
    await db.upsertUser({ provider: 'github', providerId: 'lb', username: 'lbuser', avatarUrl: null });
    await db.putEvent({ id: 'ev-lb', name: 'LB', modifiers: [], ladder: [], status: 'active' });
    await db.upsertParticipation({
      userId: 'github:lb', eventId: 'ev-lb', startedAt: 1, endsAt: 2, rungsClaimed: 3, lastProgressAt: 4,
    });
    const [row] = await db.listLeaderboard('ev-lb');
    expect(row.userId).toBe('github:lb');
    expect(row.rungsClaimed).toBe(3);
    expect(row.lastProgressAt).toBe(4);
    expect(row).not.toHaveProperty('userid');
  });

  it('seedSeasonalEvents is idempotent across boots', async () => {
    await db.seedSeasonalEvents();
    const first = (await db.listEvents()).length;
    await db.seedSeasonalEvents();
    expect((await db.listEvents()).length).toBe(first);
  });

  it('orders listEvents by (created_at, id) so both backends agree', async () => {
    // seedSeasonalEvents stamps every seasonal event with the same `now`, so
    // created_at ties are the normal case, not an edge case. Asserting only
    // `.length` (as the idempotence test above does) cannot catch a backend
    // ordering the ties differently, which is how the two drivers drifted:
    // pg had `ORDER BY created_at ASC, id ASC`, sqlite had no tiebreak, and
    // the admin Events list rendered in a different order per backend.
    await db.seedSeasonalEvents();
    const events = await db.listEvents();
    expect(events.length).toBeGreaterThan(1);

    const expected = [...events].sort((a, b) => (
      a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    ));
    expect(events.map((e) => e.id)).toEqual(expected.map((e) => e.id));

    // The tie must actually be exercised, or the assertion above is just
    // re-sorting an already-distinct list and proves nothing.
    const byCreatedAt = new Map();
    for (const e of events) byCreatedAt.set(e.created_at, (byCreatedAt.get(e.created_at) || 0) + 1);
    expect(Math.max(...byCreatedAt.values())).toBeGreaterThan(1);
  });

  it('orders getAllUsersWithSaves by (created_at DESC, id) so both backends agree', async () => {
    // Same created_at on purpose: upsertUser stamps it from the clock, so
    // several accounts created in the same millisecond is ordinary.
    await db.upsertUser({ provider: 'github', providerId: 'ord-c', username: 'ordc', avatarUrl: null });
    await db.upsertUser({ provider: 'github', providerId: 'ord-a', username: 'orda', avatarUrl: null });
    await db.upsertUser({ provider: 'github', providerId: 'ord-b', username: 'ordb', avatarUrl: null });

    const rows = await db.getAllUsersWithSaves();
    const mine = rows.filter((r) => r.id.startsWith('github:ord-'));
    expect(mine).toHaveLength(3);

    const expected = [...mine].sort((a, b) => (
      b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    ));
    expect(mine.map((r) => r.id)).toEqual(expected.map((r) => r.id));
  });
});
