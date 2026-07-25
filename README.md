# RACKSTACK server

Self-hosted version of the game: Discord/GitHub OAuth login, SQLite for
persistence, and server-authoritative offline progress (hard-capped at 72
hours regardless of upgrades).

## Architecture

- `server/` - Express API. Passport handles the Discord/GitHub OAuth
  handshake; on success we issue our own JWT in an httpOnly cookie (no
  server-side session store needed). SQLite (`better-sqlite3`) holds two
  tables: `users` and `saves` (one JSON blob per user).
- `server/gameLogic.js` - a server-side mirror of the client's production
  math, used only to compute how much a player produced while away. If you
  change tier costs, production rates, or upgrade effects in
  `client/src/RackStack.jsx`, mirror the change here too, or offline and
  online production will drift apart.
- `client/` - the game itself (Vite + React + Tailwind + lucide-react),
  talking to the API instead of browser storage.

Offline progress works like this: the client ticks production locally in
real time while a tab is open and POSTs its state to `/api/save` every 5s.
On next load (`GET /api/save`), the server computes elapsed time since the
last save, capped at 72h, applies the same production formulas, persists the
caught-up result, and returns it - the client just displays what it's given.
There's no always-on background worker simulating idle games 24/7; that's
unnecessary for an idle game and would just waste resources.

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

## 3. Run with Docker Compose

```bash
docker compose up -d --build
```

This builds the client, starts the server on port 3000 (mapped in
`docker-compose.yml` - change the host side if you want a different port),
and persists the SQLite file to `./data/rackstack.db` via a bind-mounted
volume, so it survives container rebuilds.

Point your reverse proxy / Cloudflare tunnel at `http://<host>:3000`.

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

## Notes / things worth knowing

- **SQLite, not Postgres**: chosen for zero-config, single-file persistence
  that's trivial to back up (`cp data/rackstack.db data/rackstack.db.bak`).
  Fine for a personal or small-group deployment. If you outgrow it (many
  concurrent users, wanting replication, etc.), the `server/db.js` module is
  the only place that touches the database - swapping it for a `pg` version
  behind the same function signatures (`upsertUser`, `getSave`, `putSave`,
  `deleteSave`) wouldn't require touching routes or game logic at all.
- **JWT cookie, not sessions**: avoids needing a session store. The cookie
  is httpOnly and `secure` in production, valid for 90 days.
- **Multi-user by default**: every Discord/GitHub login gets its own
  save, keyed by `provider:providerId`. If you want this to be just-you,
  nothing extra to do - your account is simply the only one with data.
- **72h offline cap** is a hard ceiling in `gameLogic.js`
  (`OFFLINE_CAP_HOURS`), applied on top of whatever the Extended Uptime
  upgrade computes, so no upgrade or future change can push past it.
