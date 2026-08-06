# SuperTokens Rollout Runbook (v1.8)

**Status: built, and not yet run anywhere.** Every part below is implemented
and covered by tests. `AUTH_MODE` defaults to the legacy stack, so v1.8 is safe
to deploy and changes nothing until an operator sets it.

### What has NOT been verified

Stated plainly, because a runbook that reads as though it has been rehearsed is
worse than one that admits it has not:

- **Shadow mode has never run against production identities.** The owner's
  current Unraid export has not been supplied. Part C is tested — including
  against a database deliberately seeded with a bad row — but only ever
  against test data.
- **No cutover has happened.** `AUTH_MODE` has never been anything but
  `passport` on any real deployment.
- **v1.7 has not been cut over on the Unraid box either.** The design gates
  v1.8's rollout on v1.7 running in production, and that is still outstanding.
- **No SuperTokens core has been run against this code outside tests.** Part B
  is written from the documented configuration, not from a stood-up instance.
- **`supertokens`-only mode is not recommended yet** — see D6. `dual` is the
  intended resting state for this release.

None of that blocks *deploying* v1.8. All of it blocks *rolling it out*, and
Part C exists to close the first item.

---

## 0. What exists right now

| Piece | Task | State |
|---|---|---|
| `AUTH_MODE` switch + validation | 1 | ✅ built |
| SuperTokens init + provider config | 2 | ✅ built |
| Identity mapping (`signInUp` override) | 3 | ✅ built |
| Auth middleware chain | 4 | ✅ built |
| Shadow-mode verification | 5 | ✅ built — **not yet run against production** |
| OAuth callback URL changes | 6 | 📄 documented below, not yet needed |
| Deployment config + release | 7 | ⬜ not started |

Plan: [`superpowers/plans/2026-08-06-v1.8-supertokens.md`](./superpowers/plans/2026-08-06-v1.8-supertokens.md)
Design: [`superpowers/specs/2026-08-01-postgres-supertokens-design.md`](./superpowers/specs/2026-08-01-postgres-supertokens-design.md) §5

---

---

## How your existing Discord and GitHub logins carry over

This is the part worth understanding before anything else, because it is what
determines whether a returning player finds their save or a blank one.

### Nothing about a player's account changes

RackStack identifies every player by `users.id`, which is the literal string
`provider:providerId` — `github:37058311`, `discord:123456789012345678`. That
id is the primary key of `users`, and it is what `saves`, `roles`,
`event_participation` and `SUPER_ADMIN_IDS` all point at.

**SuperTokens does not replace it.** It issues its own internal user id, and
then RackStack maps that id *onto* the existing one using SuperTokens' external
user-id mapping. After the mapping, `session.getUserId()` returns
`github:37058311` — exactly what the old JWT carried. Every route, every save
lookup, and your admin access resolve unchanged.

So: no save is rewritten, no id is renumbered, and no foreign key moves. The
v1.7 `identities` table already stores the `(provider, provider_id)` pairs this
mapping keys off; it shipped unused precisely so this release would be cheap.

### What a player actually experiences

| Player | What they see |
|---|---|
| Logged in now, stays logged in | Nothing. Their existing cookie is a 90-day JWT and stays valid through every mode change, in both directions. |
| Logs in again during `dual` | The same Discord/GitHub button. They authorise as usual and land on their existing save. |
| Brand-new player during `dual` | Normal signup; user + identity created, mapping points at the new id. |
| Anyone, if you roll back | Nothing. Rollback does not invalidate sessions. |

Nobody is asked to re-link, re-authorise, or create anything. There is no
"migrate your account" screen, because there is nothing for a player to do.

### The one assumption this rests on

The mapping works only if the id SuperTokens computes for a provider is the
same string passport stored. Both were checked against the pinned library
versions:

