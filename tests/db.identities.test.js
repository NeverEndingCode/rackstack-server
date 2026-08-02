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

// Forces INSERT INTO identities to fail for one specific provider_id, while
// leaving SELECT (the identity lookup at the top of upsertUser) completely
// unaffected - a trigger, not renaming the table away. Renaming the table
// breaks the lookup too, so upsertUser throws before ever reaching the
// users insert, and no write of either kind happens - that "passes" a
// naive rollback assertion for the wrong reason (nothing to roll back) and
// does not exercise the atomicity fix at all. This targets only the
// second write, after the first (INSERT INTO users) has already run, which
// is the actual failure mode the fix addresses.
async function blockIdentityInsert(providerId) {
  if (driver.__backend === 'sqlite') {
    driver.__raw.exec(`
      CREATE TRIGGER block_test_identity_insert BEFORE INSERT ON identities
      WHEN NEW.provider_id = '${providerId}'
      BEGIN SELECT RAISE(ABORT, 'forced failure for atomicity test'); END;
    `);
  } else {
    await driver.__raw.query(`
      CREATE OR REPLACE FUNCTION block_test_identity_insert() RETURNS trigger AS $$
      BEGIN
        IF NEW.provider_id = '${providerId}' THEN
          RAISE EXCEPTION 'forced failure for atomicity test';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER block_test_identity_insert_trigger BEFORE INSERT ON identities
      FOR EACH ROW EXECUTE FUNCTION block_test_identity_insert();
    `);
  }
}

async function unblockIdentityInsert() {
  if (driver.__backend === 'sqlite') {
    driver.__raw.exec('DROP TRIGGER IF EXISTS block_test_identity_insert');
  } else {
    await driver.__raw.query(`
      DROP TRIGGER IF EXISTS block_test_identity_insert_trigger ON identities;
      DROP FUNCTION IF EXISTS block_test_identity_insert();
    `);
  }
}

