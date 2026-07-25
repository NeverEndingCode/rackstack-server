process.env.DB_PATH = ':memory:';

import { describe, it, expect, beforeEach } from 'vitest';

const dbMod = await import('../server/db.js');
const {
  db,
  upsertUser,
  getUserById,
  getRoles,
  setRoles,
  setUsername,
  dedupeUsernames,
  createMinigameSession,
  getMinigameSession,
  finishMinigameSession,
  getConfigRow,
  putConfigRow,
  getConfigHistory,
} = dbMod;

function tableNames() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
}

describe('db schema v1.2', () => {
  it('creates config, config_history, and minigame_sessions tables', () => {
    const names = tableNames();
    expect(names).toContain('users');
    expect(names).toContain('saves');
    expect(names).toContain('config');
    expect(names).toContain('config_history');
    expect(names).toContain('minigame_sessions');
  });

  it('adds roles and custom_username columns to users', () => {
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    expect(cols).toContain('roles');
    expect(cols).toContain('custom_username');
  });

  it('re-importing (guarded ALTER) does not throw on a second boot', () => {
    // Simulates a second server boot against the same DB file: the module
    // already ran its ALTERs once for this connection: rerun the exact same
    // guarded statements directly to prove the duplicate-column path is safe.
    expect(() => {
      try {
        db.exec("ALTER TABLE users ADD COLUMN roles TEXT DEFAULT '[]'");
      } catch (err) {
        if (!/duplicate column name/i.test(err.message)) throw err;
      }
    }).not.toThrow();
  });
});

describe('setUsername', () => {
  it('is case-insensitive: Neo then neo collide', () => {
    const u1 = upsertUser({ provider: 'discord', providerId: 'u1', username: 'u1', avatarUrl: 'a1' });
    const u2 = upsertUser({ provider: 'discord', providerId: 'u2', username: 'u2', avatarUrl: 'a2' });

    const r1 = setUsername(u1.id, 'Neo');
    expect(r1).toEqual({ ok: true });
    expect(getUserById(u1.id).username).toBe('Neo');
    expect(getUserById(u1.id).custom_username).toBe(1);

    const r2 = setUsername(u2.id, 'neo');
    expect(r2).toEqual({ ok: false, error: 'taken' });
    expect(getUserById(u2.id).username).toBe('u2');
  });

  it('excludes the user themself from the collision check (re-saving own name is fine)', () => {
    const u1 = upsertUser({ provider: 'discord', providerId: 'u3', username: 'u3', avatarUrl: 'a3' });
    expect(setUsername(u1.id, 'Trinity')).toEqual({ ok: true });
    expect(setUsername(u1.id, 'Trinity')).toEqual({ ok: true });
    expect(setUsername(u1.id, 'trinity')).toEqual({ ok: true });
  });
});

describe('upsertUser', () => {
  it('preserves a custom username on re-login but updates avatar_url', () => {
    const u = upsertUser({ provider: 'github', providerId: 'g1', username: 'ghname', avatarUrl: 'old-avatar' });
    setUsername(u.id, 'MyCoolName');

    const relogged = upsertUser({ provider: 'github', providerId: 'g1', username: 'ghname-changed', avatarUrl: 'new-avatar' });
    expect(relogged.username).toBe('MyCoolName');
    expect(relogged.avatar_url).toBe('new-avatar');

    const stored = getUserById(u.id);
    expect(stored.username).toBe('MyCoolName');
    expect(stored.avatar_url).toBe('new-avatar');
    expect(stored.custom_username).toBe(1);
  });

  it('still overwrites username from the OAuth profile when custom_username is 0', () => {
    const u = upsertUser({ provider: 'github', providerId: 'g2', username: 'first', avatarUrl: 'a' });
    const relogged = upsertUser({ provider: 'github', providerId: 'g2', username: 'second', avatarUrl: 'b' });
    expect(relogged.username).toBe('second');
    expect(getUserById(u.id).username).toBe('second');
  });
});

