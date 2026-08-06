# Postgres Migration & SuperTokens Foundation — Design

**Date:** 2026-08-01
**Status:** Approved
**Releases:** v1.7 (Postgres) → v1.8 (SuperTokens)

## 1. Goal

Move RackStack's persistence from SQLite to PostgreSQL without losing a single
row of production data, and lay the auth groundwork so SuperTokens can be
adopted afterwards without breaking existing Discord/GitHub logins.

Two motivations, in the owner's words: longevity, and a path to SuperTokens for
better future automation.

## 2. Decisions

These were settled explicitly during brainstorming and are not open questions:

| Question | Decision |
|---|---|
| Backend | **Dual backend, Postgres default.** SQLite stays supported behind the same interface. |
| Tests | **Real Postgres via Docker** (Testcontainers locally, service container in CI). |
| Migration trigger | **Auto on boot, guarded**, and the same script runnable by hand. |
| Auth split | **Do it now** — extract an `identities` table in v1.7. |
| Sequencing | **Two releases, one design.** v1.7 ships and is confirmed in production before v1.8 starts. |
| Verification data | Owner supplies a current Unraid export. |

### 2.1 A consequence worth stating plainly

Dual backend plus Postgres-only tests would mean shipping a SQLite driver that
nothing exercises — dialect drift is precisely the bug class that loses data.
Therefore the vitest suite runs **twice, once per backend**:

- `npm test` → Postgres (the default, what CI gates on)
- `npm run test:sqlite` → SQLite
- `npm run test:all` → both; CI runs this

A backend that is shipped is a backend that is tested. No exceptions.

## 3. Current state (measured, not assumed)

- **7 tables**, all DDL and SQL confined to `server/db.js` (~600 lines).
- **~35 exported functions** form the de facto repository interface.
- **111 call sites** across 8 server files (`routes/api.js` 35, `eventService.js`
  18, `configService.js` 8, `stateService.js` 6, `auth.js` 3,
  `leaderboardService.js` 3, `index.js` 1).
- **181 call sites** across 19 test files; 2 test files (`db.test.js`,
  `db.events.test.js`) reach past the interface into raw `db.prepare`.
- **No transactions anywhere** in the codebase.
- v1.5 social state (contracts, achievements, streak) lives inside the
  `saves.data` JSON blob, not in tables — it needs no schema work.
- `users.id` is the literal string `` `${provider}:${providerId}` ``,
  constructed in exactly one place (`server/db.js`), referenced by 3 foreign
  keys and by the `SUPER_ADMIN_IDS` env var.

## 4. Release v1.7 — Postgres

No user-visible behaviour changes. No auth changes. This release is a port.

### 4.1 Architecture

`server/db.js` becomes a facade over a driver selected at boot by the presence
of `DATABASE_URL` (absent → SQLite).

```
server/db/index.js          facade: driver selection, re-exports the interface
server/db/schema.pg.js      Postgres DDL
server/db/schema.sqlite.js  SQLite DDL
server/db/driver.pg.js      pg.Pool implementation
server/db/driver.sqlite.js  better-sqlite3 implementation
server/db/migrate.js        one-shot SQLite → Postgres copier
```

Two hand-written drivers were chosen over a query builder (Kysely) or a
single-SQL-plus-dialect-shim. Rationale: the schema is small and stable, the
codebase's existing style is hand-written heavily-commented SQL, and a leaky
shim is worse than honest duplication. The accepted cost is that every future
query is written twice — the backend test matrix is what keeps that honest.

Each driver module exports the same ~35 functions. No caller may reach past the
facade; the two tests that currently use raw `db.prepare` are rewritten against
the interface or moved behind a driver-specific escape hatch used only for
schema assertions.

### 4.2 The interface becomes async

`better-sqlite3` is synchronous; `pg` is not. An async interface wraps a sync
implementation trivially (`async getSave(id) { return stmt.get(id); }`), so the
interface is async for both drivers and the refactor happens once.

