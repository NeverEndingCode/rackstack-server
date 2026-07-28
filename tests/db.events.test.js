process.env.DB_PATH = ':memory:';

import { describe, it, expect, beforeEach } from 'vitest';
import { validateModifiers, validateLadder } from '../shared/events.js';

const dbMod = await import('../server/db.js');
const {
  db,
  upsertUser,
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

function tableNames() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
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
  it('creates live_events and event_participation tables', () => {
    const names = tableNames();
    expect(names).toContain('live_events');
    expect(names).toContain('event_participation');
  });

  it('adds leaderboard_opt_out column to users', () => {
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    expect(cols).toContain('leaderboard_opt_out');
  });

  it('re-running the guarded ALTER does not throw on a second boot', () => {
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
  it('putEvent + getEvent round-trips with JSON fields parsed', () => {
    putEvent(sampleEvent());
    const row = getEvent('test-event');
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

  it('getEvent returns undefined for an unknown id', () => {
    expect(getEvent('nope')).toBeUndefined();
  });

  it('putEvent upserts (insert-or-replace) on a second call with the same id', () => {
    putEvent(sampleEvent({ id: 'upsert-me', name: 'Original' }));
    putEvent(sampleEvent({ id: 'upsert-me', name: 'Renamed' }));
    const row = getEvent('upsert-me');
    expect(row.name).toBe('Renamed');
    expect(listEvents().filter((e) => e.id === 'upsert-me').length).toBe(1);
  });

  it('listEvents returns all events with parsed JSON fields', () => {
    putEvent(sampleEvent({ id: 'list-a' }));
    putEvent(sampleEvent({ id: 'list-b' }));
    const events = listEvents();
    const ids = events.map((e) => e.id);
    expect(ids).toContain('list-a');
    expect(ids).toContain('list-b');
    for (const e of events) {
      expect(Array.isArray(e.modifiers)).toBe(true);
      expect(Array.isArray(e.ladder)).toBe(true);
    }
  });

  it('getActiveEvent returns at most one event, only when status is active', () => {
    putEvent(sampleEvent({ id: 'active-none', status: 'draft' }));
    expect(getActiveEvent()).toBeUndefined();

    putEvent(sampleEvent({ id: 'active-one', status: 'active' }));
    const active = getActiveEvent();
    expect(active).toBeDefined();
    expect(active.id).toBe('active-one');
    expect(active.status).toBe('active');
  });

  it('setEventStatus updates status and window', () => {
    putEvent(sampleEvent({ id: 'status-me', status: 'draft' }));
    setEventStatus('status-me', 'scheduled', { startsAt: 1000, endsAt: 2000 });
    const row = getEvent('status-me');
    expect(row.status).toBe('scheduled');
    expect(row.starts_at).toBe(1000);
    expect(row.ends_at).toBe(2000);

    setEventStatus('status-me', 'active');
    expect(getEvent('status-me').status).toBe('active');
    // window untouched by the status-only call
    expect(getEvent('status-me').starts_at).toBe(1000);
    expect(getEvent('status-me').ends_at).toBe(2000);
  });

  it('deleteEvent removes the row', () => {
    putEvent(sampleEvent({ id: 'delete-me' }));
    expect(getEvent('delete-me')).toBeDefined();
    deleteEvent('delete-me');
    expect(getEvent('delete-me')).toBeUndefined();
  });
});

describe('event_participation', () => {
  it('upsertParticipation round-trips and getParticipation reads it back', () => {
    const u = upsertUser({ provider: 'discord', providerId: 'ep1', username: 'participant1', avatarUrl: null });
    putEvent(sampleEvent({ id: 'part-event' }));

    upsertParticipation({
      userId: u.id, eventId: 'part-event', startedAt: 100, endsAt: 200, rungsClaimed: 2, lastProgressAt: 150, optedOut: false,
    });
    const row = getParticipation(u.id, 'part-event');
    expect(row.user_id).toBe(u.id);
    expect(row.event_id).toBe('part-event');
    expect(row.rungs_claimed).toBe(2);
    expect(row.opted_out).toBe(0);

    upsertParticipation({
      userId: u.id, eventId: 'part-event', startedAt: 100, endsAt: 200, rungsClaimed: 5, lastProgressAt: 180, optedOut: false,
    });
    const updated = getParticipation(u.id, 'part-event');
    expect(updated.rungs_claimed).toBe(5);
    expect(updated.last_progress_at).toBe(180);
  });

  it('listParticipation orders by rungs_claimed DESC, last_progress_at ASC', () => {
    const a = upsertUser({ provider: 'discord', providerId: 'ep2', username: 'participant2', avatarUrl: null });
    const b = upsertUser({ provider: 'discord', providerId: 'ep3', username: 'participant3', avatarUrl: null });
    const c = upsertUser({ provider: 'discord', providerId: 'ep4', username: 'participant4', avatarUrl: null });
    putEvent(sampleEvent({ id: 'leaderboard-event' }));

    upsertParticipation({ userId: a.id, eventId: 'leaderboard-event', startedAt: 0, endsAt: 1000, rungsClaimed: 3, lastProgressAt: 500 });
    upsertParticipation({ userId: b.id, eventId: 'leaderboard-event', startedAt: 0, endsAt: 1000, rungsClaimed: 5, lastProgressAt: 900 });
    upsertParticipation({ userId: c.id, eventId: 'leaderboard-event', startedAt: 0, endsAt: 1000, rungsClaimed: 5, lastProgressAt: 400 });

    const rows = listParticipation('leaderboard-event');
    expect(rows.map((r) => r.user_id)).toEqual([c.id, b.id, a.id]);
  });

  it('setLeaderboardOptOut round-trips on the users table', () => {
    const u = upsertUser({ provider: 'discord', providerId: 'ep5', username: 'participant5', avatarUrl: null });
    const before = db.prepare('SELECT leaderboard_opt_out FROM users WHERE id = ?').get(u.id);
    expect(before.leaderboard_opt_out).toBe(0);

    setLeaderboardOptOut(u.id, true);
    const after = db.prepare('SELECT leaderboard_opt_out FROM users WHERE id = ?').get(u.id);
    expect(after.leaderboard_opt_out).toBe(1);

    setLeaderboardOptOut(u.id, false);
    expect(db.prepare('SELECT leaderboard_opt_out FROM users WHERE id = ?').get(u.id).leaderboard_opt_out).toBe(0);
  });
});

describe('seedSeasonalEvents', () => {
  it('inserts all seasonal events as drafts with NULL window', () => {
    seedSeasonalEvents();
    for (const evt of SEASONAL_EVENTS) {
      const row = getEvent(evt.id);
      expect(row).toBeDefined();
      expect(row.status).toBe('draft');
      expect(row.starts_at).toBeNull();
      expect(row.ends_at).toBeNull();
      expect(row.name).toBe(evt.name);
      expect(row.recurrence).toEqual(evt.recurrence);
    }
  });

  it('is idempotent across two calls', () => {
    seedSeasonalEvents();
    const first = listEvents().length;
    seedSeasonalEvents();
    const second = listEvents().length;
    expect(second).toBe(first);
  });

  it('does not clobber an admin-edited copy of a seeded event', () => {
    seedSeasonalEvents();
    const edited = { ...getEvent('summer-surge'), name: 'Admin Edited Summer Surge', status: 'active' };
    putEvent(edited);

    seedSeasonalEvents();

    const row = getEvent('summer-surge');
    expect(row.name).toBe('Admin Edited Summer Surge');
    expect(row.status).toBe('active');
  });
});

describe('SEASONAL_EVENTS content', () => {
  it('every seasonal event has 4 known entries', () => {
    const ids = SEASONAL_EVENTS.map((e) => e.id).sort();
    expect(ids).toEqual(['black-frame-friday', 'frost-uptime', 'spooky-packets', 'summer-surge']);
  });

  it('every seasonal event passes validateModifiers and validateLadder', () => {
    for (const evt of SEASONAL_EVENTS) {
      const modResult = validateModifiers(evt.modifiers);
      expect(modResult.ok, `${evt.id} modifiers: ${JSON.stringify(modResult.errors)}`).toBe(true);

      const ladderResult = validateLadder(evt.ladder);
      expect(ladderResult.ok, `${evt.id} ladder: ${JSON.stringify(ladderResult.errors)}`).toBe(true);
    }
  });

  it('every seasonal event has a well-formed recurrence', () => {
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
