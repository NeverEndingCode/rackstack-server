import {
  describe, it, expect, beforeEach, afterAll,
} from 'vitest';
import { validateModifiers, validateLadder } from '../shared/events.js';
import { provisionDatabase } from './helpers/backend.js';

// Provision before importing the facade: DATABASE_URL/DB_PATH must be set
// before the dynamic import below, since the facade resolves its driver at
// module-evaluation time - a static `import { driver } from ...` would be
// hoisted by the ESM spec above the provisioning call and stand up the
// driver against the wrong backend/path.
const provisioned = await provisionDatabase();

const dbMod = await import('../server/db.js');
const {
  driver,
  upsertUser,
  getUserById,
  listEvents,
  getEvent,
  getActiveEvent,
  putEvent,
  setEventStatus,
  deleteEvent,
  upsertParticipation,
  getParticipation,
  listParticipation,
  setLeaderboardOptOut,
  seedSeasonalEvents,
} = dbMod;
const { SEASONAL_EVENTS } = await import('../server/data/seasonalEvents.js');

afterAll(async () => {
  if (driver.__backend === 'pg') await driver.__raw.end();
  await provisioned.cleanup();
});

// Schema/table-existence assertions below are inherently backend-specific
// (sqlite_master/PRAGMA table_info vs. pg_tables/information_schema); route
// them through the driver handle rather than a module-level `db` export so
// the intent stays explicit.
const db = driver.__raw;

async function tableNames() {
  if (driver.__backend === 'sqlite') {
    return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
  }
  const { rows } = await db.query("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'");
  return rows.map((r) => r.name);
}

async function columnNames(table) {
  if (driver.__backend === 'sqlite') {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  }
  const { rows } = await db.query(
    'SELECT column_name AS name FROM information_schema.columns WHERE table_name = $1',
    [table],
  );
  return rows.map((r) => r.name);
}

function sampleEvent(overrides = {}) {
  return {
    id: 'test-event',
    name: 'Test Event',
    description: 'A test event',
    theme: { icon: '🧪', color: '#123456' },
    modifiers: [{ path: 'production.gridMult', value: 2 }],
    ladder: [
      { metric: 'flopsEarned', target: 100, reward: { wafers: 5 } },
      { metric: 'flopsEarned', target: 500, reward: { wafers: 10 } },
    ],
    status: 'draft',
    recurrence: { month: 6, day: 1, durationDays: 7 },
    createdAt: Date.now(),
    createdBy: 'admin:1',
    ...overrides,
  };
}

describe('db schema v1.4', () => {
  it('creates live_events and event_participation tables', async () => {
    const names = await tableNames();
    expect(names).toContain('live_events');
    expect(names).toContain('event_participation');
  });

  it('adds leaderboard_opt_out column to users', async () => {
    const cols = await columnNames('users');
    expect(cols).toContain('leaderboard_opt_out');
  });

  // SQLite-only: see the equivalent skip in tests/db.test.js - guarded ALTER
  // is a SQLite-specific mechanism schema.pg.js has no counterpart for.
  it.runIf(driver.__backend === 'sqlite')('re-running the guarded ALTER does not throw on a second boot', async () => {
    expect(() => {
      try {
        db.exec('ALTER TABLE users ADD COLUMN leaderboard_opt_out INTEGER DEFAULT 0');
      } catch (err) {
        if (!/duplicate column name/i.test(err.message)) throw err;
      }
    }).not.toThrow();
  });
});

