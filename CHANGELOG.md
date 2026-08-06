# Changelog

## v1.8.0

SuperTokens as an alternative login stack, behind a switch that is off by
default.

**Upgrading changes nothing.** `AUTH_MODE` defaults to `passport`, which is
byte-for-byte the login stack that shipped in v1.7 — SuperTokens is not
initialised, its middleware is not mounted, and the SDK is not even imported.
Everything below is inert until an operator opts in.

- **`AUTH_MODE` switch**: `passport` (default), `dual` (both stacks live,
  sessions from either accepted), `supertokens` (legacy OAuth routes not
  registered). An unrecognised value stops the container on purpose rather
  than quietly serving the legacy stack — a typo that looked like a completed
  rollout would be discovered weeks later.
- **Your account and save are untouched.** RackStack identifies players by
  `users.id` (`provider:providerId`, e.g. `github:37058311`). SuperTokens
  issues its own internal id and that id is mapped *onto* the existing one, so
  `session.getUserId()` returns exactly what the old JWT carried. No save is
  rewritten, no id renumbered, no foreign key moved, and `SUPER_ADMIN_IDS`
  keeps working. There is no "migrate your account" step for players.
- **Nobody is logged out, in either direction.** Existing cookies are 90-day
  JWTs and stay valid through every mode change. Rollback is setting
  `AUTH_MODE` back to `passport` and restarting; unlike the v1.7 Postgres
  migration there is no one-way door, because changing the mode rewrites no
  data.
- **Shadow-mode verification gate**: `npm run shadow:check` audits every
  stored identity and reports whether the id mapping would resolve correctly,
  before anything is switched on. Read-only — safe against production with
  players online, and against a restored export on a laptop. Cutover is gated
  on a 100% match. An empty run reports `NOT RUN` and exits non-zero rather
  than passing on having read nothing.
- **Two new repository functions**, `getIdentity` and `setSupertokensUserId`,
  implemented on both the SQLite and Postgres drivers. `npm run test:all`
  still runs the whole suite against both backends.
- **Operator runbook**: `docs/supertokens-rollout-runbook.md` covers the OAuth
  redirect widening (additive and reversible — nothing is removed, so passport
  keeps working), standing up the core, the shadow gate, cutover and rollback.

**Not yet run anywhere.** Shadow mode has not been run against production
identities, and no cutover has happened. `dual` is the intended resting state
for this release: `supertokens`-only mode is implemented and tested but needs
frontend token-refresh handling before it is cut over to. The runbook says all
of this in its opening section.

## v1.7.0

Postgres support, with automatic migration from SQLite.

- **Postgres backend**: `DATABASE_URL` selects Postgres as the persistence
  backend instead of the local SQLite file. `server/db.js` fronts one async
  repository interface (`server/db/index.js`) implemented by two drivers -
  `server/db/driver.pg.js` and `server/db/driver.sqlite.js` - so every
  caller (routes, services, minigames) is backend-agnostic. SQLite remains
  fully supported and is still the default when `DATABASE_URL` is unset.
- **Automatic migration on boot**: with `DATABASE_URL` set, if a SQLite
  database still exists and the target Postgres database is empty, the
  server migrates every table across in a single transaction, verifies row
  counts match, and only then starts serving. Your SQLite file is never
  modified or deleted, so rolling back is just unsetting `DATABASE_URL` and
  restarting. If verification fails, the container refuses to start on
  purpose rather than serve an empty game over live save data - the log
  names the table that failed. The same logic is available standalone via
  `npm run migrate:pg`.
- **Per-user request serialization**: save updates are a read-modify-write
  (load, evaluate, persist). Under SQLite those three steps used to run in a
  single uninterruptible turn, because every database call was synchronous;
  making the interface async removed that guarantee. Requests for one account
  are now queued behind each other explicitly, so two open tabs can't load the
  same state and have one overwrite the other's progress. Different players
  never block each other.
- **`identities` table**: authentication identity records (provider +
  provider id) are now split from `users` into their own table, in
  preparation for the SuperTokens migration planned for v1.8.
- **Two-backend test matrix**: `npm run test:all` runs the full suite against
  both SQLite and Postgres; CI does the same. A Postgres test harness
  (`tests/setup/pg-global.js`, `tests/helpers/backend.js`) provisions an
  isolated database per test file via Testcontainers (or a Docker/Podman
  service container in CI).
