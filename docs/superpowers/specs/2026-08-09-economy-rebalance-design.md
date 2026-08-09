# v1.12 Economy Rebalance — design

**Date:** 2026-08-09
**Status:** Draft, awaiting owner review.
**Baseline audited:** `v1.11-risk-reliability` @ d7418ce (the current tip; `origin/main` is v1.10.0).
**Scope:** Retune the whole economy to AdVenture-Communist / ISEPS pacing. Config
changes plus a bounded set of formula fixes. No new subsystems.

---

## 1. Method

Every number in this document was measured by driving the real `shared/` engine
(`evaluate()` + `applyAction()`), never by re-implementing the math. Four
harnesses were built and are committed under `tools/`:

| tool | what it answers |
|---|---|
| `tools/curve.mjs` | the core loop in isolation, 1s resolution — is the rack ladder itself well-shaped? |
| `tools/ablate.mjs` | layer one subsystem at a time, continuous play — which system causes the acceleration? |
| `tools/pace.mjs` | a daily player (60 min/day + offline), 45 days — when does each tier/prestige land? |
| `tools/sim.mjs` | multi-session realistic play, for spot checks |

`tools/pace.mjs` takes `SHARED=shared` or `SHARED=shared-proposed`, so a
candidate change set can be measured against the shipped one directly. **This is
the acceptance harness for the whole release** — §5 is written against it.

The buying bot is greedy-by-payback (buy whatever repays its cost fastest),
which is the policy a competent idle player converges on. It therefore measures
how fast the game *can* be beaten, not a worst case.

---

## 2. Findings

### 2.1 The core loop is not the problem

Racks/Grid/Overclock in isolation, continuous play, no anomalies/goals/cold
storage/risk — tier unlocks land at **0, 1, 2, 3, 6, 17, 45 min, 2.1h, 6.3h,
19.8h**. A clean doubling curve. Cost grows ~15x per tier against ~7.7x
production, so payback roughly doubles per tier. This shape is right and is
kept.

### 2.2 The layered systems multiply progression by ~21x

Time to unlock tier 9, continuous play:

| scenario | tier 6 | tier 7 | tier 8 | tier 9 |
|---|---|---|---|---|
| core only | 44.8m | 2.1h | 6.3h | **19.8h** |
| + anomalies only | 11.3m | 23.3m | 1.9h | 8.6h |
| + goals/wafers/upgrades only | 19.8m | 52.7m | 3.2h | 5.8h |
| everything (shipped) | 4.8m | 8.5m | 13.8m | **54.9m** |

Under a realistic daily player (`tools/pace.mjs`, 60 min/day), the shipped game
delivers **all 14 tiers by day 14** and **a Singularity every single day from
day 1** — 18 Singularities and 21.7 million shards inside 45 days.

### 2.3 Signal Boost multiplies boost *duration*

Anomalies fire every 70–150s (mean 110s). The boost branch grants 2–4x global
output for 45–75s. `eventRewardMult` (Signal Boost, +20%/level × 10 levels)
scales **both** the credit payout and the boost duration:

```js
const duration = (45 + rng() * 30) * eff.eventRewardMult;   // reducer.js
```

At max Signal Boost that is 135–225s of boost against a 110s mean respawn — the
multiplier becomes **permanently active**. Modelled contribution to total
output: **+82% at Signal 0, +245% at Signal 10.** Measured boost uptime in the
shipped config: **51–55% of session time.**

Scaling a reward's *duration* by the same stat that scales its *magnitude* is
the defect; the two compound into permanent uptime.

### 2.4 Legacy Cores are additive, uncapped, and sqrt-fed

`migrateGain = floor(sqrt(lifetimeRun / 1e6) * legacyGainMult)`, each core worth
a flat +5% to every lane, with `legacyGainMult` reaching 4.5x.

After **24h of the core loop alone**, `lifetimeRun` is 15.0T → **3,871 cores =
×194 output**. In full simulation, Migrate #4 granted **1.48 billion** cores;
by day 45 the shipped game reaches 2.7×10¹⁴ cores.

### 2.5 The Singularity tree is bought out on first use — and Singularity is never worth taking

Two separate defects.

**Cost:** maxing *every* shard upgrade costs **21,316 shards**. One Singularity
at 10¹² cores yields 1,000,000 shards — **47x the entire tree**.

**Direction:** `singularity()` sets `legacyCores = 0` and grants
`floor(sqrt(cores))` shards. The multiplier destroyed is `1 + 0.05·C`; the
multiplier bought back is whatever `sqrt(C)` shards can purchase.