describe('live_events CRUD', () => {
  it('putEvent + getEvent round-trips with JSON fields parsed', async () => {
    await putEvent(sampleEvent());
    const row = await getEvent('test-event');
    expect(row.id).toBe('test-event');
    expect(row.name).toBe('Test Event');
    expect(row.theme).toEqual({ icon: '🧪', color: '#123456' });
    expect(row.modifiers).toEqual([{ path: 'production.gridMult', value: 2 }]);
    expect(row.ladder).toEqual([
      { metric: 'flopsEarned', target: 100, reward: { wafers: 5 } },
      { metric: 'flopsEarned', target: 500, reward: { wafers: 10 } },
    ]);
    expect(row.recurrence).toEqual({ month: 6, day: 1, durationDays: 7 });
    expect(row.status).toBe('draft');
  });

  it('getEvent returns undefined for an unknown id', async () => {
    expect(await getEvent('nope')).toBeUndefined();
  });

  it('putEvent upserts (insert-or-replace) on a second call with the same id', async () => {
    await putEvent(sampleEvent({ id: 'upsert-me', name: 'Original' }));
    await putEvent(sampleEvent({ id: 'upsert-me', name: 'Renamed' }));
    const row = await getEvent('upsert-me');
    expect(row.name).toBe('Renamed');
    expect((await listEvents()).filter((e) => e.id === 'upsert-me').length).toBe(1);
  });

  it('listEvents returns all events with parsed JSON fields', async () => {
    await putEvent(sampleEvent({ id: 'list-a' }));
    await putEvent(sampleEvent({ id: 'list-b' }));
    const events = await listEvents();
    const ids = events.map((e) => e.id);
    expect(ids).toContain('list-a');
    expect(ids).toContain('list-b');
    for (const e of events) {
      expect(Array.isArray(e.modifiers)).toBe(true);
      expect(Array.isArray(e.ladder)).toBe(true);
    }
  });

  it('getActiveEvent returns at most one event, only when status is active', async () => {
    await putEvent(sampleEvent({ id: 'active-none', status: 'draft' }));
    expect(await getActiveEvent()).toBeUndefined();

    await putEvent(sampleEvent({ id: 'active-one', status: 'active' }));
    const active = await getActiveEvent();
    expect(active).toBeDefined();
    expect(active.id).toBe('active-one');
    expect(active.status).toBe('active');
  });

  it('setEventStatus updates status and window', async () => {
    await putEvent(sampleEvent({ id: 'status-me', status: 'draft' }));
    await setEventStatus('status-me', 'scheduled', { startsAt: 1000, endsAt: 2000 });
    const row = await getEvent('status-me');
    expect(row.status).toBe('scheduled');
    expect(row.starts_at).toBe(1000);
    expect(row.ends_at).toBe(2000);

    await setEventStatus('status-me', 'active');
    expect((await getEvent('status-me')).status).toBe('active');
    // window untouched by the status-only call
    expect((await getEvent('status-me')).starts_at).toBe(1000);
    expect((await getEvent('status-me')).ends_at).toBe(2000);
  });

  it('deleteEvent removes the row', async () => {
    await putEvent(sampleEvent({ id: 'delete-me' }));
    expect(await getEvent('delete-me')).toBeDefined();
    await deleteEvent('delete-me');
    expect(await getEvent('delete-me')).toBeUndefined();
  });
});

