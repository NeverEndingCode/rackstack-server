import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveSqlitePath } from '../server/db/shared.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Regression guard for a silent-data-loss path: db/index.js (which OPENS the
// SQLite file) and db/migrate.js (which READS it as the migration source)
// each used to carry their own default for DB_PATH, and the two disagreed.
// migrate.js defaulted to the container path '/app/data/rackstack.db' while
// the facade defaulted to a repo-relative path. Any run with DATABASE_URL set
// and DB_PATH unset - i.e. anything not started from the Docker image, since
// only the Dockerfile supplies DB_PATH - had the migrator probe a path that
// did not exist, conclude 'fresh Postgres install', skip the migration, and
// boot the server against an empty Postgres while the real saves sat
// untouched at the other path. No error, no fatal guard: the skip branch is
// the one branch that is deliberately not fatal.
describe('resolveSqlitePath', () => {
  it('honours an explicit DB_PATH', () => {
    expect(resolveSqlitePath({ DB_PATH: '/somewhere/else/rackstack.db' }))
      .toBe('/somewhere/else/rackstack.db');
  });

  it('falls back to the repo-relative data directory, not the container path', () => {
    const resolved = resolveSqlitePath({});
    expect(resolved).toBe(path.join(repoRoot, 'data', 'rackstack.db'));
    // The container path is supplied by the Dockerfile's ENV DB_PATH, so it
    // must never be baked in as a code-level default.
    expect(resolved).not.toBe('/app/data/rackstack.db');
  });

  it('returns an absolute path so callers can fs.existsSync it regardless of cwd', () => {
    expect(path.isAbsolute(resolveSqlitePath({}))).toBe(true);
  });
});

// The defect was two modules disagreeing, so the property under test is
// agreement, not either value on its own. Asserting it at the source level is
// what makes this discriminating: importing db/index.js here would resolve a
// driver (it has a top-level await) against whatever this test run points at,
// which is exactly what the boot sequence goes out of its way to avoid.
describe('the SQLite path has exactly one authority', () => {
  const facade = fs.readFileSync(path.join(repoRoot, 'server/db/index.js'), 'utf8');
  const migrator = fs.readFileSync(path.join(repoRoot, 'server/db/migrate.js'), 'utf8');

  it('has both the facade and the migrator resolve it through resolveSqlitePath', () => {
    expect(facade).toContain('resolveSqlitePath');
    expect(migrator).toContain('resolveSqlitePath');
  });

  it('leaves no hardcoded container path in either module', () => {
    expect(facade).not.toContain("'/app/data/rackstack.db'");
    expect(migrator).not.toContain("'/app/data/rackstack.db'");
  });

  it('has neither module reading DB_PATH directly any more', () => {
    // A direct `env.DB_PATH || <default>` re-introduces the divergence even
    // if resolveSqlitePath is also imported.
    expect(facade).not.toMatch(/DB_PATH\s*\|\|/);
    expect(migrator).not.toMatch(/DB_PATH\s*\|\|/);
  });
});