| cores at reset | multiplier lost | shards gained | tree value bought |
|---|---|---|---|
| 100 | ×6 | 10 | ≈×1.5–2 |
| 400 | ×21 | 20 | ≈×2.5 |
| 10,000 | ×501 | 100 | ≈×4–5 |

**Singularity is a strict downgrade at every scale.** It is only tolerable today
because cores regrow within a day. The moment core growth is slowed — which is
the entire point of this release — Singularity becomes a trap, and the top of
the tier ladder loses its engine. This is the single most important structural
fix in the plan (§4.3).

Separately, maxed Quantum Bootstrap (×10/level → ×100,000) plus Deep Cache hands
the player **11,000,000 credits at every Migrate**, enough to buy straight back
into tier-6 territory. Migrate stops being a reset.

### 2.6 The v1.11 risk system is EV-negative to engage with

One hazard per 6h, uniform over three kinds. Expected total output drag:
**1.89%**.

| supply | costs (h of output) | prevents (h of output) | EV |
|---|---|---|---|
| Antivirus | 0.250 | 0.250 | **1.00x** |
| Backup ISP | 0.167 | 0.050 | **0.30x** |
| Spare Drives | 0.208 | 0.040 | **0.19x** |

Buying supplies is break-even at best and strictly loss-making for two of the
three. The prepaid economy the release was designed around is a trap the
rational player ignores — and the whole system is a 1.89% rounding error either
way.

### 2.7 Overheating is binary, and it punishes the semi-idle player

Venting removes 25% of capacity per 2.5s = **200 heat/s sustained**. A maxed
300-per-tier Overclock fleet generates 69 heat/s net (the `thermal` +
`heatsink` + `autovent` stack cuts generation by 85% and subtracts a further
4/s).

- **Tapping vent: you cannot overheat at any realistic fleet size.** Ever.
- **Not tapping:** 100 units/tier → 36.5 overheats/hr, each downing a rack tier
  for 10 min → every tier dark essentially all the time. Measured: 3,096
  overheats in 24h, ~30x lifetime output lost.

