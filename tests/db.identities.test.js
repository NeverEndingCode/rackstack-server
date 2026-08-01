import {
  describe, it, expect, afterAll,
} from 'vitest';
import { provisionDatabase } from './helpers/backend.js';

// Provision before importing the facade: DATABASE_URL/DB_PATH must be set
// before the dynamic import below, since the facade resolves its driver at
// module-evaluation time - a static `import { driver } from ...` would be
// hoisted by the ESM spec above the provisioning call and stand up the
// driver against the wrong backend/path.
const provisioned = await provisionDatabase();

const dbMod = await import('../server/db.js');
const {
  driver, upsertUser, getUserById, getSave, putSave, getAllUsersWithSaves, listIdentities,
} = dbMod;

afterAll(async () => {
  if (driver.__backend === 'pg') await driver.__raw.end();
  await provisioned.cleanup();
});

describe('identities split', () => {
  it('creates exactly one identity per user on first login', async () => {
    await upsertUser({
      provider: 'github', providerId: '37058311', username: 'nec', avatarUrl: null,
    });
    const ids = await listIdentities('github:37058311');
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ provider: 'github', provider_id: '37058311' });
    expect(ids[0].supertokens_user_id).toBeNull();
  });

  it('keeps users.id as provider:providerId', async () => {
    await upsertUser({
      provider: 'discord', providerId: '536626725380161537', username: 'st', avatarUrl: null,
    });
    const user = await getUserById('discord:536626725380161537');
    expect(user).toBeDefined();
    expect(user.id).toBe('discord:536626725380161537');
  });

  it('resolves a returning login through identities to the same user', async () => {
    await upsertUser({
      provider: 'github', providerId: 'ret', username: 'first', avatarUrl: null,
    });
    await putSave('github:ret', { marker: 'keep-me' }, 123);
    await upsertUser({
      provider: 'github', providerId: 'ret', username: 'renamed', avatarUrl: 'a.png',
    });
    const save = await getSave('github:ret');
    expect(JSON.parse(save.data).marker).toBe('keep-me');
    expect(await listIdentities('github:ret')).toHaveLength(1);
  });

  it('getAllUsersWithSaves still exposes provider', async () => {
    await upsertUser({
      provider: 'discord', providerId: 'agg', username: 'aggu', avatarUrl: null,
    });
    const rows = await getAllUsersWithSaves();
    expect(rows.find((r) => r.id === 'discord:agg').provider).toBe('discord');
  });

  it('migrates a pre-split SQLite database without losing saves', async () => {
    // Build a database in the OLD shape, then let applySchema() upgrade it.
    // Postgres-only test runs use this too - it's a pure SQLite in-memory
    // scenario (via better-sqlite3 directly), not routed through the
    // provisioned backend, so it always exercises the SQLite rebuild dance
    // regardless of which backend the rest of this file is running against.
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(':memory:');
    raw.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_id TEXT NOT NULL,
        username TEXT, avatar_url TEXT, created_at INTEGER NOT NULL,
        UNIQUE(provider, provider_id)
      );
      CREATE TABLE saves (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        data TEXT NOT NULL, last_save INTEGER NOT NULL
      );
      INSERT INTO users VALUES ('github:37058311','github','37058311','nec',NULL,1784859388645);
      INSERT INTO saves VALUES ('github:37058311','{"wafers":42}',1784859388999);
    `);

    const { applySchema } = await import('../server/db/schema.sqlite.js');
    await applySchema(raw);

    const user = raw.prepare('SELECT * FROM users WHERE id = ?').get('github:37058311');
    expect(user.username).toBe('nec');
    expect(user).not.toHaveProperty('provider');

    const identity = raw.prepare('SELECT * FROM identities WHERE user_id = ?').get('github:37058311');
    expect(identity).toMatchObject({ provider: 'github', provider_id: '37058311' });

    const save = raw.prepare('SELECT * FROM saves WHERE user_id = ?').get('github:37058311');
    expect(JSON.parse(save.data).wafers).toBe(42);
    expect(save.last_save).toBe(1784859388999);

    // Idempotency: a second boot over the already-migrated database must be
    // a pure no-op, not throw, and leave the data exactly as-is.
    await applySchema(raw);
    const userAgain = raw.prepare('SELECT * FROM users WHERE id = ?').get('github:37058311');
    expect(userAgain.username).toBe('nec');
    const identitiesAgain = raw.prepare('SELECT * FROM identities WHERE user_id = ?').all('github:37058311');
    expect(identitiesAgain).toHaveLength(1);
  });

  it('throws rather than silently drop an orphaned save during the rebuild', async () => {
    // Proves the post-rebuild foreign_key_check actually catches a real
    // violation, not just that it stays quiet on clean data. A save row
    // pointing at a user id that was never inserted is exactly what "an
    // orphaned save" means - foreign_keys is turned OFF for the setup so
    // this insert succeeds despite violating the declared FK, simulating
    // corruption that predates - or bypassed - enforcement (e.g. a raw
    // import, or data written before `driver.sqlite.js` started turning
    // enforcement on at boot).
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(':memory:');
    raw.pragma('foreign_keys = OFF');
    raw.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_id TEXT NOT NULL,
        username TEXT, avatar_url TEXT, created_at INTEGER NOT NULL,
        UNIQUE(provider, provider_id)
      );
      CREATE TABLE saves (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        data TEXT NOT NULL, last_save INTEGER NOT NULL
      );
      INSERT INTO users VALUES ('github:1','github','1','ok',NULL,1);
      INSERT INTO saves VALUES ('github:1','{}',1);
      INSERT INTO saves VALUES ('ghost:999','{}',1);
    `);

    const { applySchema } = await import('../server/db/schema.sqlite.js');
    await expect(applySchema(raw)).rejects.toThrow(/FK violations/);
  });
});
