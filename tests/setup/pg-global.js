// Vitest globalSetup for the Postgres test backend.
//
// Boots one shared Postgres container via Testcontainers and publishes it as
// TEST_DATABASE_URL. Each test file then carves its own database out of that
// container (see tests/helpers/backend.js) so the 19 db-touching suites
// can't see each other's rows, without paying for a fresh container per file.
//
// Container runtime: this only runs locally. CI sets TEST_DATABASE_URL
// itself (a Postgres service container - see .github/workflows/test.yml),
// so `setup()` returns immediately there and Testcontainers is never
// touched in CI.
//
// Locally this machine (and most Linux dev boxes without Docker Desktop)
// has no `docker` binary, only Podman, which serves a Docker-compatible API
// over a rootless per-user socket. Testcontainers talks to whatever
// DOCKER_HOST points at, so pointing it at the Podman socket - only when the
// developer hasn't already set DOCKER_HOST themselves - is enough to make
// Testcontainers work unmodified on either engine.
//
// Ryuk (Testcontainers' orphan-container reaper) needs privileges rootless
// Podman doesn't grant it (it mounts the container socket into a privileged
// reaper container), so it's disabled below whenever it hasn't been set
// explicitly. With Ryuk off, this module's teardown() is the *only* thing
// that stops and removes the container - StartedTestContainer#stop() removes
// the container and its volumes by default, so no reaper is needed as long
// as teardown() runs. If a run is killed hard enough that globalTeardown
// never fires (e.g. SIGKILL), the container is left running; `podman ps` and
// `podman rm -f` clean that up manually.
// Testcontainers is imported dynamically, inside setup(), AFTER both early
// returns - never at module scope. It is a local-only convenience, and its
// dependency tree is not loadable on the Node version this project ships on:
// testcontainers pulls in undici@8, which declares `engines: node >=22.19`
// and throws `webidl.util.markAsUncloneable is not a function` the moment it
// is required on Node 20. The Dockerfile runs node:20-bookworm-slim and CI
// matches it deliberately, so a top-level import here crashed BOTH matrix
// jobs before a single test file was collected ("No test files found") - the
// sqlite job too, which has nothing to do with Postgres, because an ES
// import is hoisted and runs regardless of the early return below.
//
// CI supplies TEST_DATABASE_URL from a service container and never needs
// Testcontainers at all, so deferring the import keeps CI on the same Node
// version as production while local runs still get an automatic container.
import { existsSync } from 'node:fs';

// Fully-qualified so it resolves identically on Docker and on Podman
// installs that have no unqualified-search registries configured (Podman's
// default on many distros, including Fedora).
const POSTGRES_IMAGE = 'docker.io/library/postgres:16';

function podmanSocketPath() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000;
  return `/run/user/${uid}/podman/podman.sock`;
}

function configureContainerRuntime() {
  if (!process.env.DOCKER_HOST) {
    const socket = podmanSocketPath();
    if (existsSync(socket)) {
      process.env.DOCKER_HOST = `unix://${socket}`;
    }
  }
  // Rootless Podman can't grant Ryuk the privileges it wants; leaving Ryuk
  // enabled makes container startup hang waiting for a reaper that will
  // never come up. Don't override an explicit developer/CI choice.
  if (process.env.TESTCONTAINERS_RYUK_DISABLED === undefined) {
    process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
  }
}

let container;

export async function setup() {
  if (process.env.TEST_BACKEND === 'sqlite') return;
  if (process.env.TEST_DATABASE_URL) return; // CI supplies a service container

  configureContainerRuntime();

  const { PostgreSqlContainer } = await import('@testcontainers/postgresql');
  container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  process.env.TEST_DATABASE_URL = container.getConnectionUri();
}

export async function teardown() {
  if (!container) return;
  const toStop = container;
  container = undefined;
  await toStop.stop();
}
