# `server/db/` — repository interface

`server/db.js` is a re-export shim (`export * from './db/index.js';`) kept so
none of the existing `import { ... } from './db.js'` / `'../db.js'` call
sites need to change. New code should import from `server/db/index.js`
directly.

## Layout

- `index.js` — the facade. Picks a driver at boot (`createPgDriver` when
  `DATABASE_URL` is set, `createSqliteDriver` otherwise) and re-exports
  every interface function as a top-level named export, plus `driver`
  itself.
- `driver.sqlite.js` — `createSqliteDriver({ path }) → Promise<Driver>`.
  Owns every `better-sqlite3`-specific query.
- `driver.pg.js` — `createPgDriver({ url }) → Promise<Driver>`. Owns every
  `pg`-specific query, and registers the `int8` type parser (BIGINT ->
  number) at module scope, before any query runs.
- `schema.sqlite.js` — DDL and schema-version bookkeeping for the SQLite
  backend: `applySchema(db)`, `appliedVersions(db)`, `markApplied(db, version)`.
- `schema.pg.js` — the Postgres equivalent DDL and bookkeeping:
  `applySchema(pool)`, `appliedVersions(pool)`, `markApplied(pool, version)`.
  Unlike `schema.sqlite.js`, there's no guarded-ALTER history to replay -
  every column ships in its `CREATE TABLE` from the start.
- `shared.js` — dialect-free helpers used by every driver: username-suffixing,
  event-row JSON parsing, and the camelCase/snake_case row normalizers for
  `putEvent`/`upsertParticipation`. No SQL lives here.

## The `Driver` contract

`createSqliteDriver` and `createPgDriver` each resolve to an object with
exactly these keys:

- `__backend` — `'sqlite'` or `'pg'`. Test-only; used to skip
  backend-specific assertions (e.g. `sqlite_master`/`PRAGMA` introspection
  vs. `pg_tables`/`information_schema`) under the other driver.
- `__raw` — the underlying driver handle (`better-sqlite3`'s `Database`, or
  the `pg.Pool`). Test-only, for schema assertions. Application code must
  never touch `__raw`; only the facade and driver files interact with the
  underlying database.
- Every interface function below, all `async`.

### Interface functions

```
upsertUser, getUserById, getAllUsersWithSaves, getSave, putSave,
deleteSave, getRoles, setRoles, getToursCompleted, setToursCompleted,
setUsername, dedupeUsernames, createMinigameSession, getMinigameSession,
getOpenMinigameSession, finishMinigameSession, getConfigRow, putConfigRow,
getConfigHistory, listEvents, getEvent, getActiveEvent, putEvent,
setEventStatus, deleteEvent, upsertParticipation, getParticipation,
updateParticipationProgress, listParticipation, setLeaderboardOptOut,
listLeaderboard, getLatestEventId, seedSeasonalEvents, listIdentities
```

`tests/db.interface.test.js` asserts this exact list is exported as
functions from `server/db/index.js`, and that each one returns a promise.
That test is the contract: a driver that adds, drops, or renames any of
these breaks every consumer.

### Behavioural invariants a new driver must preserve

- A missing row resolves to `undefined` (not `null`), matching
  `better-sqlite3`'s `.get()` — several existing tests assert
  `toBeUndefined()` specifically.
- JSON columns (`saves.data`, `config.data`, `live_events.theme` /
  `modifiers` / `ladder` / `recurrence`) are stored as `TEXT`, written with
  `JSON.stringify` and read back with `JSON.parse` at the same boundaries
  as today. No `jsonb` or driver-side JSON typing.
- Username collision handling goes through `shared.js`'s
  `findAvailableUsername` — same `-2`, `-3`, ... suffixing convention,
  same COLLATE-NOCASE-equivalent case-insensitivity, regardless of driver.
- `putEvent` / `upsertParticipation` accept either camelCase or snake_case
  keys on their input, via `shared.js`'s `normalizeEventRow` /
  `normalizeParticipationRow`.
- `users.id` (the literal string `provider:providerId`) never changes once
  assigned — it's the target of 3 foreign keys and the value operators put
  in `SUPER_ADMIN_IDS`. Login methods live in `identities`, keyed
  `(provider, provider_id)` with a `user_id` FK back to `users`; `upsertUser`
  resolves through it. `getAllUsersWithSaves()` still exposes a `provider`
  field — the user's *primary* identity (earliest `created_at`, ties broken
  by provider name), not necessarily their only one.

## Schema versioning

`schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`
tracks which numbered migrations have run. `appliedVersions(db)` returns the
applied set; `markApplied(db, version)` records one. Still not consumed by
`applySchema` — Task 5 (the identities split) turned out not to need it:
both schemas self-guard their one-time migration step directly (SQLite via
`PRAGMA table_info`, Postgres via `information_schema.columns`), the same
pattern `guardedAddColumn` already used for every column added since v1.2.