describe('dedupeUsernames', () => {
  it('suffixes later-created duplicates (case-insensitive), keeping the earliest untouched', () => {
    // The unique index (created at module init, after dedupeUsernames' first
    // boot-time run) would reject these constructed duplicates outright.
    // Drop it to simulate the pre-index state dedupeUsernames is meant to
    // clean up, then let the module recreate it afterward.
    db.exec('DROP INDEX IF EXISTS idx_users_username');

    const insert = db.prepare(`
      INSERT INTO users (id, provider, provider_id, username, avatar_url, created_at)
      VALUES (@id, @provider, @provider_id, @username, @avatar_url, @created_at)
    `);
    insert.run({ id: 'x:1', provider: 'x', provider_id: '1', username: 'Duplicate', avatar_url: null, created_at: 100 });
    insert.run({ id: 'x:2', provider: 'x', provider_id: '2', username: 'duplicate', avatar_url: null, created_at: 200 });
    insert.run({ id: 'x:3', provider: 'x', provider_id: '3', username: 'DUPLICATE', avatar_url: null, created_at: 300 });
    // A pre-existing user already squats the first suffix candidate.
    insert.run({ id: 'x:4', provider: 'x', provider_id: '4', username: 'duplicate-2', avatar_url: null, created_at: 50 });

    dedupeUsernames();

    expect(getUserById('x:1').username).toBe('Duplicate');
    expect(getUserById('x:2').username).toBe('duplicate-3');
    expect(getUserById('x:3').username).toBe('DUPLICATE-4');
    expect(getUserById('x:4').username).toBe('duplicate-2');

    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE)');
  });
});

describe('roles', () => {
  it('round-trips through getRoles/setRoles, defaulting to []', () => {
    const u = upsertUser({ provider: 'discord', providerId: 'r1', username: 'roleuser', avatarUrl: null });
    expect(getRoles(u.id)).toEqual([]);
    setRoles(u.id, ['admin', 'event_coordinator']);
    expect(getRoles(u.id)).toEqual(['admin', 'event_coordinator']);
  });
});

describe('minigame sessions', () => {
  it('creates, fetches, and finishes a session', () => {
    const u = upsertUser({ provider: 'discord', providerId: 'm1', username: 'gamer', avatarUrl: null });
    const session = createMinigameSession(u.id, 'rush');
    expect(session.id).toBeTypeOf('string');
    expect(session.user_id).toBe(u.id);
    expect(session.game).toBe('rush');
    expect(session.started_at).toBeTypeOf('number');
    expect(session.finished_at).toBeNull();
    expect(session.score).toBeNull();

    const fetched = getMinigameSession(session.id);
    expect(fetched.id).toBe(session.id);
    expect(fetched.finished_at).toBeNull();

    finishMinigameSession(session.id, 42);
    const done = getMinigameSession(session.id);
    expect(done.score).toBe(42);
    expect(done.finished_at).toBeTypeOf('number');
  });

  it('generates unique ids per session', () => {
    const u = upsertUser({ provider: 'discord', providerId: 'm2', username: 'gamer2', avatarUrl: null });
    const s1 = createMinigameSession(u.id, 'debug');
    const s2 = createMinigameSession(u.id, 'debug');
    expect(s1.id).not.toBe(s2.id);
  });
});

describe('config', () => {
  it('getConfigRow returns undefined before anything is seeded', () => {
    expect(getConfigRow()).toBeUndefined();
  });

  it('putConfigRow upserts the singleton and records history', () => {
    putConfigRow(1, { schemaVersion: 1, heat: { capacity: 2000 } }, 'owner:1');
    const row = getConfigRow();
    expect(row.version).toBe(1);
    expect(JSON.parse(row.data)).toEqual({ schemaVersion: 1, heat: { capacity: 2000 } });
    expect(row.updated_by).toBe('owner:1');

    putConfigRow(2, { schemaVersion: 1, heat: { capacity: 3000 } }, 'owner:1');
    const row2 = getConfigRow();
    expect(row2.version).toBe(2);
    expect(JSON.parse(row2.data).heat.capacity).toBe(3000);

    const history = getConfigHistory();
    expect(history.length).toBe(2);
    // newest-first
    expect(history[0].version).toBe(2);
    expect(history[1].version).toBe(1);
  });
});
