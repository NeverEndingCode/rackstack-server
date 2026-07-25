# RackStack Expansion — Design Spec

**Date:** 2026-07-25
**Status:** Approved by owner (NeverEndingCode) after section-by-section review.
**Scope:** Four phased releases (v1.2 → v1.5) expanding RackStack into a long-term, multi-year idle game, inspired by Adventure Communist and ISEPS. FLOPS remains the primary currency throughout.

---

## 1. Goals

- Add strategic depth and content that stays fun for years, without ads or monetization pressure.
- An offline-time-gated progression area (ISEPS Hauler Mine inspiration).
- Automated seasonal + admin-triggered live events (Adventure Communist inspiration), one active at a time.
- Move the game to a **server-authoritative** trust model.
- A live admin balancing dashboard and a role system (admin, event coordinator).
- Gameplay fixes: Overclock Balance risk-zone scoring; slower heat accumulation (~4–5 min cycles).
- More goals extending late-game reach.

**Non-goals (this expansion):** full Adventure-Communist-style separate event mini-runs; spendable event currency + event shop; anti-cheat beyond plausibility bounds (friends-server threat model); contract rerolls; multiple concurrent offline job slots. All noted in §12 Future.

---

## 2. Roadmap

| Release | Name | Contents |
|---|---|---|
| v1.2 | Foundations & Balance | Config service, shared rules engine, server authority (action API), roles, admin dashboard v2, heat + Balance-game retuning |
| v1.3 | Cold Storage | 16×6h passive track, 1/8/24h offline-only jobs, Tapes currency + upgrade tree, new goals |
| v1.4 | Live Events | Config-overlay events with goal ladders, seasonal scheduler, coordinator tooling |
| v1.5 | Social & Retention | Contracts board, leaderboards, achievements/badges, daily streak |

Each phase ships as its own tagged release through the existing GHCR pipeline. Saves remain compatible at every step. Each phase gets its own implementation plan; v1.2 is planned first.

---

## 3. v1.2 — Foundations & Balance

### 3.1 Config service

- New singleton `config` DB row holding one versioned JSON balance document; `config_history` table records every edit for one-click rollback.
- Served at `GET /api/config` (any authenticated user). Client fetches at boot instead of importing constants. Server rules engine reads the same document.
- Document carries `schemaVersion`; the server auto-upgrades stored documents on boot when the schema evolves.

**Curated tunables** (v1.2 sections; §4–§5 add more):

```
heat:        capacity, ventAmount, ventCooldownMs, overheatCooldownMs
minigames:   winCooldownMs
             rush:    durationSec, waferDivisor, maxTapsPerSec (bound)
             debug:   durationSec, spawnMinMs, spawnMaxMs, maxLit, waferDivisor
             match:   durationSec, pairCount, waferPerPair
             balance: durationSec, safeZoneMin, safeZoneMax, riskZoneWidth,
                      pointsSafe (1), pointsRisk (5), missPenalty (2), maxScore (bound)
production:  globalMult, racksMult, gridMult, overclockMult   (default 1;
             also the lever live-event overlays pull)
offline:     baseCapHours, capPerUptimeLevel, hardCapHours, onlineGapThresholdSec
upgrades:    maxLevels per upgrade id (wafer + shard trees)
```

Tier/grid/overclock base cost & production curves stay in code — editing those live can corrupt existing economies.

### 3.2 Shared rules engine

- All formulas (costs, effects, milestones, XP, production rates, reward math) move to a dependency-free ESM module `shared/gameRules.js`, parameterized by the config document.
- Imported natively by the server; imported by the client via a Vite alias.
- This replaces the current duplicated client/server math and is the single point the admin dashboard tunes.

### 3.3 Server authority

- **Canonical state** lives in the `saves` table (`data` = canonical `{run, meta}`); `last_save` is reinterpreted as `lastEvaluatedAt`.
- **Lazy evaluation, no game loop:** on any request the server advances state by elapsed time using shared closed-form math, then applies actions.
- **Gap classification:** gaps ≤ `onlineGapThresholdSec` (~60s) are online (full production). Longer gaps run through the offline-cap path (base + uptime upgrade, 72h hard ceiling). The same classifier feeds v1.3 offline jobs.
- **Action API:** `POST /api/actions` accepts an ordered array of typed actions (~15 types: buy, collect, collectAll, hireManager, vent, migrate, singularity, buyUpgrade, buyShardUpgrade, claimGoal, claimRepeatable, claimAnomaly, hardReset, …). The server validates each (affordability, cooldowns, unlock conditions) against canonical state and returns fresh canon. Replaces `POST /api/save` and the sendBeacon flush. Client batches rapid clicks (~1s flush); significant actions flush immediately.
- **Sync:** `GET /api/state` evaluates and returns `{run, meta, configVersion, serverTime}`. Replaces `GET /api/save`.
- **Client prediction:** the client keeps its 250ms local tick as optimistic display, reconciling to canon on every action response/sync. Same math + same timestamps ⇒ near-zero visible drift. Rejected actions: drop optimistic diff, snap to canon, small toast.
- **Minigames:** `POST /api/minigame/start` issues a session (uuid, game, started_at); `POST /api/minigame/finish` accepts one result per session within game duration + a 10s grace window, clamped by config plausibility bounds (max taps/sec, max pairs, score ceilings) and enforces the per-game win cooldown server-side.
- **Anomaly toasts:** server owns `nextAnomalyAt` (a server-managed field in canonical state) and validates claims. Internal identifiers renamed from "event" to "anomaly" to free the `liveEvents` namespace.
- **Migration:** existing v1.1 saves become initial canonical state as-is. No reset, no data loss.

