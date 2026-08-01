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

// Also responsible for setting the env var(s) server/db/index.js's facade
// reads to pick its driver (DATABASE_URL for pg, DB_PATH for sqlite), so
// that logic lives in exactly one place rather than being repeated (and
// risking drift) at the top of every db-touching test file. In particular:
// server/db/index.js checks DATABASE_URL *first*, so an ambient value left
// over from a developer's shell (or set per Task 8's docs, since it's the
// production config var) would otherwise silently redirect a "sqlite"
// backend run at a real Postgres database instead of :memory: - this
// function's sqlite branch is the one place that guards against that, and
// its pg branch is the *only* place in the codebase allowed to set
// DATABASE_URL, so there's a single point of truth for both directions.
export async function provisionDatabase() {
  const backend = process.env.TEST_BACKEND === 'sqlite' ? 'sqlite' : 'pg';
  if (backend === 'sqlite') {
    delete process.env.DATABASE_URL;
    process.env.DB_PATH = ':memory:';
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
  process.env.DATABASE_URL = url.toString();
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
