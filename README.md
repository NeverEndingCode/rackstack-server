# RACKSTACK server

Self-hosted version of the game: Discord/GitHub OAuth login, SQLite for
persistence, and a server-authoritative economy (hard-capped at 72 hours of
offline progress regardless of upgrades).

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

## Architecture

- `shared/` - a package used by both server and client (via a `@shared` Vite
  alias on the client side): canonical game state, a config-parameterized
  rules/production engine, the action reducer, goals, and offline-progress
  evaluation. This is the single source of truth for game math - there's no
  separate client copy to keep in sync.
- `server/` - Express API. Passport handles the Discord/GitHub OAuth
  handshake; on success we issue our own JWT in an httpOnly cookie (no
  server-side session store needed). SQLite (`better-sqlite3`) persists
  users, saves, roles, a versioned tunables config, and minigame sessions.
  The client no longer computes or stores the economy itself - it dispatches
  actions to `POST /api/actions` and renders whatever `GET /api/state`
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

This builds the client, starts the server on port 3000 (mapped in
`docker-compose.yml` - change the host side if you want a different port),
and persists the SQLite file to `./data/rackstack.db` via a bind-mounted
volume, so it survives container rebuilds.

Point your reverse proxy / Cloudflare tunnel at `http://<host>:3000`.

## Upgrading

Back up `rackstack.db` before upgrading across a major/minor version (e.g.
v1.1.x -> v1.2.x): stop the container, copy the file
(`./data/rackstack.db` for Docker Compose, or
`<data path>/rackstack.db` for Unraid), then start the upgraded container.
The database uses WAL mode, so copying it while the server is still running
can grab an inconsistent snapshot - stopping first avoids that.

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
  `/app/data` - this holds the entire SQLite database (saves + users) and is
  untouched by "Apply Update," since that only swaps the image and reuses the
  existing volume/variable config.
- **`JWT_SECRET`** must be set once as a container Variable and never changed
  afterward - it signs the 90-day login cookie, so rotating it logs every
  user out (no data loss, just re-login required). The other OAuth variables
  mirror `.env.example`.

Once installed this way, updates are just Unraid's Docker tab -> "Check for
Updates" / "Apply Update" whenever a new `:latest` digest is published.

**Cutting a release:** bump `version` in `package.json` and
`client/package.json`, commit, then:

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

## Notes / things worth knowing

- **SQLite, not Postgres**: chosen for zero-config, single-file persistence
  that's easy to back up - see [Upgrading](#upgrading) for the safe way (stop
  the container, then copy the file; it runs in WAL mode, so a bare `cp`
  against a live server can grab an inconsistent snapshot). If you need a
  backup without stopping the server, use SQLite's own online-safe backup
  command instead: `sqlite3 data/rackstack.db ".backup data/rackstack.db.bak"`.
  Fine for a personal or small-group deployment. If you outgrow it (many
  concurrent users, wanting replication, etc.), `server/db.js` is still the
  only module that touches the database, but the porting surface is its full
  export list now, not a handful of functions: saves (`getSave`/`putSave`,
  consumed by `stateService.js` and, for `putSave`, also `routes/api.js`'s
  minigame handler; `deleteSave` is exported but currently unused), users
  (`upsertUser` in `auth.js`; `getUserById`, `getAllUsersWithSaves`,
  `setUsername` in `routes/api.js`), roles (`getRoles` in both `auth.js` and
  `routes/api.js`; `setRoles` in `routes/api.js`), the tunables config
  (`getConfigRow`/`putConfigRow`/`getConfigHistory`, all consumed by
  `configService.js`), minigame sessions (`createMinigameSession`/
  `getMinigameSession`/`getOpenMinigameSession`/`finishMinigameSession`, all
  consumed by `routes/api.js`), and `dedupeUsernames`, which db.js calls on
  itself at boot rather than exposing to a caller. Swapping in a `pg`
  version behind the same signatures still wouldn't require touching those
  callers, but it's a bigger module to port than it used to be.
- **JWT cookie, not sessions**: avoids needing a session store. The cookie
  is httpOnly and `secure` in production, valid for 90 days.
- **Multi-user by default**: every Discord/GitHub login gets its own
  save, keyed by `provider:providerId`. If you want this to be just-you,
  nothing extra to do - your account is simply the only one with data.
- **72h offline cap** (`offline.hardCapHours` in the tunables config,
  admin-editable from the dashboard) is a ceiling applied on top of whatever
  the Extended Uptime upgrade computes (`shared/state.js`), so no upgrade
  can push past it - only an admin raising the config value can.