### 3.4 Roles

- `users.roles` — JSON array column, default `[]`. Values: `admin`, `event_coordinator`.
- Hardcoded owner `github:37058311`: irrevocable super-admin. Owner grants/revokes `admin`; owner+admins grant/revoke `event_coordinator`.
- Endpoints: `GET /api/admin/roles`, `POST /api/admin/roles` `{userId, role, action}` — role-checked server-side on every request.

### 3.5 Admin dashboard v2

Extends the existing Profile → Settings admin section into a full dashboard:
- **Balancing tab:** schema-driven editor for every tunable in §3.1 — each field shows current value, default, and validated range; Save writes a new config version; History lists versions with one-click rollback.
- **Roles tab:** user list with role chips; grant/revoke per the hierarchy above.
- (v1.4 adds an Events tab; see §5.)

### 3.6 Gameplay defaults shipped in v1.2

- **Overclock Balance scoring:** safe-zone center = +1; two risk strips just *inside* each safe-zone edge (width `riskZoneWidth`, default 4% each) = +5; any scoring attempt (bar click **or** STABILIZE button) outside the safe zone = −2, floored at 0. Strips are visually distinct.
- **Heat:** capacity becomes a config value, default **2000 heat units** (display stays 0–100%). Rationale: a reference mid-game loadout (20 air / 10 liquid / 5 immersion ≈ 6.7 heat/s) fills 2000 in ≈5 minutes, vs ≈15 seconds against today's cap of 100. Live-tunable if the reference point drifts as players scale.
- **All-time FLOPS counter** (`meta.stats.lifetimeFlopsAllTime`) starts accumulating in the reducer now so v1.5 leaderboards have history.

---

## 4. v1.3 — Cold Storage (offline-gated area)

**Theme:** tape archive / cold storage — the datacenter term for offline data is the mechanic. New tab, unlocked at Server Room (tier 4) owned ≥ 1. New currency: **Tapes**.

### 4.1 Passive track

- A cycle starts at `trackStartedAt`. Every 6 wall-clock hours (online or offline) the next block becomes claimable, up to 16 blocks (96h). After block 16 elapses, accrual **stalls** until the player claims all and presses **Reset Track**.
- Blocks claimable individually or via Claim All; Reset enabled only when all 16 are claimed.
- Rewards escalate by block index: mostly Tapes, occasional FLOPS scaled to current output, jackpot at block 16. Completed cycles increment `trackCycle`, giving a small permanent boost to future cycle rewards.

### 4.2 Offline jobs

- One job slot. Durations/flavors: **Defrag Run** (1h), **Index Rebuild** (8h), **Deep Archive Scrub** (24h).
- Progress accrues **only during offline gaps** (per §3.3 classifier); online time contributes zero.
- Superlinear payouts (base / ~10× / ~36×) from the config's `batchQueue` section. Cancelling forfeits progress.

### 4.3 Tape upgrade tree

Permanent — survives Migrate **and** Singularity. ~8 upgrades, values in config:
Compression Codecs (+% tape rewards) · Robot Arm (block time 6h → floor ~4h) · Priority Spin-up (offline job speed) · Head Start (reset grants first N blocks instantly) · Cold Fusion (global FLOPS mult) · Heat-Sink Tapes (+heat capacity) · Deep Uptime (+offline production cap hours).

### 4.4 State & actions

`coldStorage: { trackStartedAt, blocksClaimed, trackCycle, tapes, upgrades, job: {type, accruedOfflineSec, startedAt} | null }` in canonical state. Actions: `claimBlock`, `claimAllBlocks`, `resetTrack`, `startJob`, `cancelJob`, `claimJob`, `buyTapeUpgrade`.

### 4.5 Goals

New static late-game goals (first block-16 jackpot, complete a Deep Archive Scrub, tape-tree milestones) and repeatables (claim N blocks lifetime, complete N jobs), extending the longevity ladder. Config `batchQueue` section added to the dashboard.

---

## 5. v1.4 — Live Events

**Model: an event = a config overlay + a goal ladder.** Modifiers are partial config patches (validated against the base schema) applied while active — no special cases in the rules engine.

### 5.1 Definitions (DB-authored)

`live_events` table: identity (name, description, icon/color), `modifiers` (config overlay), `ladder` (10–20 rungs of `{metric, target, reward}`), window, status (`draft → scheduled → active → ended`), recurrence (optional annual month/day + duration).