- **GitHub** — SuperTokens' built-in provider sets
  ``thirdPartyUserId = `${user.id}` `` (GitHub's numeric id, stringified).
  `passport-github2` sets `profile.id = String(json.id)`. Same field, same
  stringification.
- **Discord** — SuperTokens maps `userInfoMap.fromUserInfoAPI.userId` to `id`,
  the snowflake, already a string. `passport-discord` passes Discord's raw user
  JSON through, so `profile.id` is that same `id`.

That is strong evidence, and it is *not* the same thing as proof. What
ultimately matters is the values actually sitting in your `identities` rows,
some of which may have been written by older versions of those libraries.

**That gap is exactly what shadow mode (Part C) closes, and why cutover is
gated on it.** If the ids ever disagreed, the symptom would not be an error —
it would be a player quietly landing on a brand-new empty save, which is the
one failure mode this whole release is arranged to prevent.

### If you have used both Discord and GitHub

They stay separate accounts, as they do today. `users.id` is per-provider, so
`github:...` and `discord:...` have always been two different players with two
different saves. v1.8 changes nothing here — account linking is explicitly out
of scope (design §7). The schema permits it; no user-facing flow ships.

---

## Prerequisites

1. **v1.7 running in production**, on Postgres, confirmed working. The design
   gates v1.8 on this and it has not happened yet — the Unraid cutover to
   Postgres is still outstanding. See
   [`postgres-migration-runbook.md`](./postgres-migration-runbook.md).
2. **A current backup**, taken the same way as for the Postgres migration.
   This release does not move save data, but it does change how players are
   identified, and that is not a thing to do without a way back.
3. **The OAuth redirect change below applied** — and it must be applied
   *before* `AUTH_MODE=dual`, not at the same time.

---

## Part A — OAuth redirect URLs (do this first, days early if you like)

This is the change that would otherwise break every GitHub login the moment
SuperTokens is enabled. It is **additive and reversible**: nothing is removed,
and passport keeps working exactly as it does today, before and after.

### A1. Why it is needed

SuperTokens uses callback paths shaped `/auth/callback/<provider>`. RackStack
uses `/auth/<provider>/callback`. GitHub's rule is that a redirect URL's path
must reference a **subdirectory** of the registered callback URL — and
`/auth/callback/github` is *not* a subdirectory of `/auth/github/callback`.

Left alone, every SuperTokens GitHub login fails with a `redirect_uri`
mismatch, while passport logins carry on working, which makes it look like
SuperTokens is broken rather than like the OAuth app is misconfigured.

### A2. GitHub — widen, do not replace

In the GitHub OAuth app (Settings → Developer settings → OAuth Apps), change
the **Authorization callback URL** from:

```
https://your-domain.example.com/auth/github/callback
```

to the parent path:

```
https://your-domain.example.com/auth
```

Both `/auth/github/callback` (passport) and `/auth/callback/github`
(SuperTokens) are subdirectories of `/auth`, so both work simultaneously.

Leave `GITHUB_CALLBACK_URL` in your environment pointing at the existing
`/auth/github/callback` — that variable tells passport where to send people,
and passport's path has not changed.

### A3. Discord — add, do not replace

Discord permits multiple redirect URIs. In the Discord application's OAuth2
settings, **add**:

```
https://your-domain.example.com/auth/callback/discord
```

alongside the existing `https://your-domain.example.com/auth/discord/callback`.
Keep both.

### A4. Verify before moving on

Log in with Discord and with GitHub. Both must still work, because at this
point nothing about RackStack has changed — you have only widened what the
OAuth providers will accept. If a login broke here, revert the OAuth app
change and stop; do not proceed to Part B.

---

## Part B — Stand up the SuperTokens core

Safe to do at any time. The core sitting there unused changes nothing: with
`AUTH_MODE` blank, RackStack never contacts it.

### B1. Give it its own database

SuperTokens manages its own schema and must not share a database with
RackStack's tables. This is a separate **database** on the same Postgres
server — not a separate server, and not a schema inside `rackstack`.

```bash
psql -U rackstack -d rackstack -c 'CREATE DATABASE supertokens OWNER rackstack;'
```

On Docker Compose with a *fresh* `pgdata`, `docker/init-supertokens-db.sql`
does this automatically. On any existing install — which includes every one
that migrated to Postgres in v1.7 — Postgres only runs init scripts when the
data directory is first created, so run the command above by hand.

### B2. Run the core

**Compose** — it is behind an opt-in profile, so it does not start by default:

```bash
docker compose --profile supertokens up -d
```

**Unraid** — add a container from
`registry.supertokens.io/supertokens/supertokens-postgresql`, publish port
3567, and set one variable:

```
POSTGRESQL_CONNECTION_URI=postgresql://rackstack:PASSWORD@192.168.x.x:5432/supertokens
```

Two ways this line goes wrong, both worth reading twice:

- **The scheme must be `postgresql://`.** The SuperTokens core rejects
  `postgres://` at startup. This is specific to the core — RackStack's own
  `DATABASE_URL` accepts either, which v1.7 verified directly against an
  earlier claim to the contrary. Do not "fix" `DATABASE_URL` on the strength
  of this line.
- **Not `localhost`.** Inside a container that means the container itself.
  Use the host's LAN IP, or the compose service name.

### B3. Check it came up

```bash
curl -s http://127.0.0.1:3567/hello
```

Expect `Hello`. If it does not respond, check the core's log for a connection
error against the database from B1 — that is the overwhelmingly common cause.

### B4. Point RackStack at it — but do not switch yet

Set `SUPERTOKENS_CONNECTION_URI` on the RackStack container. **Leave
`AUTH_MODE` blank.** The variable is only read in `dual`/`supertokens`, so
setting it now is inert and gets the configuration out of the way before the
step that actually changes behaviour.

## Part C — Shadow-mode verification gate

**Cutover to `dual` is gated on this reporting 100%.** Nothing in Part D
happens until it does.

### C1. Why there is a gate at all

The release rests on one equality: the id SuperTokens computes for a provider
is the same string passport already stored. That has two halves, and only one
of them can be checked by reading code:

| Half | How it was checked | Result |
|---|---|---|
| What SuperTokens *will* compute | Read both providers' source at the pinned versions | Verified — see "The one assumption" above |
| What is *already stored* in your `identities` rows | Cannot be read from code. Those rows were written by whatever library versions were installed the day each player first logged in, going back to v1.0. | **This is what Part C checks** |

If they ever disagreed, there would be no error and no log line. A returning
player would simply land on a brand-new empty save — and if they played on it
before anyone noticed, their old save could only come back from a restore.

### C2. Run the audit (do this first — it needs nothing switched on)

```bash
npm run shadow:check
```

It reads whichever database your usual environment variables point at
(`DATABASE_URL`, or `DB_PATH` for SQLite) and checks every identity row.

**It is read-only.** It issues nothing but SELECTs, touches no session, and
creates nothing. Safe to run against production with players online — and safe
to run against a restored export on a laptop, which is the intended use, since
this has to clear *before* the SuperTokens stack is switched on.

A clean run:

```
[shadow] MATCH github:37058311 -> github:37058311
[shadow] MATCH discord:536626725380161537 -> discord:536626725380161537

=== SuperTokens shadow-mode report ===
logins compared:      2
matched:              2
mismatched:           0
no existing identity: 0 (new players - not failures)
match rate:           100.00%

GATE: PASS - 100% of comparable logins matched. Cutover to AUTH_MODE=dual is cleared.
```

Exit code 0 means pass; anything else means do not proceed.

### C3. Reading the result

| Report says | Meaning | Do |
|---|---|---|
| `GATE: PASS` | Every stored identity has the shape the mapping expects. | Proceed to Part D. |
| `GATE: FAIL` | One or more players would land on the wrong save. Every offending pair is named in the output. | **Stop.** Do not set `AUTH_MODE`. This needs looking at per row. |
| `GATE: NOT RUN` | Nothing was compared — usually the wrong database. | Check `DATABASE_URL`/`DB_PATH`. An empty run is **not** a pass. |

That last row is why the script exits non-zero on an empty run: a gate that
reported success because it read nothing would manufacture exactly the false
confidence it exists to prevent.

### C4. The live per-login check (optional, during `dual`)

`createShadowRun()` in `server/supertokens/shadow.js` does the same comparison
for an actual completed SuperTokens login, logging one line each, and likewise
writes nothing and does not touch the caller's session. It is useful as
belt-and-braces once `dual` is on, but it cannot be the gate — it needs the
SuperTokens stack reachable and someone logging in through it, which is most of
what the gate is meant to clear beforehand. **C2 is the gate.**

### C5. Status

> **This has not been run against production identities.** The owner's current
> Unraid export has not been supplied, and v1.7 has not been cut over on that
> box yet. The audit is built and tested — including against a database
> deliberately containing a bad row — but it has only ever run against test
> data. **No cutover has happened, and none is cleared.**

## Part D — Cutover

**Do not start this until Part C reports `GATE: PASS` against your real
database.** Parts A and B must also be done.

### D1. Take a backup

Same procedure as the Postgres migration — see
[`postgres-migration-runbook.md`](./postgres-migration-runbook.md) Part A.
Changing `AUTH_MODE` rewrites no player data, so this is belt-and-braces
rather than strictly required, but it costs minutes and the alternative to
having it is discovering you needed it.

### D2. Switch to `dual`

On the RackStack container, set:

```
AUTH_MODE=dual
```

Restart. Both login paths are now live and a session from either is accepted.

**Nobody is logged out by this.** Every existing cookie is a 90-day JWT and
`dual` keeps accepting them — that is the whole point of the mode.

### D3. Watch the boot

The container either starts cleanly or refuses to start. If it refuses, the
message names the cause; the three common ones:

| Message mentions | Cause | Fix |
|---|---|---|
| `Invalid AUTH_MODE` | Typo. Values are exact lowercase. | `passport`, `dual`, `supertokens` |
| `requires SUPERTOKENS_CONNECTION_URI` | Part B4 not done | Set it, restart |
| `needs to know this server's public origin` | No `PUBLIC_ORIGIN` and no callback URL to derive it from | Set `PUBLIC_ORIGIN` |

A refusal to start is the designed behaviour for a misconfiguration, not a
failure of the rollout. Nothing has changed for players at that point — the
previous container is still what is running until the new one comes up.

### D4. Verify, in this order

1. **An existing session still works.** Open the game in a browser that was
   already logged in. It should load your save with no login prompt at all.
   This is the no-forced-logout guarantee.
2. **A legacy login still works.** Log out, then log in with the normal
   Discord/GitHub button. This still goes through passport in `dual`.
3. **Your save is intact and your admin access still works.** Check the Admin
   tab appears if you are in `SUPER_ADMIN_IDS`.

If any of those fail, go to Part E. Nothing needs unpicking first.

### D5. Sit on `dual`

There is no schedule to keep. `dual` is a stable state, not a transition —
both stacks work, rollback stays free, and nothing degrades by leaving it
there for weeks.

### D6. `supertokens` mode — not yet recommended

> **Read this before considering it.** The client does not use the SuperTokens
> frontend SDK, so it has no interceptor to refresh an expired access token. In
> `dual` that is harmless: when a SuperTokens session expires, the request
> falls through to the legacy JWT cookie and the player stays logged in. In
> `supertokens` mode, once a player's legacy cookie has also expired, there is
> nothing to fall through to and they would be silently logged out when the
> access token expires.
>
> `supertokens` mode is implemented and tested, but **cutting over to it needs
> frontend refresh handling first**. `dual` is the intended resting state for
> this release.

## Part E — Rollback

Rollback is complete and cheap at every stage:

```
Set AUTH_MODE=passport (or blank it) → restart
```

Existing login cookies are signed JWTs valid for a full 90 days, and nothing
in this release invalidates or rewrites them. A player mid-session does not
notice the round trip in either direction. Unlike the Postgres migration,
there is **no one-way door here** — no player data is rewritten by changing
`AUTH_MODE`, so a rollback days later costs nothing.

**Do not change `JWT_SECRET` at any point during any of this.** Changing it
logs out every player, which looks alarmingly like the auth rollout having
gone wrong and will send you chasing the wrong problem.

---

## Quick reference

| Situation | Action |
|---|---|
| Deploying v1.8 | Nothing. Blank `AUTH_MODE` keeps the current login stack. |
| Container won't start, complains about `AUTH_MODE` | You typo'd it. Valid: `passport`, `dual`, `supertokens`, lowercase. |
| GitHub login fails with `redirect_uri` mismatch | Part A2 — widen the registered callback to `/auth`. |
| Anything looks wrong during rollout | `AUTH_MODE=passport`, restart. Nobody is logged out. |
| Everyone got logged out | Check `JWT_SECRET` is unchanged before anything else. |