There is no middle band where cooling is a real trade. Worse, heat does not
accrue offline (`evaluate()`'s offline branch leaves it untouched), so the
punished state is precisely *"online but not micromanaging"* — the core audience
of an idle game. And the penalty (a random tier dark) is never attributed to
overclocking in the UI, so it reads as the game being broken.

### 2.8 Live Event ladders use absolute targets

Seasonal ladders top out at `flopsEarned` 30,000 / `wafersEarned` 2,400 /
`tapesEarned` 240. `rungProgress` measures a delta from the join-time baseline,
but the targets are constants. At one hour of play, output is 1.82M FLOPS/s —
**the entire FLOPS ladder of every seasonal event clears in under 0.02
seconds.**

Contracts (`social.contractFlopsSeconds`) and streaks
(`social.streakFlopsSeconds`) correctly price in *seconds of current output*.
Event ladders are the one reward system that does not, and that inconsistency
is the whole bug.

### 2.9 Minigames trivialise the wafer tree

`balance` pays `metric * 1.5 * lucky` with `maxScore: 150` and Lucky Silicon at
2.5x → **562 wafers per 12-second game**. Cooldowns are 30s and **per-game**, so
four games rotate independently. The entire wafer tree costs 171,041 wafers →
**~2.5 hours of minigame grinding maxes every permanent upgrade in the game.**

### 2.10 Root cause

Rate curves are tunable; **reward magnitudes are hardcoded constants**. Every
system that pays out — anomaly rewards, event rungs, the balance minigame,
migrate/singularity gains, per-core value — is written against a fixed number
that was calibrated for the early game and never rescales. §4.8 addresses this
as a class, not case by case.

---

## 3. Decisions taken

Confirmed with the owner before drafting:

1. **Scope:** tunables plus targeted formula fixes. Retune `DEFAULT_CONFIG`, and
   fix the formulas no tunable can reach. Keep the architecture.
2. **Pacing target:** AdComm scale — day 1 tiers 0–4, week 1 tier 7 and first
   Migrate, week 2–3 first Singularity, week 4–6 tier 13, shard tree a
   multi-month goal.
3. **Saves:** grandfather existing progress. New curve applies going forward;
   no balances are rewritten.

On (3), note the consequence: the owner's own save carries ~4.5×10¹³ Legacy
Cores (a ×2.3-trillion multiplier) and is already past the end of all content,
so grandfathering means *that save will not experience any of this*. §4.9
handles it without a migration.

---

## 4. Design

### 4.1 Tier cost curve — the pacing backbone

Hold every `baseProd` exactly as-is (so goals, contracts, achievements and
grandfathered saves keep their meaning) and re-derive `baseCost` so the
**cost:production ratio grows geometrically per tier**:

```
baseCost[i] = baseProd[i] * BASE * RATIO^i        BASE = 10, RATIO = 2.35
```

Today that ratio is 8 → 23,000 across the ladder (~1.95x per tier). The proposal
takes it to 10 → 5.1×10⁵ (2.35x per tier), stretching the late game far more
than the early game — tier 0 is untouched, tier 13 becomes ~28x more expensive.

| tier | baseProd | old baseCost | new baseCost |
|---|---|---|---|
| 0 | 0.5 | 4 | 5 |
| 1 | 6 | 60 | 140 |
| 2 | 45 | 720 | 2,500 |
| 3 | 320 | 8,800 | 42,000 |
| 4 | 2,200 | 110,000 | 670,000 |
| 5 | 16,000 | 1.4e6 | 1.1e7 |
| 6 | 120,000 | 2.0e7 | 2.0e8 |
| 7 | 900,000 | 3.3e8 | 3.6e9 |
| 8 | 7.0e6 | 5.0e9 | 6.5e10 |
| 9 | 5.5e7 | 8.0e10 | 1.2e12 |
| 10 | 4.3e8 | 1.25e12 | 2.2e13 |
| 11 | 3.3e9 | 1.9e13 | 4.0e14 |
| 12 | 2.6e10 | 3.0e14 | 7.4e15 |
| 13 | 2.0e11 | 4.6e15 | 1.3e17 |

`GROWTH` (1.14) and the milestone thresholds are **unchanged** — within-tier
depth is already well-shaped (going 25→50 costs ×27.4 for ×4 output, which
correctly pushes players to tier-hop).

`RATIO` is the single dial for overall pacing and is the main thing §6 still
needs to converge.

### 4.2 Anomalies

**Formula fix.** Signal Boost must scale the payout only, never the duration:

```js
// reducer.js claimAnomaly — boost branch
const mult = pickBoostMult(config, rng);          // was [2,3,4]
const duration = rollBoostDurationMs(config, rng); // NO eff.eventRewardMult
```

**Config.**

| path | from | to |
|---|---|---|
| `anomaly.minDelayMs` | 70,000 | 420,000 (7m) |
| `anomaly.maxDelayMs` | 150,000 | 900,000 (15m) |
| `anomaly.windowMs` | 15,000 | 30,000 |
| `anomaly.boostMultMin` / `Max` | — (hardcoded 2–4) | 1.5 / 3.0 |

Rarer, more valuable when caught, and a doubled catch window so the reduced
frequency is not a harsher attention tax. Modelled contribution drops from
**+82%/+245%** to **+10% at Signal 0, +19% at Signal 10.** Measured boost uptime
falls from **55.1% → 3.8%.**

### 4.3 Prestige

Three coupled changes. This is the heart of the release.

**(a) Migrate yields far fewer cores.**

```js
migrateGain = floor((lifetimeRun / prestige.migrateDivisor) ** prestige.migrateExponent
                    * legacyGainMult)
// migrateDivisor = 1e9, migrateExponent = 0.42   (was sqrt(L/1e6), i.e. exponent 0.5, divisor 1e6)
```

**(b) Cap the Legacy Core bonus — this is what makes Singularity necessary.**

```js
coreMult = 1 + prestige.corePercentPerCore * Math.min(cores, prestige.coreBonusCap)
// corePercentPerCore = 0.05, coreBonusCap = 500  → the core lane plateaus at ×26
```

Migrating past the cap still accumulates cores (for Singularity), but stops
buying output. The plateau *is* the gate: it is what turns Singularity from a
strict downgrade (§2.5) into the only way forward, which is exactly the
AdComm rank structure the v1.2–v1.5 spec set out to imitate.

**(c) Re-price the shard tree so it is a genuine multi-month goal.**

- Reduce `costMult` on the expensive nodes (`engine` 2.6 → 1.9, `echocores`
  2.3 → 1.8) so the tree total drops from 21,316 shards to roughly 1,500 —
  reachable across many Singularities, not one.
- `bootstrapMult` from `10^level` to `3^level` (×100,000 → ×243). Combined with
  Deep Cache that is ~26,700 starting credits, a real head start that does not
  skip tiers.
- `echoCores` becomes proportional rather than flat: `floor(gain *
  prestige.echoPercentPerLevel * level)` instead of `+1 core per level`. A flat
  +10 cores per Migrate is exploitable once cores are scarce — a player can
  cheap-Migrate repeatedly for free cores.

### 4.4 Risk & supplies

All config. Make incidents twice as frequent but individually softer, and make
preparing clearly correct.

| path | from | to |
|---|---|---|
| `risk.hazardMinDelayMs` | 4h | 2h |
| `risk.hazardMaxDelayMs` | 8h | 4h |
| `risk.ransomwareFactor` | 0.5 | 0.35 |
| `risk.ransomwareDurationMs` | 30m | 45m |
| `risk.ispOutageDurationMs` | 15m | 40m |
| `risk.driveFailureDurationMs` | 20m | 45m |
| `risk.antivirusPriceSeconds` | 900 | 500 |
| `risk.backupIspPriceSeconds` | 600 | 200 |
| `risk.spareDrivesPriceSeconds` | 750 | 250 |
| `risk.overheatOutageMs` | 10m | 15m |

**Formula fix.** Drive failure and overheat currently pick a *random* owned rack
tier, which makes them both unpredictable and usually trivial. Both should hit
the **highest owned tier** — legible ("your Quantum Foam Harvester lost a
drive"), deterministic, and actually consequential. Gated behind two new
booleans (`risk.driveFailureTargetsTopTier`, `risk.overheatTargetsTopTier`) so
the behaviour can be reverted from the Balancing tab.

Result:

| supply | EV before | EV after |
|---|---|---|
| Antivirus | 1.00x | **3.51x** |
| Backup ISP | 0.30x | **2.40x** |
| Spare Drives | 0.19x | **3.24x** |

Unmanaged drag rises **1.89% → 9.4%**. The cure stays at `cureMultiplier` 2.5x
the supply price, so preparing remains strictly better than reacting — the
property `tests/outages.test.js` already pins.

### 4.5 Heat and overheating

The goal is to replace the binary with a real band, and to close the gap between
the attentive and the semi-idle player.

| path / effect | from | to |
|---|---|---|
| `heat.ventPercent` | 25 | 35 |
| `heat.ventCooldownMs` | 2,500 | 15,000 |
| `autoVentPerSec` per level | 0.5 | 4.0 |
| `thermal` per level | −8% | −5% |
| `heatsink` per level | −25% | −15% |
| heat discount floor | 0.15 | 0.40 |

Manual venting drops from **200 heat/s to 46.7 heat/s**, so it can no longer
trivially outrun any fleet. Passive venting rises sharply, so an upgraded player
is self-sustaining without tapping. The resulting sustainable fleet size:

| | idle (no tapping) | tapping vent |
|---|---|---|
| no heat upgrades | 0 nodes/tier | 29 nodes/tier |
| heat upgrades maxed | **49 nodes/tier** | **121 nodes/tier** |

Attention is now worth ~2.5x fleet size instead of ~26x, and Thermal
Regulators / Auto-Vent become genuinely worth buying — today they are close to
irrelevant. Pushing past your cooling is a deliberate choice with a known
penalty, which is the trade the system was always meant to offer.

Every one of these should be a tunable (`heat.autoVentPerLevel`,
`heat.thermalPerLevel`, `heat.heatsinkPerLevel`, `heat.discountFloor`) — they
are hardcoded in `computeEffects` today.

**UI requirement (not optional):** the overheat toast must name the cause and
the victim — "Overclock Bay meltdown: Hyperscale Campus offline for 15:00".
Finding 2.7 is as much a legibility failure as a math one.

### 4.6 Live Event ladders

Add an optional `unit` to each ladder rung:

```js
{ metric: 'flopsEarned', target: 1800, unit: 'secondsOfOutput', reward: {...} }
```

At **join time** (`joinEventIfEligible`), materialise each rung's effective
target into `meta.eventProgress.targets[]`:

- `unit: 'secondsOfOutput'` → `target * goalCtx(state).totalOutputPerSec`
- absent / `'absolute'` → `target` unchanged (counts like `minigamesWon` and
  `blocksClaimed` stay absolute)

`rungProgress` then reads the materialised target from the progress record
rather than the ladder def. Snapshot-at-join is exactly the pattern
`rolloverContracts` already uses, and for the same reason: a rate-scaled target
recomputed on every read would recede as fast as the player approached it.

`validateLadder` must accept and validate `unit`, and apply its
strictly-increasing check per `(metric, unit)` pair.

Reseed all four seasonal ladders: FLOPS rungs become seconds-of-output
(600 / 1800 / 5400), and the wafer/tape/block/minigame rungs are raised to match
what the retuned economy actually produces over the event's duration.

### 4.7 Minigames

| path | from | to |
|---|---|---|
| `minigames.winCooldownMs` | 30,000 | 300,000 |
| `minigames.rush.waferDivisor` | 4 | 6 |
| `minigames.debug.waferDivisor` | 2 | 3 |
| `minigames.balance.waferPerPoint` | — (hardcoded 1.5) | 0.20 |

Target ≈1,000 wafers/hour of active play against a 171,041-wafer tree, i.e. the
wafer tree becomes a weeks-long goal pursued alongside goals and contracts
rather than a 2.5-hour grind. The `balance` coefficient must become a tunable;
it is currently a literal in `minigameWafers`.

### 4.8 Make reward magnitudes tunable (the root-cause fix)

Per §2.10, the recurring failure is hardcoded payout constants. Add these paths
to `DEFAULT_CONFIG` + `TUNABLES` so the next rebalance is config-only:

```
anomaly.creditsSecondsMin / creditsSecondsMax      (30 / 90)
anomaly.boostDurationMinMs / boostDurationMaxMs    (45000 / 75000)
anomaly.boostMultMin / boostMultMax                (1.5 / 3.0)
prestige.migrateDivisor / migrateExponent          (1e9 / 0.42)
prestige.corePercentPerCore / coreBonusCap         (0.05 / 500)
prestige.echoPercentPerLevel                       (0.05)
heat.autoVentPerLevel / thermalPerLevel            (4.0 / 0.05)
heat.heatsinkPerLevel / discountFloor              (0.15 / 0.40)
minigames.balance.waferPerPoint                    (0.20)
production.levelBonusPerLevel / levelBonusMaxLevel (0.02 / 200)
risk.driveFailureTargetsTopTier                    (boolean, true)
risk.overheatTargetsTopTier                        (boolean, true)
```

`production.levelBonusMaxLevel` closes a smaller unbounded loop: `levelBonusMult
= 1 + 0.02 * level` has no cap, and the repeatable goals never run out, so level
(and therefore output) grows forever.

Note `validateConfig` rejects unknown leaf paths and requires every `TUNABLES`
entry to be present, so `upgradeConfig` will fold these into existing stored
configs on read — no config migration needed.

### 4.9 Grandfathering

No save migration. `migrateSave` already defaults every new field, and the new
tunables land through `upgradeConfig`.

Consequence, stated plainly: existing saves keep their balances and will remain
past the end of the content. To let the owner actually playtest the new curve
without a migration, the plan relies on two things that already exist:

- the `hardReset` reducer action, for a clean read on the new curve;
- the admin Balancing tab, which is `TUNABLES`-driven and so picks up every new
  path in §4.8 with no dashboard change.

Recommend the owner hard-resets one account and leaves the live save untouched.

---

## 5. Acceptance criteria

Measured with `SHARED=shared-proposed DAYS=45 node tools/pace.mjs` (daily
player, 60 min/day). The release is done when:

| # | criterion | shipped | target |
|---|---|---|---|
| A1 | tier 4 first reached | day 1 | day 1 |
| A2 | tier 7 first reached | day 1 | day 5–9 |
| A3 | tier 10 first reached | day 3 | day 18–25 |
| A4 | tier 13 first reached | day 14 | **day 28–45** |
| A5 | first Migrate | day 1 | day 4–8 |
| A6 | first Singularity | day 1 | day 11–21 |
| A7 | Singularities in 45 days | 18 | 2–4 |
| A8 | shard tree % maxed at day 45 | 100% (47x over) | < 40% |
| A9 | boost uptime in-session | 55.1% | < 8% |
| A10 | unmanaged risk drag | 1.89% | 8–12% |
| A11 | every supply EV | 1.00 / 0.30 / 0.19 | all ≥ 2.0x |
| A12 | overheats/24h, upgraded fleet, tapping vent | 3,096 | 0 |
| A13 | overheats/24h, upgraded fleet, idle | 3,096 | 5–20 |
| A14 | top event rung reachable in < 1s | yes | no |
| A15 | hours of minigames to max the wafer tree | 2.5 | > 100 |

---

## 6. Verified so far, and what still needs calibration

Already demonstrated against `shared-proposed` (three calibration passes):

- **A9 met:** boost uptime 55.1% → **3.8%**.
- **A10/A11 met:** drag 1.89% → **9.4%**; supply EV **3.51 / 2.40 / 3.24**.
- **A1 met:** tier 4 on day 1.
- Heat band computed and sound (§4.5), pending in-sim confirmation of A12/A13.

**Still short of target — the whole middle and top of the curve:**

| criterion | target | current proposal |
|---|---|---|
| A2 tier 7 | day 5–9 | day 3 (too fast) |
| A3 tier 10 | day 18–25 | day 9 (too fast) |
| A4 tier 13 | day 28–45 | unreached at day 45 (too slow) |
| A5 first Migrate | day 4–8 | day 1 (too fast) |
| A6 first Singularity | day 11–21 | day 9 (close) |

Note the shape of the miss: the curve is simultaneously **too fast up to tier 10
and too slow after it**. That is not a `RATIO` problem — no single geometric
ratio fixes both ends. It is §2.5: cores never accumulate past ~95 because every
Singularity zeroes them and the shard tree buys back less than it destroys, so
the late game has no engine while the early game still has too much.

**§4.3(b)'s core cap and §4.3(c)'s re-priced shard tree are the fix, and neither
has been simulated yet** — the Singularity defect was only identified on the
third calibration pass, after the numbers above were produced. Together they
should push the early game *down* (fewer cores early, capped benefit) and the
late game *up* (Singularity finally pays), which is precisely the two-ended
correction the table needs.

Implementation should:

1. apply §4.3(b) and (c) to `shared-proposed`;
2. re-run `tools/pace.mjs`;
3. tune `RATIO` (2.2–2.5), `migrateExponent` (0.38–0.45) and `coreBonusCap`
   (300–800) until A1–A8 all hold.

Expect 2–4 further passes; each run is ~8 minutes. If A2–A5 stay too fast after
the core cap lands, the next dial is `migrateExponent`, not `RATIO` — `RATIO`
should be reserved for the tier-10-to-13 span it uniquely controls.

---

## 7. Test impact

Balance-coupled assertions that will need updating (found by grep, not
exhaustive):

- `tests/gameRules.test.js:47-48` — `migrateGain(1e6, 1) === 1`,
  `migrateGain(4e6, 1) === 2`. Both change under §4.3(a).
- `tests/reducer.meta.test.js:38` — asserts `bootstrapMult` / `echoCoresBonus`
  behaviour; both change under §4.3(c).
- `tests/reducer.meta.test.js:228,248` — pin the anomaly credit floor and the
  `duration = (45 + 0.9*30) * eventRewardMult` formula. The duration assertion
  is exactly the §2.3 defect and must be rewritten, not merely renumbered.
- `tests/gameData.test.js`, `tests/configSchema.test.js` — shape/ordering
  assertions over `TIER_DEFS` and `TUNABLES`; new paths must be added.
- `tests/events.test.js` — `validateLadder` gains the `unit` field.
- `tests/outages.test.js` — the cure-vs-supply property must still hold, and the
  random-victim assertions change under §4.4.

New tests to add: the core-bonus cap, the anomaly duration no longer scaling
with Signal Boost, and `secondsOfOutput` rung materialisation at join time.

---

## 8. Out of scope

- Per-tier conversion currencies / the full AdComm resource-chain model. This
  was considered and rejected for this release: it rewrites most of `shared/`
  and needs a save migration. Revisit if the retuned curve still feels flat.
- Any change to Cold Storage. It is the designated safe harbour (v1.11 spec
  decision 6) and audits as reasonably priced.
- Offline caps. Generous offline accrual is what makes a weeks-long curve
  tolerable for a daily player; leave it alone.
- New content. This release only re-prices what exists.

## 9. Risks

- **The pacing target is aggressive.** Day 1 currently delivers tiers 0–6 in
  simulation against a target of 0–4. Slowing the opening further risks a weak
  first session, which is the worst place to lose a player. Prefer overshooting
  slightly at the start and gating harder from tier 7 on.
- **The bot is an upper bound.** A greedy-payback bot with perfect uptime
  progresses faster than a human. Real pacing will be slower than every number
  in §5, so tune against the bot and expect the lived curve to be gentler.
- **Grandfathered saves make the live game unobservable.** With no migration and
  the owner's save past the end of content, the only feedback channel on whether
  this worked is a fresh playtest account (§4.9).