- Ladder metrics are event-scoped deltas (FLOPS earned, minigames won, blocks claimed, tapes earned since joining). Server snapshots baseline counters on first action during the event; progress = current − baseline.
- Rungs pay direct rewards (wafers/tapes/FLOPS); top rung awards a **badge** (feeds §6.3). No spendable event currency (future, §12).

### 5.2 Scheduling & exclusivity

- Scheduler on boot + hourly: activates arrived windows, ends expired ones. **One active event enforced at activation.**
- Seeded with 4 recurring seasonal events: Summer Surge, Spooky Packets, Black Frame Friday, Frost Uptime.
- Permissions: owner/admin/`event_coordinator` author drafts, schedule, trigger now, end early — from a new dashboard Events tab. Trigger-now with another event active requires explicitly ending it first.

### 5.3 Client UX

Event banner (surge-banner pattern) + an Event tab visible only while active: ladder, countdown, claim buttons. Rung claims remain open for a **48h grace period** after the event ends. Per-user event state: `eventProgress: { eventId, joinedAt, baseline, rungsClaimed }`.

---

## 6. v1.5 — Social & Retention

### 6.1 Contracts board

3 daily contracts rotating at midnight UTC, generated **deterministically from the date**: every player gets the same three contract *types* each day, while numeric targets scale to each player's own progress. Rewards: wafers + tapes. State: `contracts: { dateKey, completed[3], baseline }`; claims are actions.

### 6.2 Leaderboards

`GET /api/leaderboard` (cached ~60s), aggregated server-side from canonical saves: all-time FLOPS (counter from §3.6), level, Legacy Cores, Singularities, Tapes, latest-event top rung. Profile gains a leaderboard **opt-out** toggle. Rows show avatar, username, badges.

### 6.3 Achievements & badges

Distinct from goals — no payout, pure prestige. Unlocked **automatically in the reducer** when conditions are met (first Singularity, block-16 jackpot, Deep Archive Scrub, event top-rungs, level milestones). `meta.achievements: { id: unlockedAt }`. Displayed as a profile badge case and mini-icons on leaderboard rows.

### 6.4 Daily streak

7-day escalating claim (FLOPS → wafers → Tapes at day 7), staying at day-7 rewards while unbroken; a fully missed UTC calendar day resets to day 1 (same day-boundary as contracts). Rewards are a bonus, never a content gate.

---

## 7. Data model summary

**New/changed tables:** `config` (singleton) · `config_history` · `users.roles` (column) · `minigame_sessions` · `live_events` (v1.4). `saves.data` becomes canonical state; `saves.last_save` ⇒ `lastEvaluatedAt`. All changes additive; existing `CREATE TABLE IF NOT EXISTS` pattern plus guarded `ALTER TABLE`s.

**Canonical state additions by phase:** v1.2 `meta.stats.lifetimeFlopsAllTime`, server-managed `nextAnomalyAt` · v1.3 `coldStorage{…}` · v1.4 `eventProgress{…}` · v1.5 `contracts{…}`, `meta.achievements`, `streak{count, lastClaimDate}`.

---

## 8. API surface summary

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/state` | user | Evaluate + return canon (replaces GET /api/save) |
| `POST /api/actions` | user | Ordered action array; validate, apply, return canon |
| `GET /api/config` | user | Current balance document |
| `POST /api/minigame/start`, `/finish` | user | Session-bounded minigame results |
| `GET /api/leaderboard` | user | v1.5 aggregates (respects opt-out) |
| `PUT /api/admin/config`, `GET …/history`, `POST …/rollback` | admin | Balancing |
| `GET/POST /api/admin/roles` | owner/admin | Role management |
| `GET/POST/PUT /api/admin/events`, `POST …/trigger`, `POST …/end` | admin/coordinator | v1.4 event tooling |

All role checks happen server-side per request. Client-side role constants only control UI visibility.

---

## 9. Trust model

Server-authoritative via lazy evaluation + action validation. Minigames are bounded (session + plausibility caps), not tap-verified — sufficient for a friends-server; documented so leaderboard/event integrity expectations are honest. No further anti-cheat planned.

---

## 10. Testing

- **Rules engine:** table-driven vitest suite over the shared module (one suite covers both consumers by construction).
- **Reducer:** affordability/cooldown/bounds rejections; lazy-evaluation math vs hand-computed cases; gap-classification edges (exact threshold, DST-irrelevant epoch math, 72h cap).
- **Migration:** v1.1 save fixtures loaded through the v1.2 server; assert nothing lost.
- **E2E:** extend the existing Playwright smoke suite per phase (auth-cookie + seeded-DB pattern from v1.1).

---

## 11. Rollout & migration

- One release per phase via the existing tag → GHCR pipeline; Unraid picks up `:latest`.
- Config `schemaVersion` auto-upgrade on boot; `config_history` provides rollback.
- README gains: back up `rackstack.db` before upgrading.
- v1.2 client/server are coupled (action API) — single-image deployment already guarantees they ship together.

## 12. Future (explicitly deferred)

Separate event mini-runs (full Adventure Communist model) · spendable event currency + shop · contract rerolls · second offline job slot · streak grace tokens · public CA template listing.
