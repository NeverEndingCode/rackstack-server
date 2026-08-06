import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/setup/pg-global.js'],
    // Each file gets its own database and its own module registry, so the
    // db facade's top-level await resolves per-file against that database.
    isolate: true,
    pool: 'forks',
    testTimeout: 30_000, // container start on a cold machine
  },
});