This is the bulk of the diff: 111 server call sites and 181 test call sites gain
`await`, and their enclosing functions become `async`. Mechanical, but it
touches `routes/api.js` heavily — every route handler becomes `async` and needs
error propagation checked (an unhandled rejection in an Express 4 handler does
not reach the error middleware; each handler must keep its try/catch or gain
one).

### 4.3 Schema translation

Epoch-millisecond timestamps become `BIGINT`, never `INTEGER` — `int4` overflows
in 2038. Boolean-ish flags stay `SMALLINT` 0/1 rather than becoming `BOOLEAN`,
so the existing `? 1 : 0` write logic and truthiness reads are untouched.

JSON columns (`saves.data`, `config.data`, `live_events.modifiers`, etc.) stay
**`TEXT`, not `jsonb`**. `jsonb` reorders object keys, strips insignificant
whitespace, and outright rejects `\u0000` inside strings — any of which would
mean a save does not round-trip byte-for-byte. The application already
`JSON.parse`s these itself, so `jsonb` buys nothing here.

| SQLite construct | Postgres equivalent | Consequence if missed |
|---|---|---|
| `ORDER BY rowid` in `getConfigHistory` | `id BIGSERIAL PRIMARY KEY`, order by it | Postgres has no `rowid`; config history order is **silently lost** |
| `UNIQUE INDEX ... (username COLLATE NOCASE)` | `CREATE UNIQUE INDEX ... ON users (lower(username))` | case-insensitive username uniqueness breaks |
| `WHERE username = ? COLLATE NOCASE` (3 sites) | `WHERE lower(username) = lower($1)` | duplicate usernames slip through |
| `INSERT OR IGNORE` | `ON CONFLICT DO NOTHING` | seasonal event seeding throws on reboot |
| `@named` parameters | `$1` positional | — (per-driver) |
| `SQLITE_CONSTRAINT_UNIQUE` / `SQLITE_CONSTRAINT` | SQLSTATE `23505` | the `upsertUser` collision retry stops working and **locks users out on login** |
| `INTEGER` epoch ms | `BIGINT` | overflow in 2038 |
| `INTEGER` 0/1 flags | `SMALLINT` | — (deliberate parity choice) |

`ON CONFLICT (...) DO UPDATE SET ... excluded.x` is compatible across both and
needs no change.

### 4.4 Auth split — the `identities` table

`users.id` **does not change.** It remains `provider:providerId`, keeping all 3
foreign keys and `SUPER_ADMIN_IDS` working untouched. Login methods move out:

```sql
users       -- id (PK, UNCHANGED), username, avatar_url, created_at,
            -- roles, custom_username, leaderboard_opt_out, tours_completed
            -- provider and provider_id are REMOVED

identities  -- PRIMARY KEY (provider, provider_id)
            -- user_id      → users(id) ON DELETE CASCADE
            -- supertokens_user_id TEXT UNIQUE NULL   (filled in v1.8)
            -- created_at BIGINT NOT NULL, last_login_at BIGINT NULL
```

The migration inserts exactly one `identities` row per existing user, carrying
`users.created_at` across.

Affected functions:

- `upsertUser({provider, providerId, ...})` — look up `identities` by
  `(provider, provider_id)`; found → load that `users` row; not found → create
  both rows. The existing username-collision retry logic is preserved verbatim,
  including both the INSERT and UPDATE paths.
- `getAllUsersWithSaves()` — currently selects `u.provider`. It gains a join and
  returns the **primary identity's** provider (lowest `created_at`, ties broken
  by provider name). Since no user has more than one identity until v1.8 ships a
  linking flow, its output today is byte-identical to current behaviour. The
  admin roles UI needs no change.

This is what makes v1.8 cheap: `supertokens_user_id` is the linkage column, and
multi-identity accounts ("log in with Discord *or* GitHub, same save") become
possible without further schema work.

### 4.5 Migration script

`server/db/migrate.js`, exposed as `npm run migrate:pg` and invoked
automatically at boot under the guards in §4.6.

