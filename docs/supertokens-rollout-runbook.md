# SuperTokens Rollout Runbook (v1.8)

**Status: IN PROGRESS — not ready to run.** The `AUTH_MODE` switch exists and
defaults to the legacy stack, so v1.8 is safe to *deploy*. It is not yet safe
to *roll out*: the SuperTokens integration behind the switch is still being
built. Parts B onward are placeholders until the tasks that back them land.

Do not set `AUTH_MODE` to anything but blank or `passport` yet.

---

## 0. What exists right now

| Piece | Task | State |
|---|---|---|
| `AUTH_MODE` switch + validation | 1 | ✅ built |
| SuperTokens init + provider config | 2 | ✅ built |
| Identity mapping (`signInUp` override) | 3 | ⬜ not started |
| Auth middleware chain | 4 | ⬜ not started |
| Shadow-mode verification | 5 | ⬜ not started |
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

*Pending Task 5.*

Will cover: running a SuperTokens login in shadow mode, which computes
`provider:thirdPartyUserId` and compares it against the existing `identities`
rows without touching the caller's session or writing anything.

**Cutover is gated on a 100% match.** This exists because the assumption that
SuperTokens' `thirdPartyUserId` equals passport's `profile.id` is load-bearing
and unverified — and if it is wrong, the symptom is a player silently landing
on a brand-new empty save rather than an error anyone would notice.

**This has not been run against production identities.** It cannot be until
the owner's export is available.

## Part D — Cutover

*Pending Tasks 3, 4 and 7. Gated on Part C reporting 100%.*

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