describe('identities split', () => {
  it('creates exactly one identity per user on first login, with last_login_at set immediately', async () => {
    await upsertUser({
      provider: 'github', providerId: '37058311', username: 'nec', avatarUrl: null,
    });
    const ids = await listIdentities('github:37058311');
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatchObject({ provider: 'github', provider_id: '37058311' });
    expect(ids[0].supertokens_user_id).toBeNull();
    // Previously only set on a *returning* login's UPDATE - a brand-new
    // identity is itself a login and should not require a second one before
    // last_login_at is populated.
    expect(ids[0].last_login_at).toBeTypeOf('number');
    expect(ids[0].last_login_at).toBe(ids[0].created_at);
  });

  it('keeps users.id as provider:providerId', async () => {
    await upsertUser({
      provider: 'discord', providerId: '536626725380161537', username: 'st', avatarUrl: null,
    });
    const user = await getUserById('discord:536626725380161537');
    expect(user).toBeDefined();
    expect(user.id).toBe('discord:536626725380161537');
  });

  it('resolves a returning login through identities to the same user, bumping last_login_at', async () => {
    await upsertUser({
      provider: 'github', providerId: 'ret', username: 'first', avatarUrl: null,
    });
    await putSave('github:ret', { marker: 'keep-me' }, 123);
    const [firstLogin] = await listIdentities('github:ret');
    expect(firstLogin.last_login_at).toBeTypeOf('number');

    await upsertUser({
      provider: 'github', providerId: 'ret', username: 'renamed', avatarUrl: 'a.png',
    });
    const save = await getSave('github:ret');
    expect(JSON.parse(save.data).marker).toBe('keep-me');
    const identities = await listIdentities('github:ret');
    expect(identities).toHaveLength(1);
    // The returning-login path updates last_login_at on the SAME identity
    // row, not >= the first value strictly (two calls in the same test can
    // land in the same millisecond), so pin "still populated", not "grew".
    expect(identities[0].last_login_at).toBeTypeOf('number');
    expect(identities[0].last_login_at).toBeGreaterThanOrEqual(firstLogin.last_login_at);
  });

  it('getAllUsersWithSaves still exposes provider', async () => {
    await upsertUser({
      provider: 'discord', providerId: 'agg', username: 'aggu', avatarUrl: null,
    });
    const rows = await getAllUsersWithSaves();
    expect(rows.find((r) => r.id === 'discord:agg').provider).toBe('discord');
  });

  it('getAllUsersWithSaves returns provider: null for a user with no identity row, rather than dropping them', async () => {
    // Pins the correlated subquery as a LEFT-style lookup: a future
    // refactor to an inner join would silently drop this user from the
    // admin list instead of surfacing them with a null provider.
    const now = Date.now();
    if (driver.__backend === 'sqlite') {
      driver.__raw.prepare(
        'INSERT INTO users (id, username, avatar_url, created_at) VALUES (?, ?, ?, ?)',
      ).run('orphan:no-identity', 'orphaned', null, now);
    } else {
      await driver.__raw.query(
        'INSERT INTO users (id, username, avatar_url, created_at) VALUES ($1, $2, $3, $4)',
        ['orphan:no-identity', 'orphaned', null, now],
      );
    }

    const rows = await getAllUsersWithSaves();
    const row = rows.find((r) => r.id === 'orphan:no-identity');
    expect(row).toBeDefined();
    expect(row.provider).toBeNull();
  });

  it('rolls back the whole write if the identities insert fails, leaving no orphaned users row', async () => {
    // Forces upsertUser's SECOND write (INSERT INTO identities) to fail,
    // specifically after the FIRST write (INSERT INTO users) has already
    // run - the actual failure mode the fix addresses. Before the writes
    // were made transactional, this state (a users row with no matching
    // identity) was a *permanent* lockout: the next login attempt's
    // identity lookup would miss (the row IS there to find), retry INSERT
    // INTO users with the same primary key, and raise a constraint code
    // neither retry guard recognizes.
    await blockIdentityInsert('atomic-1');
    try {
      await expect(upsertUser({
        provider: 'github', providerId: 'atomic-1', username: 'atomicuser', avatarUrl: null,
      })).rejects.toThrow();

      // The users insert must have rolled back along with the failed
      // identities insert - not left as an orphan.
      expect(await getUserById('github:atomic-1')).toBeUndefined();
    } finally {
      await unblockIdentityInsert();
    }

    // With the block lifted, the exact same login must now succeed
    // cleanly - proving the earlier failure didn't leave any partial state
    // (e.g. a half-written users row) behind to trip up a retry.
    const user = await upsertUser({
      provider: 'github', providerId: 'atomic-1', username: 'atomicuser', avatarUrl: null,
    });
    expect(user.id).toBe('github:atomic-1');
    expect(await listIdentities('github:atomic-1')).toHaveLength(1);
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
    // Byte-for-byte, not just the parsed field - interface.md states JSON
    // columns round-trip exactly as stored, and a parsed-field check alone
    // wouldn't catch e.g. whitespace or key-order drift introduced by the
    // rebuild's SELECT/INSERT.
    expect(save.data).toBe('{"wafers":42}');
    expect(save.last_save).toBe(1784859388999);

    // Idempotency: a second boot over the already-migrated database must be
    // a pure no-op, not throw, and leave the data exactly as-is.
    await applySchema(raw);
    const userAgain = raw.prepare('SELECT * FROM users WHERE id = ?').get('github:37058311');
    expect(userAgain.username).toBe('nec');
    const identitiesAgain = raw.prepare('SELECT * FROM identities WHERE user_id = ?').all('github:37058311');
    expect(identitiesAgain).toHaveLength(1);
  });

  it('throws rather than silently drop an orphaned save during the rebuild, and rolls the rebuild back', async () => {
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

    // Pins the rollback, not just the rejection: if the check ran after
    // COMMIT (the pre-fix ordering), `users` would already be the rebuilt,
    // provider-less table even though applySchema threw - a crashed boot
    // that quietly "fixed itself" on the very next boot, at which point the
    // guard sees no `provider` column and never checks again. Asserting the
    // OLD shape survived is the only way to tell the two apart.
    const cols = raw.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
    expect(cols).toContain('provider');
  });
});