**The WAL trap.** SQLite holds recent commits in `rackstack.db-wal`. Copying
only `rackstack.db` loses the newest data. The stale copy already sitting in
`~/Downloads` has a `-wal` file beside it, so this is a live risk, not a
hypothetical. The runbook requires stopping the container first and copying all
three files. The migrator additionally refuses to run against a database whose
`-wal` file exists but cannot be read, rather than silently migrating stale data.

Safety properties, all mandatory:

1. Stop-the-world: the migrator runs before the HTTP server binds a port.
2. WAL checkpointed (`PRAGMA wal_checkpoint(TRUNCATE)`) before any read.
3. The entire copy runs in **one Postgres transaction**. Any failure rolls back
   the whole thing — never a partial import.
4. Verification **before** `COMMIT`:
   - per-table row counts match exactly;
   - every `saves.data` compared as an exact string, plus `last_save`;
   - a SHA-256 manifest over each table's rows in primary-key order, computed on
     both sides and compared.
   Any mismatch → `ROLLBACK`, log the offending table and key, exit non-zero.
5. The SQLite file is **opened for reading only in the copy path** and is never
   modified beyond the checkpoint, never deleted. It is the rollback artifact.
6. Idempotent: re-running against a populated Postgres is a no-op that exits 0
   with a clear message.

**Old-schema tolerance.** The migrator reads whatever tables exist and defaults
the rest. The `~/Downloads` v1.1-era copy (only `users` + `saves`, 4 rows each,
no config/events/tours) becomes a committed test fixture for this path.

### 4.6 Boot behaviour

On startup, when `DATABASE_URL` is set:

| Postgres state | `rackstack.db` present | Action |
|---|---|---|
| schema empty | yes | migrate, verify, then serve |
| schema empty | no | create schema, serve (fresh install) |
| already populated | either | skip migration entirely, serve |
| migration fails | — | **refuse to start**, non-zero exit |

Refusing to start on failure is deliberate: serving an empty game to real
players is worse than being down, and an operator who sees a stopped container
investigates, whereas one who sees an empty leaderboard may not.

Every step logs loudly with a `[migrate]` prefix, including row counts moved.

### 4.7 Unraid runbook

1. Add an official `postgres:16` container; appdata path of its own; create a
   `rackstack` database.
2. **Stop** the rackstack container.
3. Back up `/mnt/user/appdata/rackstack-server/data/` — all three
   `rackstack.db*` files.
4. Set `DATABASE_URL=postgresql://user:pass@host:5432/rackstack` on the
   rackstack container. **Leave the `/app/data` mapping in place.**
5. Start it. Watch the log for the `[migrate]` summary and the row counts.

Rollback at any point: unset `DATABASE_URL` and restart. SQLite data is
untouched.

The Unraid template gains `DATABASE_URL` and its `<Overview>`/data-path
descriptions are updated to stop describing SQLite as the whole story.

### 4.8 Testing

- Testcontainers spins up `postgres:16` locally; CI uses a `services: postgres`
  container. Each test file gets a fresh schema (a per-worker database or
  schema namespace) replacing today's `DB_PATH=':memory:'`.
- The full suite runs against both backends (§2.1).
- A dedicated migration test: seed a SQLite fixture → migrate → assert every
  table's rows and every save's bytes are identical, and that the verification
  step actually fails when a row is deliberately corrupted (test the guard, not
  just the happy path).
- Existing e2e smoke suites (`smoke-v12` … `smoke-v16`) must pass against
  Postgres unchanged.

### 4.9 Dockerfile

`pg` is pure JS. `better-sqlite3` remains a dependency (dual backend) so the
python3/make/g++ build stage stays. `DB_PATH` keeps its default so a
`DATABASE_URL`-less container behaves exactly as today.

## 5. Release v1.8 — SuperTokens

Starts only after v1.7 is confirmed running in production.

