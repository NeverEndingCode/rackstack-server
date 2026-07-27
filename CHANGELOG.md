# Changelog

## v1.3.0

Cold Storage: a new tab, unlocked at the Server Room tier, built around a
currency ("tapes") and progress track that survive Migrate and Singularity.

- Passive reward track: 16 blocks that refill on a timer and can be claimed
  individually or all at once, with a bonus on the final block of each cycle.
- Offline-only archival job queue: start one of three job durations, then
  collect the payout once it finishes while you're away - progress only
  advances offline, so there's nothing to babysit.
- Tapes upgrade tree: 7 upgrades bought with tapes that boost the track and
  job queue, permanent across resets.
- New goals and repeatable objectives tied to Cold Storage progress.
- Admin dashboard: the live-tunable Balancing tab picked up a new
  `batchQueue` section (block/job durations, rewards, and bonus curves) and
  7 new upgrade max-level tunables, editable the same as every other stat.

Fixes:
- Fixed wafer/shard upgrade purchases and goal/repeatable claims sometimes
  silently failing ("Action failed") due to a queued action's tracking id
  clobbering the action's own semantic id before it reached the server.

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
- Admin dashboard v2 (Profile > Settings, admins/owner only): a schema-driven
  Balancing tab to edit every tunable live with inline range validation, save
  errors, and a rollback-able version history, alongside a new Roles tab for
  granting/revoking `admin` (owner-only) and `event_coordinator` and the
  existing per-user stats tab.
- Roles: env-derived owners (`SUPER_ADMIN_IDS`) plus DB-stored `admin` /
  `event_coordinator` roles, returned from `/api/me` and enforced
  server-side on every admin-gated route - no more single hardcoded admin
  user id.
- Custom usernames: `PUT /api/me/username`, unique (case-insensitive) and
  validated server-side, with existing duplicate usernames deduplicated on
  upgrade. The profile footer now shows the running version and opens an
  in-app changelog (this file, served from `GET /api/changelog`).
- Minigame sessions: `POST /api/minigame/start` / `/finish` replace
  client-trusted scores with server-issued, time-boxed sessions and
  server-side cooldown enforcement (including a fix for concurrent-session
  cooldown bypass).
- Overclock Balance retuned around the new config system and given visible
  amber risk-zone strips on the bar - clicking (or STABILIZE-ing) while the
  marker sits in a risk zone pays more than the plain safe zone, missing the
  bar entirely costs points, and every payout curve is a live tunable.
- Docs: a v1.1 -> v1.2 upgrade note (new required `SUPER_ADMIN_IDS` env var,
  no other breaking changes to the persistent volume), `.env`/Unraid
  template updates, and a refreshed `server/db.js` porting note for the new
  tables.

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
