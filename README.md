# RACKSTACK server

Self-hosted version of the game: Discord/GitHub OAuth login, Postgres or
SQLite for persistence, and a server-authoritative economy (hard-capped at 72
hours of offline progress regardless of upgrades).

As of v1.7, Postgres is a supported (and recommended) persistence backend
alongside SQLite, selected by whether `DATABASE_URL` is set. Existing SQLite
installs migrate across automatically and losslessly on first boot with
`DATABASE_URL` set - see
[Migrating from SQLite to Postgres](#migrating-from-sqlite-to-postgres) below.

As of v1.3, a Cold Storage tab unlocks at the Server Room tier: a 16-block
passive reward track that refills on a timer, one offline-only archival job
(pick a duration, collect when it finishes while you're away), and a 7-upgrade
Tapes tree paid for with the tab's own currency - all of it, including
progress and purchased upgrades, survives Migrate and Singularity resets.

As of v1.4, Live Events layer time-boxed config overlays and goal ladders on
top of the regular economy - only one runs at a time. Four seasonal events
(Summer Surge, Spooky Packets, Black Frame Friday, Frost Uptime) come and go
automatically on their own annual windows via an hourly scheduler, and a
coordinator can author, schedule, and run additional ones from the admin
dashboard's Events tab. See [Live Events](#live-events) below for details.

As of v1.5, a Social tab adds a daily contracts board (three contracts a day,
the same three types for everyone, with targets scaled to your own progress),
global leaderboards, and a badge case of achievements that unlock on their own
as you play. A daily login streak sits in the header. See
[Social & Retention](#social--retention) below.

## Architecture

- `shared/` - a package used by both server and client (via a `@shared` Vite
  alias on the client side): canonical game state, a config-parameterized
  rules/production engine, the action reducer, goals, and offline-progress
  evaluation. This is the single source of truth for game math - there's no
  separate client copy to keep in sync.
- `server/` - Express API. Passport handles the Discord/GitHub OAuth
  handshake; on success we issue our own JWT in an httpOnly cookie (no
  server-side session store needed). `server/db.js` fronts one async
  repository interface backed by either Postgres (`pg`, recommended) or
  SQLite (`better-sqlite3`) - selected by whether `DATABASE_URL` is set -
  persisting users, saves, roles, a versioned tunables config, and minigame
  sessions. The client no longer computes or stores the economy itself - it
  dispatches actions to `POST /api/actions` and renders whatever `GET /api/state`
  returns, with offline gain computed lazily on load rather than by an
  always-on background worker. As of v1.2 the old client-computed save flow
  (`GET`/`POST`/`DELETE /api/save`) is gone - if you had anything external
  talking to those endpoints, point it at `/api/state` and `/api/actions`
  instead.
- `client/` - the game itself (Vite + React + Tailwind + lucide-react),
  talking to the API instead of browser storage.

## 1. Create OAuth apps

**Discord**: https://discord.com/developers/applications -> New Application
-> OAuth2 -> add a redirect URI: `https://<your-domain>/auth/discord/callback`
-> copy the Client ID and Client Secret.

**GitHub**: https://github.com/settings/developers -> New OAuth App
-> Authorization callback URL: `https://<your-domain>/auth/github/callback`
-> copy the Client ID and Client Secret.

You only need to configure the provider(s) you actually want to use - leave
the other's ID/SECRET blank in `.env` and its login button will just fail if
clicked (harmless, but you may want to hide it later).

### If you plan to enable SuperTokens later

SuperTokens serves its OAuth callbacks at `/auth/callback/<provider>`, while
the paths above are `/auth/<provider>/callback`. GitHub requires a redirect
URL's path to be a **subdirectory** of the registered callback URL, and
`/auth/callback/github` is *not* a subdirectory of `/auth/github/callback` - so
left alone, every SuperTokens GitHub login would fail with a `redirect_uri`
mismatch while passport logins carried on working.

The fix is one-time, **additive and reversible**: widen the GitHub OAuth app's
registered callback to the parent path `https://<your-domain>/auth`. Both paths
are then subdirectories of it and both work simultaneously - nothing is
removed, so passport keeps working before, during and after. Discord permits
multiple redirect URIs, so simply add
`https://<your-domain>/auth/callback/discord` alongside the existing one.

Leave `GITHUB_CALLBACK_URL` / `DISCORD_CALLBACK_URL` pointing at the existing
`/auth/<provider>/callback` paths - those tell passport where to send people,
and passport's paths have not changed.

**Do this before setting `AUTH_MODE`, not at the same time.** It is safe to do
days early. Full sequence in
[`docs/supertokens-rollout-runbook.md`](docs/supertokens-rollout-runbook.md).

## 2. Configure

```bash
cp .env.example .env
openssl rand -hex 32   # paste the output in as JWT_SECRET
# fill in DISCORD_/GITHUB_ client id, secret, and callback URLs
```

The callback URLs must exactly match what you registered with Discord/GitHub,
including the scheme (`https://`) - if you're putting this behind the
Cloudflare tunnel you already use for other services, point a subdomain at
this container and use that in both places.

Also set `SUPER_ADMIN_IDS` to your own `provider:providerId` (e.g.
`github:37058311`, comma-separated if there's more than one) - this is what
grants admin access (the live balance-tuning dashboard, roles management,
the user list). Without it, nobody can reach any admin route, including you,
and there's no other way to bootstrap the first admin. Log in once first if
you don't know your provider id: GitHub's is the numeric id at
`https://api.github.com/users/<your-username>`; Discord's is the numeric id
shown in Discord's own "Copy User ID" (enable Developer Mode) or visible in
the server's `users` table after your first login. DB-stored `admin` /
`event_coordinator` roles (grantable from the dashboard once you're in) are
for everyone else - `SUPER_ADMIN_IDS` is only for the owner(s) who should
always have full access no matter what's in the database. `event_coordinator`
only unlocks the Events tab (author/schedule/activate/end Live Events, see
below); `admin` implies it and additionally unlocks Balancing, Roles, and
Users.

## 3. Run with Docker Compose

```bash
docker compose up -d --build
```

This builds the client, starts a `postgres:16` container plus the server on
port 3000 (mapped in `docker-compose.yml` - change the host side if you want
a different port), and persists Postgres's data under `./pgdata`. The
`./data:/app/data` mapping is also present for the server - on a fresh
install nothing uses it, but keep it mapped anyway: if you later point an
existing SQLite-backed install at this compose file, it is the migration
source and your rollback path (see
[Migrating from SQLite to Postgres](#migrating-from-sqlite-to-postgres)).

Point your reverse proxy / Cloudflare tunnel at `http://<host>:3000`.

## Upgrading

If you're running on Postgres, back it up with your usual `pg_dump` practice
before upgrading; nothing below is Postgres-specific.

If you're still on SQLite, back up `rackstack.db` before upgrading across a
major/minor version (e.g. v1.1.x -> v1.2.x): stop the container, copy **all
three** `rackstack.db*` files - `rackstack.db`, `rackstack.db-wal`,
`rackstack.db-shm` (recent progress lives in the `-wal` file, so copying only
`rackstack.db` can lose it) - from `./data/` for Docker Compose or
`<data path>/` for Unraid, then start the upgraded container. The database
uses WAL mode, so copying it while the server is still running can grab an
inconsistent snapshot - stopping first avoids that.

That said, upgrading in place should just work without a backup too: v1.1
saves are migrated to the current shape automatically and losslessly the
first time each one loads (padding in any new fields with defaults; nothing
existing is dropped or recomputed destructively), and the SQLite schema
additions (`config`, `roles`, minigame sessions, etc.) are additive and
applied on boot. The backup is a safety net for the upgrade itself (interrupted
copy, wrong image, etc.), not something the migration needs to succeed.

## Running on Unraid (prebuilt image)

Every push of a `vX.Y.Z` git tag builds and publishes a multi-tag image to
GitHub Container Registry via `.github/workflows/docker-publish.yml`:

- `ghcr.io/neverendingcode/rackstack-server:latest`
- `ghcr.io/neverendingcode/rackstack-server:vX.Y.Z`

No Docker Hub account needed - GHCR authenticates with the repo's own
`GITHUB_TOKEN`, and the package is public, so Unraid can pull it with no
credentials.

**Install:** in Unraid's Docker tab, "Add Container" -> "Template repositories"
-> add `https://raw.githubusercontent.com/NeverEndingCode/rackstack-server/main/unraid-template.xml`,
or fill the fields in by hand using [`unraid-template.xml`](./unraid-template.xml)
as a reference. Two things matter for updates to be safe:

- **Data path** must be a stable host path (e.g.
  `/mnt/user/appdata/rackstack-server/data`) mapped to the container's
  `/app/data`, and left in place even after moving to Postgres - it is the
  migration source on first cutover and your rollback path afterward. On
  SQLite it also holds the entire database (saves + users). It is untouched
  by "Apply Update," since that only swaps the image and reuses the existing
  volume/variable config.
- **`JWT_SECRET`** must be set once as a container Variable and never changed
  afterward - it signs the 90-day login cookie, so rotating it logs every
  user out (no data loss, just re-login required). The other OAuth variables
  mirror `.env.example`.
- **`DATABASE_URL`** (optional, recommended) points at a Postgres database
  instead of the local SQLite file - see
  [Migrating from SQLite to Postgres](#migrating-from-sqlite-to-postgres)
  below.

Once installed this way, updates are just Unraid's Docker tab -> "Check for
Updates" / "Apply Update" whenever a new `:latest` digest is published.

### Migrating from SQLite to Postgres

Full runbook (backup, cutover, verification, rollback):
[`docs/postgres-migration-runbook.md`](./docs/postgres-migration-runbook.md).
The two things operators most often get wrong:

- **Back up all three `rackstack.db*` files**, not just `rackstack.db`.
  Recent progress lives in the `-wal` file - copying only the `.db` is the
  most likely way to lose data during this migration.
- **Leave the `/app/data` volume mapping in place** after setting
  `DATABASE_URL`. It is the migration source and your rollback path;
  removing it is the one irreversible mistake in the whole process.

Short version: add a `postgres:16` container with its own appdata path and a
`rackstack` database, stop rackstack, back up as above, set `DATABASE_URL`
(the host must not be `localhost` from inside a container), and start
rackstack. Watch the log for `[migrate]` - you should see a verified row
count for each table, then `committed`. If verification fails the container
refuses to start on purpose, so it never serves an empty game over your save
data; your SQLite data is untouched either way.

To roll back, blank out `DATABASE_URL` and restart — but note where that
variable actually lives for your deployment:

| Deployment | Where to blank `DATABASE_URL` |
|---|---|
| Unraid / plain `docker run` | The container's Variable in the Unraid UI (or the `-e` flag) |
| Docker Compose | `.env` — `docker-compose.yml` reads it via `${DATABASE_URL-...}` (no colon, so `DATABASE_URL=` means "blank", not "unset" — that is what makes the documented rollback work) |
| Local `npm start` | `.env` |

### Authentication stack (`AUTH_MODE`)

RackStack is gaining SuperTokens as an alternative login stack, rolled out
behind a switch rather than swapped in one step. **If you do nothing, nothing
changes** — the default is the passport + JWT stack that has always shipped,
and the SuperTokens SDK is not even loaded.

| `AUTH_MODE` | Behaviour |
|---|---|
| *(blank)* or `passport` | Default. Exactly as before; SuperTokens is not initialised. |
| `dual` | Both login paths live, sessions from either accepted. Where the rollout happens. |
| `supertokens` | ⚠️ **Not usable yet** — SuperTokens only; the legacy OAuth routes are not registered, and the client has no SuperTokens login flow, so **nobody can log in**. See below. |

Two properties worth knowing before you touch it:

- **Changing this never logs anyone out.** Existing login cookies stay valid
  for their full 90 days through every transition, in both directions, so
  rollback is just setting it back to `passport` and restarting.
- **A typo stops the container** instead of quietly falling back to the
  default. `AUTH_MODE=supertoken` would otherwise serve the legacy stack while
  looking like a finished rollout — the kind of thing you'd discover weeks
  later, from the wrong symptom.

- **`dual` is the intended resting state.** `supertokens`-only mode is *not*
  usable yet: `client/src/Login.jsx` points its buttons at the passport routes,
  which that mode does not register, so they silently do nothing and no one can
  sign in. Existing sessions keep working via the JWT fallback, which is what
  makes it easy to miss. There is no token refresh in the client either. Both
  are frontend work that has not been started — see
  [`docs/authentication-methods.md`](./docs/authentication-methods.md) Phase 5.

`SUPERTOKENS_CONNECTION_URI` points at the SuperTokens core container and is
read only in `dual`/`supertokens`. That core needs its **own** database on
your Postgres server, separate from the rackstack one.

**Set `SUPERTOKENS_API_KEY`, and do not publish the core's port.** A
SuperTokens core with no API key serves its entire API unauthenticated, and
that API can mint a session for *any* user id — including every value in
`SUPER_ADMIN_IDS`, without any request reaching RackStack. The server refuses
to start in `dual`/`supertokens` if the core is not on loopback and no key is
set. Generate one with `openssl rand -hex 32` and set it as `API_KEYS` on the
core and `SUPERTOKENS_API_KEY` here.

Full walkthrough — including the OAuth redirect-URL change that has to happen
*before* `dual`, and the verification gate before cutover — is in
[`docs/supertokens-rollout-runbook.md`](./docs/supertokens-rollout-runbook.md).

**Cutting a release:** bump `version` in `package.json` (the single release-
version authority - `client/vite.config.js` reads it for `__APP_VERSION__`,
and `client/package.json`'s own version is deliberately not kept in sync),
update `CHANGELOG.md` and the Dockerfile's
`org.opencontainers.image.version` label, commit, then:

```bash
git tag vX.Y.Z
git push --tags
```

The Actions workflow builds and pushes automatically.

## Local development (without Docker)

Two processes:

```bash
# terminal 1 - API server
cp .env.example .env   # fill in values, DISCORD/GITHUB callback URLs can be http://localhost:3000/auth/.../callback for local testing
npm install
npm run dev

# terminal 2 - client with hot reload, proxies /api and /auth to :3000
cd client
npm install
npm run dev
```

Visit the client dev server's printed URL (usually `http://localhost:5173`).

## Running the tests

```bash
npm test          # Postgres backend (default) - boots a throwaway container
npm run test:sqlite   # SQLite backend, no container needed
npm run test:all      # both, sqlite then pg
```

The Postgres backend needs a container runtime that speaks the Docker API.
`tests/setup/pg-global.js` boots one shared Postgres 16 container via
[Testcontainers](https://node.testcontainers.org) and each test file carves
out its own database from it (`tests/helpers/backend.js`), so files can't
see each other's rows.

- **Docker**: works out of the box, nothing to configure.
- **Podman** (what this repo's containers were validated against; no
  `docker` binary required): start the user socket once per login session
  and Testcontainers will find it automatically -
  `tests/setup/pg-global.js` points `DOCKER_HOST` at the Podman socket
  itself if `DOCKER_HOST` isn't already set, so no per-developer config is
  needed:

  ```bash
  systemctl --user start podman.socket
  ```

  Rootless Podman can't grant Testcontainers' Ryuk reaper the privileges it
  wants, so the harness also sets `TESTCONTAINERS_RYUK_DISABLED=true` by
  default when using Podman. With Ryuk off, the container is stopped and
  removed by `teardown()` in `pg-global.js` at the end of the run instead -
  if a run is killed hard enough to skip that (e.g. `SIGKILL`), clean up any
  leftovers with `podman ps -a` / `podman rm -f`.
- **CI** sets `TEST_DATABASE_URL` directly against a Postgres service
  container (see `.github/workflows/test.yml`) and never touches
  Testcontainers at all.

To point manually at a different runtime or disable Ryuk yourself, set
`DOCKER_HOST` and/or `TESTCONTAINERS_RYUK_DISABLED` before running the
tests - the harness only fills these in when they're unset.

## Live Events

At most one event is active globally at a time. Each is a set of tunable
modifiers (the same `production`/`heat`/`minigames`/`offline`/`batchQueue`
tunables the Balancing tab edits) applied read-time on top of the admin
baseline config, plus a goal ladder of rungs a player claims for wafers/
tapes/FLOPS as they clear metric targets.

- **Seasonal events ship pre-seeded** (`server/data/seasonalEvents.js`):
  Summer Surge (July), Spooky Packets (late October), Black Frame Friday
  (late November), Frost Uptime (December-January). Each starts as a
  windowless draft and gets its concrete `starts_at`/`ends_at` materialized
  automatically, every year, by the scheduler below - no admin action
  needed for them to run on schedule.
- **Hourly scheduler** (`server/eventService.js`'s `runScheduler`, invoked
  once at boot and every hour after): materializes seasonal recurrences into
  a scheduled window, ends any active event whose window has closed, and
  activates any scheduled event whose window has opened.
- **Personal per-player windows**: a player's own run starts at their first
  login while an event is active and lasts the event's full duration, capped
  at 24h past the event's global end - two players who join at different
  times see different countdowns. A 48h grace period afterward still lets
  them claim any rung they'd already earned before their window closed.
- **Leaderboard + opt-out**: ranked by rungs claimed, visible from the
  in-game Event tab. Opting out (a per-user toggle, not per-event) removes
  you from it immediately, not just on your next join.
- **Coordinator authoring** (Profile > Settings > Events, `event_coordinator`
  role or `admin`): create/edit a draft with a TUNABLES-driven modifier
  builder and ladder builder, schedule a window, activate/end it, delete
  unscheduled drafts, and view per-event participation. Activating a second
  event while one is already active is rejected outright (409) - end the
  running one first.

## Social & Retention

All four of these are bonuses - none of them gates content, and none
introduces a new currency.

- **Daily contracts** (Social tab): three a day, rotating at midnight UTC.
  Which three is derived deterministically from the date, so everyone on the
  server gets the same set and can compare notes; the numeric targets scale
  to each player's own output and level. Both the targets and the progress
  baselines are snapshotted at rollover, so a contract can't recede as you
  grow into it. Completing one pays wafers + tapes. A player who hasn't
  unlocked Cold Storage gets base-lane substitutions rather than contracts
  they can't act on.
- **Daily streak** (header banner): a 7-day escalating claim - FLOPS on days
  1-3, wafers on 4-6, Tapes on day 7 - which then stays at the day-7 reward
  for as long as it's unbroken. Missing a full UTC day resets it to day 1.
  The day boundary is the same one contracts roll over on, so showing up once
  a day satisfies both.
- **Leaderboards** (Social tab): all-time FLOPS, level, Legacy Cores,
  Singularities, Tapes, and the latest event's rungs. Aggregated server-side
  from canonical saves behind a ~60s cache. The same per-user opt-out the
  Event tab already had covers these too - tick "Hide me from all
  leaderboards" and you disappear from every board immediately.
- **Achievements** (Social tab badge case): 19 of them, pure prestige - no
  payout, ever. They unlock automatically the moment their condition is met,
  including from progress that accrued while you were offline, and pop a
  toast when they do. Your top three (gold first) show as mini-icons next to
  your name on the leaderboards.
- **Tuning**: everything numeric above lives under `social.*` in the
  Balancing tab, and - like every other tunable - can be overlaid by a live
  event's modifiers. `social.contractFlopsMin` is worth knowing about: it's a
  floor on the FLOPS contract target, there because a purely rate-scaled
  target is zero for a player at zero output (a fresh save, or the instant
  after a Migrate) and would auto-complete for free. Set it to 0 if you'd
  rather have that.

## Notes / things worth knowing

- **Postgres or SQLite**: `server/db.js` fronts one async repository
  interface (`server/db/index.js`) implemented by two drivers -
  `server/db/driver.pg.js` and `server/db/driver.sqlite.js` - selected by
  whether `DATABASE_URL` is set. Postgres is recommended; SQLite remains
  fully supported for zero-config, single-file personal deployments. On
  SQLite, back up the way [Upgrading](#upgrading) describes (stop the
  container, then copy all three `rackstack.db*` files; it runs in WAL mode,
  so a bare `cp` of just `rackstack.db` against a live server grabs an
  inconsistent, incomplete snapshot). If you need a backup without stopping
  the server, use SQLite's own online-safe backup command instead:
  `sqlite3 data/rackstack.db ".backup data/rackstack.db.bak"`. On Postgres,
  use your usual `pg_dump`/`pg_basebackup` practice. Every caller goes
  through the same interface regardless of backend, so nothing outside
  `server/db/` needs to know or care which one is active.
- **JWT cookie, not sessions**: avoids needing a session store. The cookie
  is httpOnly and `secure` in production, valid for 90 days.
- **Multi-user by default**: every Discord/GitHub login gets its own
  save, keyed by `provider:providerId`. If you want this to be just-you,
  nothing extra to do - your account is simply the only one with data.
- **72h offline cap** (`offline.hardCapHours` in the tunables config,
  admin-editable from the dashboard) is a ceiling applied on top of whatever
  the Extended Uptime upgrade computes (`shared/state.js`), so no upgrade
  can push past it - only an admin raising the config value can.