> **Status (2026-08-06).** v1.7 is merged, tagged `v1.7.0`, and published to
> GHCR — but **has not been cut over on the owner's Unraid box**, and the
> production export §5.5 depends on has not been supplied. Implementation of
> v1.8 is under way regardless, because `AUTH_MODE` defaults to `passport` and
> every part of the release is inert until an operator changes it. The two
> things genuinely gated on production are unchanged: running shadow mode
> against real identities, and cutting over to `dual`. Neither has happened.
>
> Implementation plan: `docs/superpowers/plans/2026-08-06-v1.8-supertokens.md`.
> Operator runbook: `docs/supertokens-rollout-runbook.md`.
> Progress: **all 7 tasks built.** 587 tests green on SQLite, 610 on
> Postgres, 39 e2e smoke assertions, and a real boot verified in each of the
> three `AUTH_MODE` values. Version bumped to 1.8.0; not yet tagged.
>
> One gap found in Task 4 and deliberately not closed in this release: the
> client does not use the SuperTokens frontend SDK, so it cannot refresh an
> expired access token. This does not affect `dual` (the legacy cookie still
> authenticates and the player stays logged in), but a `supertokens`-only
> cutover needs frontend refresh handling first. **`dual` is the intended
> resting state for v1.8.**
>
> Still true, and unchanged by any of the above: shadow mode has not been run
> against production identities, and no cutover has happened anywhere.

### 5.1 Containers

- `registry.supertokens.io/supertokens/supertokens-postgresql`, port 3567.
- `POSTGRESQL_CONNECTION_URI` pointing at its **own database** on the same
  Postgres instance stood up in v1.7.
- Two documented footguns: the scheme must be `postgresql://` (`postgres://`
  fails at startup), and the host may not be `localhost`/`127.0.0.1` from inside
  a container.

> **Scoping correction (2026-08-06).** The `postgres://` warning applies to the
> **SuperTokens core only**. v1.7 established that RackStack's own
> `DATABASE_URL` accepts either scheme — `pg-connection-string` parses them
> identically, verified directly — and three documents that had repeated the
> broader claim were corrected in v1.7. Do not let this line reintroduce it.

### 5.2 Strangler rollout via `AUTH_MODE`

| `AUTH_MODE` | Behaviour |
|---|---|
| `passport` (default) | Exactly today. SuperTokens is not initialised. |
| `dual` | Both login paths live; sessions from either accepted. |
| `supertokens` | Passport routes disabled. |

Auth middleware becomes a chain: try SuperTokens session → fall back to legacy
JWT → 401. Both populate `req.user = { sub, username, avatarUrl }`.

**`req.user.sub` is the only thing the 35+ route handlers depend on**, so this
seam means zero route handler changes.

### 5.3 Identity mapping — the critical mechanism

SuperTokens' ThirdParty recipe supplies `thirdPartyId` (`'github'`/`'discord'`)
and `thirdPartyUserId` — the same pair passport supplies as `provider` and
`profile.id`.

> **Verified during v1.8 implementation (2026-08-06).** This equality was
> written as an assumption; it has since been checked against the pinned
> library sources:
>
> - **GitHub** — `supertokens-node`'s built-in provider sets
>   ``thirdPartyUserId = `${user.id}` `` (the numeric id, stringified);
>   `passport-github2` sets `profile.id = String(json.id)`. Same source field,
>   same stringification.
> - **Discord** — `supertokens-node` maps
>   `userInfoMap.fromUserInfoAPI.userId` to `id` (the snowflake, already a
>   string); `passport-discord` passes Discord's raw user JSON straight
>   through, so `profile.id` is that same `id`.
>
> This raises confidence but does **not** retire the §5.5 shadow gate: what
> ultimately matters is the values already stored in the owner's `identities`
> rows, some of which may have been written by older versions of either
> library.

In the `signInUp` override:

1. Look up `identities` by `(provider, provider_id)`.
2. Resolve the existing `users.id` (or create user + identity for a new player).
3. Call `createUserIdMapping({ superTokensUserId, externalUserId: users.id })`.

> **Spelling correction (2026-08-06, Task 3).** Note the capital T in
> `superTokensUserId`. This document and the implementation plan both
> originally wrote `supertokensUserId`, which `supertokens-node@24` accepts
> silently as `undefined` — no throw, no log, and no mapping created. Since
> the whole failure mode below is invisible, a typo here would be
> indistinguishable from never having written the step at all.

