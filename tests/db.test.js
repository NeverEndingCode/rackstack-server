process.env.DB_PATH = ':memory:';

import { describe, it, expect, beforeEach } from 'vitest';

// Dynamic import, deferred until after DB_PATH is set above: a static
// `import { driver } from ...` would be hoisted by the ESM spec above the
// process.env assignment and stand up the driver against the real on-disk
// DB_PATH default instead of :memory:.
const dbMod = await import('../server/db.js');
const {
  driver,
  upsertUser,
  getUserById,
  getRoles,
  setRoles,
  getToursCompleted,
  setToursCompleted,
  setUsername,
  dedupeUsernames,
  createMinigameSession,
  getMinigameSession,
  finishMinigameSession,
  getConfigRow,
  putConfigRow,
  getConfigHistory,
} = dbMod;

// Schema/table-existence assertions below are inherently backend-specific
// (sqlite_master, PRAGMA table_info); route them through the driver handle
// rather than a module-level `db` export so the intent stays explicit. The
// pg variant of these assertions is added in Task 4.
const db = driver.__raw;

function tableNames() {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
}

describe('db schema v1.2', () => {
  it('creates config, config_history, and minigame_sessions tables', async () => {
    const names = tableNames();
    expect(names).toContain('users');
    expect(names).toContain('saves');
    expect(names).toContain('config');
    expect(names).toContain('config_history');
    expect(names).toContain('minigame_sessions');
  });

  it('adds roles and custom_username columns to users', async () => {
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    expect(cols).toContain('roles');
    expect(cols).toContain('custom_username');
  });

  it('re-importing (guarded ALTER) does not throw on a second boot', async () => {
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
  it('is case-insensitive: Neo then neo collide', async () => {
    const u1 = await upsertUser({ provider: 'discord', providerId: 'u1', username: 'u1', avatarUrl: 'a1' });
    const u2 = await upsertUser({ provider: 'discord', providerId: 'u2', username: 'u2', avatarUrl: 'a2' });

    const r1 = await setUsername(u1.id, 'Neo');
    expect(r1).toEqual({ ok: true });
    expect((await getUserById(u1.id)).username).toBe('Neo');
    expect((await getUserById(u1.id)).custom_username).toBe(1);

    const r2 = await setUsername(u2.id, 'neo');
    expect(r2).toEqual({ ok: false, error: 'taken' });
    expect((await getUserById(u2.id)).username).toBe('u2');
  });

  it('excludes the user themself from the collision check (re-saving own name is fine)', async () => {
    const u1 = await upsertUser({ provider: 'discord', providerId: 'u3', username: 'u3', avatarUrl: 'a3' });
    expect(await setUsername(u1.id, 'Trinity')).toEqual({ ok: true });
    expect(await setUsername(u1.id, 'Trinity')).toEqual({ ok: true });
    expect(await setUsername(u1.id, 'trinity')).toEqual({ ok: true });
  });
});

describe('upsertUser', () => {
  it('preserves a custom username on re-login but updates avatar_url', async () => {
    const u = await upsertUser({ provider: 'github', providerId: 'g1', username: 'ghname', avatarUrl: 'old-avatar' });
    await setUsername(u.id, 'MyCoolName');

    const relogged = await upsertUser({ provider: 'github', providerId: 'g1', username: 'ghname-changed', avatarUrl: 'new-avatar' });
    expect(relogged.username).toBe('MyCoolName');
    expect(relogged.avatar_url).toBe('new-avatar');

    const stored = await getUserById(u.id);
    expect(stored.username).toBe('MyCoolName');
    expect(stored.avatar_url).toBe('new-avatar');
    expect(stored.custom_username).toBe(1);
  });

  it('still overwrites username from the OAuth profile when custom_username is 0', async () => {
    const u = await upsertUser({ provider: 'github', providerId: 'g2', username: 'first', avatarUrl: 'a' });
    const relogged = await upsertUser({ provider: 'github', providerId: 'g2', username: 'second', avatarUrl: 'b' });
    expect(relogged.username).toBe('second');
    expect((await getUserById(u.id)).username).toBe('second');
  });

  it('a returning user whose provider-supplied name now collides with a DIFFERENT user does not get locked out', async () => {
    // User A registers as Neo. User B registers as bob. B later renames
    // their OAuth display name to "neo" on the provider and logs in again -
    // upsertUser's UPDATE path must not throw SQLITE_CONSTRAINT_UNIQUE, and
    // B must come away with some available username, not be permanently
    // locked out of login.
    await upsertUser({ provider: 'discord', providerId: 'lockout-a', username: 'Neo', avatarUrl: null });
    const b = await upsertUser({ provider: 'discord', providerId: 'lockout-b', username: 'bob', avatarUrl: null });

    // Rewritten from expect(() => {...}).not.toThrow(): upsertUser is now
    // async, so a synchronous wrapper can never observe a throw - any
    // rejection here fails the test the same way a synchronous throw would
    // have under the old assertion.
    let relogged;
    relogged = await upsertUser({ provider: 'discord', providerId: 'lockout-b', username: 'neo', avatarUrl: 'new-avatar' });

    expect(relogged.username).not.toBe('Neo');
    expect(relogged.username.toLowerCase()).not.toBe('neo');
    expect(relogged.avatar_url).toBe('new-avatar');
    expect((await getUserById(b.id)).username).toBe(relogged.username);

    // And login keeps working on subsequent attempts too (not a one-shot fix).
    await upsertUser({ provider: 'discord', providerId: 'lockout-b', username: 'neo', avatarUrl: 'newer-avatar' });
  });

  it('a user with custom_username set is unaffected by provider-name changes (no collision risk from that path)', async () => {
    const a = await upsertUser({ provider: 'discord', providerId: 'custom-a', username: 'agent-smith', avatarUrl: null });
    await setUsername(a.id, 'Architect');

    // Someone else's provider now supplies the exact custom name as their
    // OAuth display name - since A's username is custom, upsertUser must
    // never even attempt to write "architect" for A, so there's nothing to
    // collide and A's stored username never changes on re-login.
    const relogged = await upsertUser({ provider: 'discord', providerId: 'custom-a', username: 'totally-different-oauth-name', avatarUrl: 'fresh' });
    expect(relogged.username).toBe('Architect');
    expect((await getUserById(a.id)).username).toBe('Architect');
    expect((await getUserById(a.id)).custom_username).toBe(1);
  });
});

describe('upsertUser username collisions on first login', () => {
  it('two different providers both requesting a case-variant of the same username both succeed with distinct usernames', async () => {
    const a = await upsertUser({ provider: 'github', providerId: 'collide-a', username: 'Morpheus', avatarUrl: null });
    // Rewritten from expect(() => {...}).not.toThrow(): see the lockout test
    // above for why a synchronous wrapper can no longer express this.
    let b;
    b = await upsertUser({ provider: 'discord', providerId: 'collide-b', username: 'morpheus', avatarUrl: null });

    expect(a.username.toLowerCase()).toBe('morpheus');
    expect(b.username).not.toBe(a.username);
    expect(b.username.toLowerCase()).not.toBe(a.username.toLowerCase());
    expect(b.username.toLowerCase()).toBe('morpheus-2');

    // Both persisted distinctly and are independently retrievable.
    expect((await getUserById(a.id)).username).toBe(a.username);
    expect((await getUserById(b.id)).username).toBe(b.username);
  });

  it('a three-way collision suffixes incrementally without throwing', async () => {
    const a = await upsertUser({ provider: 'x', providerId: 'c1', username: 'zion', avatarUrl: null });
    const b = await upsertUser({ provider: 'x', providerId: 'c2', username: 'Zion', avatarUrl: null });
    const c = await upsertUser({ provider: 'x', providerId: 'c3', username: 'ZION', avatarUrl: null });

    const usernames = [a.username, b.username, c.username].map((u) => u.toLowerCase());
    expect(new Set(usernames).size).toBe(3); // all distinct case-insensitively
    expect(usernames).toContain('zion');
    expect(usernames).toContain('zion-2');
    expect(usernames).toContain('zion-3');
  });
});

describe('dedupeUsernames', () => {
  it('suffixes later-created duplicates (case-insensitive), keeping the earliest untouched', async () => {
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

    await dedupeUsernames();

    expect((await getUserById('x:1')).username).toBe('Duplicate');
    expect((await getUserById('x:2')).username).toBe('duplicate-3');
    expect((await getUserById('x:3')).username).toBe('DUPLICATE-4');
    expect((await getUserById('x:4')).username).toBe('duplicate-2');

    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username COLLATE NOCASE)');
  });
});

describe('roles', () => {
  it('round-trips through getRoles/setRoles, defaulting to []', async () => {
    const u = await upsertUser({ provider: 'discord', providerId: 'r1', username: 'roleuser', avatarUrl: null });
    expect(await getRoles(u.id)).toEqual([]);
    await setRoles(u.id, ['admin', 'event_coordinator']);
    expect(await getRoles(u.id)).toEqual(['admin', 'event_coordinator']);
  });
});

describe('minigame sessions', () => {
  it('creates, fetches, and finishes a session', async () => {
    const u = await upsertUser({ provider: 'discord', providerId: 'm1', username: 'gamer', avatarUrl: null });
    const session = await createMinigameSession(u.id, 'rush');
    expect(session.id).toBeTypeOf('string');
    expect(session.user_id).toBe(u.id);
    expect(session.game).toBe('rush');
    expect(session.started_at).toBeTypeOf('number');
    expect(session.finished_at).toBeNull();
    expect(session.score).toBeNull();

    const fetched = await getMinigameSession(session.id);
    expect(fetched.id).toBe(session.id);
    expect(fetched.finished_at).toBeNull();

    await finishMinigameSession(session.id, 42);
    const done = await getMinigameSession(session.id);
    expect(done.score).toBe(42);
    expect(done.finished_at).toBeTypeOf('number');
  });

  it('generates unique ids per session', async () => {
    const u = await upsertUser({ provider: 'discord', providerId: 'm2', username: 'gamer2', avatarUrl: null });
    const s1 = await createMinigameSession(u.id, 'debug');
    const s2 = await createMinigameSession(u.id, 'debug');
    expect(s1.id).not.toBe(s2.id);
  });
});

describe('config', () => {
  it('getConfigRow returns undefined before anything is seeded', async () => {
    expect(await getConfigRow()).toBeUndefined();
  });

  it('putConfigRow upserts the singleton and records history', async () => {
    await putConfigRow(1, { schemaVersion: 1, heat: { capacity: 2000 } }, 'owner:1');
    const row = await getConfigRow();
    expect(row.version).toBe(1);
    expect(JSON.parse(row.data)).toEqual({ schemaVersion: 1, heat: { capacity: 2000 } });
    expect(row.updated_by).toBe('owner:1');

    await putConfigRow(2, { schemaVersion: 1, heat: { capacity: 3000 } }, 'owner:1');
    const row2 = await getConfigRow();
    expect(row2.version).toBe(2);
    expect(JSON.parse(row2.data).heat.capacity).toBe(3000);

    const history = await getConfigHistory();
    expect(history.length).toBe(2);
    // newest-first
    expect(history[0].version).toBe(2);
    expect(history[1].version).toBe(1);
  });
});

describe('db schema v1.6: tours_completed', () => {
  it('adds the tours_completed column to users', async () => {
    const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    expect(cols).toContain('tours_completed');
  });

  it('defaults a fresh user to an empty set', async () => {
    const u = await upsertUser({ provider: 'discord', providerId: 'tour1', username: 'tour1', avatarUrl: null });
    expect(await getToursCompleted(u.id)).toEqual([]);
  });

  it('round-trips a set of tour ids', async () => {
    const u = await upsertUser({ provider: 'discord', providerId: 'tour2', username: 'tour2', avatarUrl: null });
    await setToursCompleted(u.id, ['onboarding', 'v17-widgets']);
    expect(await getToursCompleted(u.id)).toEqual(['onboarding', 'v17-widgets']);
  });

  it('returns [] for an unknown user', async () => {
    expect(await getToursCompleted('no-such-user')).toEqual([]);
  });

  it('returns [] rather than throwing on corrupt JSON', async () => {
    const u = await upsertUser({ provider: 'discord', providerId: 'tour3', username: 'tour3', avatarUrl: null });
    db.prepare('UPDATE users SET tours_completed = ? WHERE id = ?').run('{not json', u.id);
    expect(await getToursCompleted(u.id)).toEqual([]);
  });
});
