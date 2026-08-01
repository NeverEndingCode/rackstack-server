// Per-test-file database provisioning.
//
// tests/setup/pg-global.js stands up one shared Postgres container (or, in
// CI, points at the service container) and publishes it as
// TEST_DATABASE_URL. provisionDatabase() carves an isolated database out of
// that container for the calling test file, so the 19 db-touching suites
// can run in parallel (vitest pool: 'forks') without seeing each other's
// rows - and so each file exercises the real CREATE DATABASE + schema
// creation path rather than sharing state.
import pg from 'pg';
import { randomUUID } from 'node:crypto';

export async function provisionDatabase() {
  const backend = process.env.TEST_BACKEND === 'sqlite' ? 'sqlite' : 'pg';
  if (backend === 'sqlite') {
    return { backend, path: ':memory:', cleanup: async () => {} };
  }

  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) throw new Error('TEST_DATABASE_URL not set - is the vitest globalSetup running?');

  const name = `rackstack_test_${randomUUID().replace(/-/g, '')}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return {
    backend,
    url: url.toString(),
    cleanup: async () => {
      const a = new pg.Client({ connectionString: adminUrl });
      await a.connect();
      try {
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}