describe('event_participation', () => {
  it('upsertParticipation round-trips and getParticipation reads it back', async () => {
    const u = await upsertUser({ provider: 'discord', providerId: 'ep1', username: 'participant1', avatarUrl: null });
    await putEvent(sampleEvent({ id: 'part-event' }));

    await upsertParticipation({
      userId: u.id, eventId: 'part-event', startedAt: 100, endsAt: 200, rungsClaimed: 2, lastProgressAt: 150, optedOut: false,
    });
    const row = await getParticipation(u.id, 'part-event');
    expect(row.user_id).toBe(u.id);
    expect(row.event_id).toBe('part-event');
    expect(row.rungs_claimed).toBe(2);
    expect(row.opted_out).toBe(0);

    await upsertParticipation({
      userId: u.id, eventId: 'part-event', startedAt: 100, endsAt: 200, rungsClaimed: 5, lastProgressAt: 180, optedOut: false,
    });
    const updated = await getParticipation(u.id, 'part-event');
    expect(updated.rungs_claimed).toBe(5);
    expect(updated.last_progress_at).toBe(180);
  });

  it('listParticipation orders by rungs_claimed DESC, last_progress_at ASC', async () => {
    const a = await upsertUser({ provider: 'discord', providerId: 'ep2', username: 'participant2', avatarUrl: null });
    const b = await upsertUser({ provider: 'discord', providerId: 'ep3', username: 'participant3', avatarUrl: null });
    const c = await upsertUser({ provider: 'discord', providerId: 'ep4', username: 'participant4', avatarUrl: null });
    await putEvent(sampleEvent({ id: 'leaderboard-event' }));

    await upsertParticipation({ userId: a.id, eventId: 'leaderboard-event', startedAt: 0, endsAt: 1000, rungsClaimed: 3, lastProgressAt: 500 });
    await upsertParticipation({ userId: b.id, eventId: 'leaderboard-event', startedAt: 0, endsAt: 1000, rungsClaimed: 5, lastProgressAt: 900 });
    await upsertParticipation({ userId: c.id, eventId: 'leaderboard-event', startedAt: 0, endsAt: 1000, rungsClaimed: 5, lastProgressAt: 400 });

    const rows = await listParticipation('leaderboard-event');
    expect(rows.map((r) => r.user_id)).toEqual([c.id, b.id, a.id]);
  });

  it('setLeaderboardOptOut round-trips on the users table', async () => {
    const u = await upsertUser({ provider: 'discord', providerId: 'ep5', username: 'participant5', avatarUrl: null });
    expect((await getUserById(u.id)).leaderboard_opt_out).toBe(0);

    await setLeaderboardOptOut(u.id, true);
    expect((await getUserById(u.id)).leaderboard_opt_out).toBe(1);

    await setLeaderboardOptOut(u.id, false);
    expect((await getUserById(u.id)).leaderboard_opt_out).toBe(0);
  });
});

describe('seedSeasonalEvents', () => {
  it('inserts all seasonal events as drafts with NULL window', async () => {
    await seedSeasonalEvents();
    for (const evt of SEASONAL_EVENTS) {
      const row = await getEvent(evt.id);
      expect(row).toBeDefined();
      expect(row.status).toBe('draft');
      expect(row.starts_at).toBeNull();
      expect(row.ends_at).toBeNull();
      expect(row.name).toBe(evt.name);
      expect(row.recurrence).toEqual(evt.recurrence);
    }
  });

  it('is idempotent across two calls', async () => {
    await seedSeasonalEvents();
    const first = (await listEvents()).length;
    await seedSeasonalEvents();
    const second = (await listEvents()).length;
    expect(second).toBe(first);
  });

  it('does not clobber an admin-edited copy of a seeded event', async () => {
    await seedSeasonalEvents();
    const edited = { ...(await getEvent('summer-surge')), name: 'Admin Edited Summer Surge', status: 'active' };
    await putEvent(edited);

    await seedSeasonalEvents();

    const row = await getEvent('summer-surge');
    expect(row.name).toBe('Admin Edited Summer Surge');
    expect(row.status).toBe('active');
  });
});

describe('SEASONAL_EVENTS content', () => {
  it('every seasonal event has 4 known entries', async () => {
    const ids = SEASONAL_EVENTS.map((e) => e.id).sort();
    expect(ids).toEqual(['black-frame-friday', 'frost-uptime', 'spooky-packets', 'summer-surge']);
  });

  it('every seasonal event passes validateModifiers and validateLadder', async () => {
    for (const evt of SEASONAL_EVENTS) {
      const modResult = validateModifiers(evt.modifiers);
      expect(modResult.ok, `${evt.id} modifiers: ${JSON.stringify(modResult.errors)}`).toBe(true);

      const ladderResult = validateLadder(evt.ladder);
      expect(ladderResult.ok, `${evt.id} ladder: ${JSON.stringify(ladderResult.errors)}`).toBe(true);
    }
  });

  it('every seasonal event has a well-formed recurrence', async () => {
    for (const evt of SEASONAL_EVENTS) {
      expect(evt.recurrence).toBeDefined();
      expect(evt.recurrence.month).toBeGreaterThanOrEqual(1);
      expect(evt.recurrence.month).toBeLessThanOrEqual(12);
      expect(evt.recurrence.day).toBeGreaterThanOrEqual(1);
      expect(evt.recurrence.day).toBeLessThanOrEqual(31);
      expect(evt.recurrence.durationDays).toBeGreaterThan(0);
    }
  });
});