- **Operator note**: whether you're on SQLite or have moved to Postgres,
  keep the `/app/data` volume mapping in place. It is the migration source
  on first cutover and your rollback path afterward - removing it is the one
  irreversible mistake in the whole process. See the
  [migration runbook](docs/postgres-migration-runbook.md) or the README's
  [Migrating from SQLite to Postgres](README.md#migrating-from-sqlite-to-postgres)
  section for the full walkthrough.

## v1.6.0

Onboarding & quality of life: a guided tour for new and existing players,
plus four fixes to things that were quietly wrong.

- Guided tour: a spotlight walkthrough that dims the screen, highlights the
  real control it is describing, and steps through the whole rack - racks,
  Grid, Overclock and heat, upgrades, goals, minigames, Cold Storage, Social,
  Singularity, Migrate, and a live event if one is running. It is
  unlock-aware, so a brand-new account sees 11 steps covering only what it
  can actually reach, and a fully-unlocked account sees all 17. Skip is on
  every step, and Escape works too.
- It runs once for existing players as well as new ones, then never again.
  Replay it any time from Profile -> Settings -> Tutorials.
- Under the hood this is a tour *framework*, not a single tutorial. Completion
  is tracked per named tour, so a future release can ship a short tour
  covering only its new feature and show it to existing players without
  anyone sitting through the full tutorial a second time. A feature tour's
  steps are the same array the full tutorial composes, so the copy is only
  ever written once.
- The Overheat popup now dismisses itself after 15 seconds instead of waiting
  for a click. Tunable from the Balancing tab (`heat.overheatPopupMs`); set
  it to 0 to restore the old click-to-dismiss behaviour.
- Venting now sheds a **percentage** of your heat capacity rather than a flat
  amount, so it is no longer quietly weakened by anything that raises
  capacity - Summer Surge's `heat.capacity: 4000` overlay, or Heat-Sink Tapes.
  The Vent button and the Overclock explainer both show the live numbers
  instead of hardcoded ones.
  **Admin note:** `heat.ventAmount` is replaced by `heat.ventPercent`
  (default 25). At stock settings this is exactly balance-neutral - 25% of the
  default 2000 capacity is the 500 it replaced - but if you had tuned
  `ventAmount` away from 500, that tuning is reset to 25% and will need
  re-tuning in the Balancing tab.
- The Racks "Collect" button now stays visible until the tier is automated,
  greying out when there is nothing banked, instead of vanishing for a moment
  after every collect.
- Fixed a literal `&middot;` showing up next to automated racks in the Racks
  tab.

## v1.5.0

Social & Retention: a daily contracts board, global leaderboards,
achievements, and a daily login streak - all bonuses layered on the existing
economy, none of them gating content.

- Daily contracts: three contracts a day, rotating at midnight UTC and
  generated deterministically from the date, so every player gets the same
  three *types* while the numeric targets scale to their own progress.
  Targets and baselines are snapshotted at rollover, so buying racks mid-day
  never moves the goalposts. Claims pay wafers + tapes.
- A player who hasn't unlocked Cold Storage gets base-lane contracts
  substituted for any Cold Storage ones, so nobody is ever handed a contract
  they cannot possibly complete.
- Global leaderboards: all-time FLOPS, level, Legacy Cores, Singularities,
  Tapes, and the most recent event's rungs - aggregated server-side from
  canonical saves behind a ~60s cache, with avatars, usernames, and badge
  mini-icons. The existing per-user leaderboard opt-out now covers these
  boards too, and takes effect immediately.
- Achievements: 19 of them, pure prestige with no payout, unlocked
  automatically the moment their condition is met - including from progress
  accrued while offline. Shown as a badge case in the Social tab, and the
  top three (gold first) ride along on leaderboard rows.
- Daily streak: a 7-day escalating claim (FLOPS, then wafers, then Tapes on
  day 7) that stays at the day-7 reward while unbroken; a fully missed UTC
  day resets it to day 1. Claimed from a banner in the sticky header.
- New Social tab holding contracts, the leaderboard, and the badge case.
- New `social.*` tunables on the Balancing tab covering contract targets and
  rewards, streak rewards, and leaderboard cache/size - all overlayable by a
  live event's modifiers, so e.g. a double-streak-rewards weekend needs no
  code change.

## v1.4.0

Live Events: config-overlay events with goal ladders, running one at a time
on top of the existing balancing config.

- Config-overlay events: a coordinator-authored set of tunable modifiers
  (the same `production`/`heat`/`minigames`/`offline`/`batchQueue` tunables
  the Balancing tab edits) applied read-time on top of the admin baseline
  while an event is active - the stored config itself is never touched.
- Goal ladders: per-event reward tiers keyed to a player's own progress
  since joining (FLOPS/wafers/tapes earned, minigames won, blocks claimed),
  each claimable once its target is met, paying out wafers/tapes/FLOPS.
- Four seeded seasonal events - Summer Surge, Spooky Packets, Black Frame
  Friday, and Frost Uptime - each with its own theme, modifiers, and ladder,
  brought in and out on an hourly scheduler that also runs at boot.
- Personal event windows: a player's own run starts at their first login
  during an active event and lasts the event's full duration, capped at 24h
  past the event's global end, with a 48h grace period afterward to still
  claim any rung already earned before the window closed.
- Event leaderboard (ranked by rungs claimed) with a per-user opt-out that
  removes them immediately, not just on their next join.
- Admin/coordinator Events tab: authoring with a TUNABLES-driven modifier
  builder and ladder builder, schedule/activate/end/delete controls, and a
  per-event participation view.
- New `event_coordinator` role (granted/revoked by an admin, implied by
  `admin` itself) scoped to the Events tab only - it does not carry
  Balancing/Roles/Users access.

Fixes:
- A rejected action with a bad/expired target (e.g. an already-claimed
  event rung) no longer surfaces the generic "Event unavailable" toast for
  every action type - the message is now specific to what actually failed.

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
