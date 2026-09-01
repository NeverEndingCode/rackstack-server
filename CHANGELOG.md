# Changelog

## v1.11.1

- **Core counts you can actually read.** Legacy Cores were the one number in
  the game still printed in full — nineteen digits wide by the time Migrate is
  paying out quintillions, in a row sized for a phone. Profile → Settings now
  offers three renderings: **Full** (what it always was, still the default),
  **ABC** (`4.09F` — one letter per power of a thousand, A through Z and then
  AA, AB), and **Sci** (`4.09e+18`). Tapping the cores chip in the header
  cycles the same setting without opening Settings.

  It applies everywhere a core count appears — the header chip, the Migrate
  button's payout, the Singularity panel and its confirmation, Profile stats,
  and the Legacy Cores leaderboard. The choice is per-device (it lives in the
  browser, not in your save) and is display-only: nothing about the simulation
  reads it.

## v1.11.0

- **Things can now go wrong.** Every few hours something breaks: ransomware
  halves every lane, an ISP outage takes the Grid dark, a drive failure kills
  one rack tier. Incidents only ever **reduce output** — they never destroy
  racks, FLOPS, tapes or upgrades, so there is no such thing as a dead save
  and no repair you must be able to afford. In an idle game the real currency
  is lost time, and that is all this takes.

  You are never told when the next one is coming, only the standing rate
  (about one every six hours). That is deliberate: a schedule you can see
  turns preparation into buying one licence twenty minutes beforehand.

- **Prepaid supplies, and a cure priced worse than preparing.** Antivirus
  licences, backup ISP lines and spare drives are bought with FLOPS and absorb
  one matching incident automatically — **including while you are offline**,
  which is the only defence that can reach an incident that starts and ends
  during a nine-hour absence. They live in your permanent progress, so they
  survive a Migrate; spend down before you prestige rather than watching the
  balance evaporate.

  Something already broken can be resolved on the spot for FLOPS, scaled by
  how much of it is left. That price is always higher than the supply that
  would have prevented it. Coming back to a running incident should never
  leave you a spectator, but it should never be the cheap path either.

- **Cold Storage never fails.** No incident touches it — not blocks, not jobs,
  not tapes, not the tape tree. It is the one lane that always pays, and a
  real reason to invest before a long absence.

- **The Grid takes scheduled maintenance.** Unlike incidents, a maintenance
  window is announced well ahead and shown with a countdown, so you can route
  around it. Downtime you can plan for is a decision; downtime you cannot is
  indistinguishable from the game being broken.

- **The Overclock Bay no longer produces FLOPS. It multiplies your Racks.**
  This changes how an existing lane works, so read it carefully: the nodes you
  own now contribute a multiplier to Racks output instead of generating output
  of their own. At the shipped balance the conversion is **exactly neutral** —
  your total output is the same the moment it deploys — but the lane now
  scales with your racks rather than beside them.

  Overheating changed to match. Instead of freezing the Overclock lane, it now
  knocks **one rack tier offline** for a few minutes. Running hot risks the
  very thing it amplifies, and the punishment is self-limiting. Nothing is
  ever destroyed, and no nodes are lost.

- **All of it is switchable from the Balancing tab**, including a master kill
  switch. Turning the system off is a true kill, not a pause: any incident
  already running is cleared on the next reconcile, so nobody is left
  throttled by a system that no longer exists. The config schema grew a proper
  boolean type to make that possible — a 0/1 "boolean" is exactly the kind of
  thing that later gets set to 2.

## v1.10.0

- **Triggering a Singularity deleted you from the Legacy Cores leaderboard.**
  The board read `meta.legacyCores` — the cores you are holding *right now* —
  and then dropped every row whose value was zero. A Singularity spends every
  core you have. So the moment a player performed the most demanding action in
  the game, the board stopped listing them entirely, and the only way to appear
  on it was to have never used what it was measuring.

  The board now reads a new lifetime stat, `meta.stats.bestLegacyCores`, and is
  labelled **Legacy Cores (best)**. The zero-filter is untouched and is now
  simply correct rather than special-cased: a player who reset has a non-zero
  best, an account that never played does not.

  There is no migration and nothing to backfill. The stat is maintained by one
  helper called from `evaluate()`, so an existing save seeds itself from its
  current cores the first time the server reconciles it — and from
  `singularity()` too, immediately before it zeroes the value, because
  `POST /api/actions` applies a whole batch with no evaluation in between and a
  Migrate-then-Singularity batch would otherwise destroy the peak before
  anything observed it.