Because the core translates user ids in every response once a mapping exists,
a *returning* login receives the external id back from `signInUp`. The
override therefore checks `getUserIdMapping` first and only creates a mapping
when there genuinely is none — treating `UNKNOWN_SUPERTOKENS_USER_ID_ERROR` as
a failure would break every login after the first. A mapping that exists but
points at a *different* `users.id` than `identities` resolves fails the login
loudly, since guessing between two disagreeing sources of truth is how a
player ends up on someone else's save.

Afterwards `session.getUserId()` returns e.g. `github:37058311`, so saves,
roles, event participation and `SUPER_ADMIN_IDS` all continue to resolve.

**The mapping must be created before the session is issued**, or the session
carries SuperTokens' internal id instead of the external one. This is the single
highest-risk line in the release. It belongs in the recipe-function override
rather than the API override; the exact ordering is verified by test, not by
reading docs.

### 5.4 OAuth callback URLs — what would otherwise break logins

SuperTokens uses `/auth/callback/<provider>`; RackStack currently uses
`/auth/<provider>/callback`. GitHub's rule is that *the redirect URL's path must
reference a subdirectory of the registered callback URL* — and
`/auth/callback/github` is **not** a subdirectory of `/auth/github/callback`.
Left alone, every SuperTokens GitHub login fails with a redirect_uri mismatch.

Fix, one-time and reversible: **widen** the GitHub OAuth app's registered
callback URL to `https://your-domain/auth`. Both paths then qualify as
subdirectories and work simultaneously. Discord permits multiple redirect URIs,
so the new one is simply added. Nothing is removed, so passport keeps working
throughout the rollout.

### 5.5 Shadow-mode verification gate

Before any cutover, a shadow mode performs a SuperTokens login, computes
`provider:thirdPartyUserId`, compares it against the existing `identities` rows,
logs the result, and **does not** alter the caller's session.

This exists because the assumption that SuperTokens' `thirdPartyUserId` equals
passport's `profile.id` is load-bearing and unverified. GitHub's numeric id and
Discord's snowflake are both expected to match, but "expected" is not good
enough when the failure mode is a player silently landing on a brand-new empty
save. The owner's production export is used to confirm every existing row maps.

Cutover to `AUTH_MODE=dual` is gated on shadow mode reporting a 100% match.

### 5.6 Rollback

Set `AUTH_MODE=passport` and restart. Legacy JWT cookies remain valid for their
full 90-day expiry, so in-flight sessions survive the round trip.

## 6. Risks

| Risk | Mitigation |
|---|---|
| Save data lost or altered in migration | Single transaction, SHA-256 manifest verification pre-commit, byte-exact save comparison, SQLite file never deleted |
| Stale data migrated from an unclean copy | WAL checkpoint; refuse to run on unreadable `-wal`; runbook mandates stopping the container and copying all three files |
| Config history order lost | `BIGSERIAL` replaces `rowid`; covered by test |
| Users locked out by the constraint-code change | `23505` handling covered by the existing collision tests, which run on both backends |
| SQLite driver rots untested | Full suite runs on both backends in CI |
| SuperTokens id shape differs from stored `provider_id` | Shadow mode against production export; cutover gated on 100% match |
| SuperTokens session carries the wrong user id | Mapping created before session issuance; asserted by test |
| GitHub redirect_uri mismatch | Registered callback widened to `/auth` before enabling `dual` |
| Async refactor swallows route errors | Every handler audited for try/catch during the refactor |

## 7. Out of scope

- Installing SuperTokens in v1.7 (v1.8 only).
- Any account-linking UI. The schema permits it; no user-facing flow ships.
- Transactions around game actions. There are none today; noting the gap, not
  closing it here.
- Migrating away from the JSON save blob into relational tables.
- Multi-tenancy, MFA, email/password, or any SuperTokens recipe beyond
  ThirdParty and Session.
