# Changelog

## v1.2.0

Server-authoritative rewrite: the client no longer computes or persists the
economy itself, it dispatches actions and renders whatever the server
returns.

- New `shared/` package (used by both server and client via a `@shared`
  Vite alias): canonical game state, a config-parameterized rules engine,
  the action reducer, goals, and offline-progress evaluation.
- `GET /api/state` / `POST /api/actions` replace the old client-computed
  save flow - every buy, collect, migrate, singularity, upgrade, goal
  claim, and anomaly claim is now validated and applied server-side, with
  offline gain computed lazily on load.
- Live admin balancing: a versioned, hot-reloadable tunables config
  (`GET /api/config`, admin-only `PUT /api/admin/config` with rollback and
  history) drives production, costs, heat, and minigame payouts without a
  redeploy.
- Roles: env-derived owners plus DB-stored `admin` / `event_coordinator`
  roles, returned from `/api/me` and enforced server-side on every
  admin-gated route - no more single hardcoded admin user id.
- Custom usernames: `PUT /api/me/username`, unique and validated
  server-side.
- Minigame sessions: `POST /api/minigame/start` / `/finish` replace
  client-trusted scores with server-issued, time-boxed sessions and
  server-side cooldown enforcement (including a fix for concurrent-session
  cooldown bypass).
- Heat and Balance minigame retuning driven by the new config system.

## v1.1.1

- Migrate now returns you to the Racks tab instead of leaving you on
  whatever tab you were on.
- Singularity tab label was truncated to "Singular." - restored to full.
- Long usernames were getting cut off in the header - widened the
  truncation limit.
- Collect All now shows whenever any owned rack isn't automated, not only
  when there's currently something ready to collect.
- Overclock overheating no longer destroys any owned nodes - hitting 100%
  heat now only triggers a 10s lane cooldown.
- The post-minigame "Resolved" modal no longer closes on a backdrop click.
- Added a STABILIZE button back to Overclock Balance.
- New admin-only section in Profile > Settings listing every user and
  their save stats.

## v1.1.0

- Split the monolithic `RackStack.jsx` into `client/src/game/` (data,
  helpers, and focused components) with no behavior change.
- Persisted Overclock heat cooldown that survives being away.
- Profile view with full stats.
- Redesigned Cable Match (4x5/10 pairs, instant finish, full-match-only
  payout) and Overclock Balance (smooth cursor, click-the-bar scoring).
- Randomized, multi-touch Debug Sprint and per-game post-win cooldowns.
- Two-step type-to-confirm Reset Progress, moved into Profile > Settings.
- PWA installability with a server-authoritative-safe service worker
  (`/api` and `/auth` are always network-only, never cached).

## v1.0.2

- GitHub Actions pipeline that builds and pushes the Docker image to
  ghcr.io on version tags.
- Unraid Community Applications template and docs for updating in place
  without touching the persistent data volume or `JWT_SECRET`.

## v1.0.1

- Initial release: Express API with Discord/GitHub OAuth, SQLite
  persistence, and server-authoritative offline progress, plus the
  Vite/React client.