- **A buy-to-next-milestone button on Racks, Grid and Overclock.** Every 25,
  50, 100, 200, 500 and 1000 units doubles that lane's output, and reaching the
  next one previously meant arithmetic and repeated Buy 10s. The new button
  buys exactly the remainder — no more, no less.

  The **server** computes the target, not the client. The `infiniteloop` shard
  upgrade discounts those thresholds, so a client working from a stale config
  would ask for the wrong number; the button sends `mode: 'milestone'` and the
  reducer resolves it against the same discounted thresholds that decide the
  multiplier you actually earn. The cost on the label is display only. A jump
  you cannot afford is refused whole — there is no partial buy — and a lane
  past its final threshold reports the new `no_milestone` rather than
  pretending it could not afford one.

- **Minigame personal bests.** Each card in the Games tab shows your best score
  for that game, and finishing a run that beats it says so. Derived server-side
  from the `minigame_sessions` rows that already existed, so every score you
  set before this shipped is already there — again, no migration.

- **Progress bars on locked badges.** A badge you have not earned now shows how
  far along you are. The bar and the unlock read the same number: an
  achievement now declares `progress` and `target` instead of a hand-written
  boolean, and the unlock is derived from them, so the two cannot drift apart.
  The two achievements that are genuinely yes/no (Jackpot, Showed Up) stay
  boolean and show no bar. No threshold moved.

- **The Upgrades and Singularity panels read live config maximums.** Both took
  an upgrade's ceiling from the static definition, so an admin raising a max
  level never reached them — a purchasable upgrade could read as maxed out.
  They now read `config.upgrades.maxLevels`, as the Cold Storage panel already
  did.

## v1.9.1

- **The SuperTokens login button signed you in and then left you logged out.**
  `POST /auth/signinup` answered `status: "OK"`, the client reported success,
  the URL went back to `/` — and the very next `GET /api/me` was a 401, so the
  login screen came back with nothing wrong on it.

  SuperTokens picks the session's *token transfer method* at creation time from
  the `st-auth-mode` request header, and when it is absent it defaults to
  **header**, not cookies (`session/sessionRequestFunctions.js`: *"We default
  to header if we can't 'parse' it or if it's undefined"*). The session came
  back in `st-access-token` / `st-refresh-token` response headers; no cookie
  was ever set. `supertokens-web-js` sends that header for you, and v1.9.0
  hand-rolled the calls without it — the one responsibility of the frontend SDK
  that hand-rolling quietly inherited.

  Confirmed against a real core, same endpoint, both ways — note that **both
  return 200**, which is why nothing anywhere reported an error:

  | request | `Set-Cookie` | response headers |
  |---|---|---|
  | without `st-auth-mode` | *(none)* | `st-access-token`, `st-refresh-token` |
  | with `st-auth-mode: cookie` | `sAccessToken`, `sRefreshToken` | *(none)* |

  Both `/auth/signinup` and `/auth/session/refresh` now send it.

- **A login that sets no session now says so.** If sign-in succeeds but the
  session that follows does not exist, the login screen says the server did not
  set a session and suggests checking cookies, instead of silently returning to
  a blank login form. The absence of that message is the only reason v1.9.0's
  bug reached a production deploy — every layer reported success.

## v1.9.0

- **Every SuperTokens login was impossible, and had been since v1.8.**
  `server/supertokens/init.js` handed its OAuth providers to `ThirdParty.init`
  as `signInUpFeature`. The SDK reads `signInAndUpFeature`. That key is
  optional in its type definition and JavaScript does not reject unknown
  properties, so the provider list was discarded without a throw, a warning or
  a log line — while the boot log still printed `providers=github,discord`,
  because it logs what was *built* rather than what the recipe *received*.

  Every `GET /auth/authorisationurl` answered
  `400 {"message":"the provider github could not be found in the
  configuration"}`, for both providers. Nothing surfaced it: the client logged
  in through passport, so the endpoint was never called — which is also why a
  `dual` deployment running quietly in production proved less than it looked
  like it did.

  Fixed, with a test that runs the config `init.js` actually passes through the
  SDK's own normaliser, so it fails on a wrong key *and* on a future SDK
  rename rather than merely restating the fix. Confirmed against a real
  SuperTokens core 12: the same request returns `200` with a valid GitHub
  authorize URL, and restoring the typo reproduces production's 400 byte for
  byte — while `GET /api/auth-info` reports `providers:["github","discord"]` in
  both runs, which is exactly why nothing surfaced it for a release.

- **The client can log in through SuperTokens.** `client/src/game/auth.js`
  drives the three-call flow — fetch the authorisation URL, handle the
  `/auth/callback/<provider>` redirect, post `redirectURIInfo` to
  `/auth/signinup` — hand-rolled rather than via `supertokens-web-js`, whose
  `signOut()` targets the `/auth/signout` v1.8 deliberately removed for
  clearing only half of a dual-stack session. Cancelled logins, unconfigured
  providers and refused sign-ins each land back on the login screen with a
  readable message.

- **Sessions refresh themselves.** A 401 triggers one
  `POST /auth/session/refresh` and a retry. The refresh is serialised through a
  single shared promise: SuperTokens rotates the refresh token on use, so
  concurrent refreshes present an already-spent token and the core reads that
  as token theft and revokes the session — turning a routine renewal into a
  forced logout, and only ever under concurrency.

- **New public `GET /api/auth-info`** reports the auth mode, which login flow
  the client should drive, and which providers actually have credentials. The
  login screen needs all three *before* anyone is authenticated, so it could
  not live on `/api/config`. One build therefore serves `passport` and
  `supertokens` alike, and the documented rollback keeps working.

- `supertokens` mode is no longer described as unusable in the README,
  `.env.example`, the Unraid template, the rollout runbook and the migration
  guide. It is not yet described as proven either: every test stubs the core,
  so the first real login is a gate to run on your own deployment — the four
  checks are in `docs/authentication-methods.md` Phase 5 and runbook D6.

## v1.8.4

- **`AUTH_MODE=dual` would have refused to start against a correctly-secured
  core.** v1.8.3 fixed the wrong-endpoint bug in the preflight but left a second
  copy of the same probe in the boot path, still using `/recipe/users/count` —
  which SuperTokens core 12 does not implement. That guard *throws* on anything
  that is not a 401, so the 404 would have been read as "the core is running
  without API_KEYS" and stopped the container from booting.

  Unlike the preflight, where the bug printed an alarming line, here it would
  have blocked the cutover entirely and blamed the operator for a URL this code
  got wrong.

  The probe now lives in `server/supertokens/coreProbe.js` and is imported by
  both callers, so they cannot drift again — asserted by a test. The boot guard
  now throws **only** on a confirmed-open core (a known endpoint answering an
  unkeyed request with 200); every other outcome warns and lets the boot
  proceed.


## v1.8.3

- **`supertokens:check` no longer reports a correctly-secured core as wide
  open.** The API-key probe used a single guessed path,
  `/recipe/users/count`, which SuperTokens core 12 does not implement — the
  path is tenant-scoped (`/public/users/count`). Every probe returned 404, and
  the check read "not 401" as "not secured", producing:

  > The core is running without API_KEYS: anyone who can reach it can mint a
  > login session for any user id

  …against a core that was refusing anonymous callers correctly. It also
  blamed `SUPERTOKENS_API_KEY` for the same 404.

  The probe now tries the tenant-scoped path first and falls back to the legacy
  one, and — more importantly — **a 404 is reported as "could not determine",
  never as an open core**. A security check that cries wolf is worse than no
  check, because the next real warning gets ignored too.

- The core's telemetry is disabled by default in `docker-compose.yml`. It phones
  home to `api.supertokens.io`, whose certificate chains to the new
  `ISRG Root YR` root that the core image's JVM truststore does not carry,
  logging `SSLHandshakeException: PKIX path building failed` on every boot. The
  error is non-fatal, but it is noise in the log of the component that signs
  every session.


## v1.8.2

- **`npm run supertokens:check`** — a deployment preflight for the SuperTokens
  rollout, to be run *before* `AUTH_MODE` is set. Verifies the core is
  reachable, **requires authentication**, accepts your API key, and has its own
  database rather than sharing RackStack's; also checks the public origin and
  providers, and prints the exact redirect URLs to register.

  The authentication check is the one that earns its keep: a core running
  without `API_KEYS` will mint a login session for any user id — including
  every value in `SUPER_ADMIN_IDS` — without a request ever reaching RackStack,
  so nothing about it fails visibly. `shadow:check` gates the data half of the
  cutover; this gates the deployment half.

- **The SuperTokens core version is now verified at boot.** `supertokens-node`
  speaks one core-driver-interface version, and a core outside that window
  starts cleanly, passes its health check, and then fails every login — the SDK
  only notices from inside a request. RackStack now checks at startup and
  refuses to boot with a message naming both versions.

  The bundled compose file pins the core's **major** (`:12`) rather than
  `:latest` or a frozen patch: `:latest` would cross a major boundary
  unannounced, which is the only place protocol support realistically changes,
  while a frozen patch means a stale core signing every session.

## v1.8.1

- **`npm run shadow:check` now names the database it audited**, both as a log
  line before the run and inside the report block itself. The gate's own
  guidance says a `NOT RUN` result is usually the wrong database — but the
  report never said which one it read, so a `PASS` could not be checked against
  the box you meant to audit.

  The Postgres password is stripped from the printed connection string. This
  output gets `tee`'d to files, screenshotted and pasted into tickets, and
  redaction goes through the URL parser rather than a regex so an awkward
  password cannot survive half-masked.

- **The shadow gate has now been run against production** (2026-08-08, on the
  Unraid deployment): 6 identities compared, 6 matched, 0 mismatched, 0
  orphaned, 100%, `GATE: PASS`. That settles the one assumption v1.8 could not
  verify from source — cutover to `AUTH_MODE=dual` is cleared. The v1.8.0 notes
  below, which say it had not been run, were accurate at that release.

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

**Hardening from the pre-merge review.** A whole-branch security and code
review was run before merge. Everything below was found and fixed while
`AUTH_MODE` still defaulted to `passport`, so none of it was ever live:

- An **authentication bypass** in SuperTokens' stock `signinup` endpoint, which
  accepted a caller-supplied OAuth token as proof of identity. Any GitHub token
  able to read `/user` — including one from an unrelated app, or a leaked PAT —
  would have authenticated as its owner. Only the browser redirect flow is
  accepted now.
- The **SuperTokens core shipped unauthenticated with its port published.** An
  open core will mint a session for any user id, `SUPER_ADMIN_IDS` included,
  without any request reaching RackStack. The port is no longer published, the
  image is pinned, and the server refuses to start against a remote core with
  no `SUPERTOKENS_API_KEY`.
- **`npm run shadow:check` was not read-only** despite saying so: it ran the
  schema migration on load, which on SQLite renames colliding usernames and
  rebuilds a table. Pointed at a pre-v1.7 export it quietly rewrote it. It now
  opens its own read-only connection and issues one SELECT.
- The gate could not see **identity rows orphaned from `users`** (a player who
  can never log in) and reported PASS for a run that compared nothing.
- **`POST /auth/signout`** revoked the SuperTokens session but left the legacy
  cookie, so the "logged out" user stayed authenticated. Removed;
  `/auth/logout` clears both.
- Two **simultaneous first logins** raced on Postgres and failed the login.

**Not yet run anywhere.** Shadow mode has not been run against production
identities, and no cutover has happened.

**`dual` is the intended resting state for this release.** The server side of
`supertokens`-only mode is complete and tested, but the client has never been
taught to talk to SuperTokens: the login buttons point at the passport routes,
which that mode does not register, so logins would silently do nothing — and
there is no token refresh. Both are frontend work that has not been started.
The runbook and `docs/authentication-methods.md` cover this in full.

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
