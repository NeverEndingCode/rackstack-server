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
| SuperTokens init + provider config | 2 | ⬜ not started |
| Identity mapping (`signInUp` override) | 3 | ⬜ not started |
| Auth middleware chain | 4 | ⬜ not started |
| Shadow-mode verification | 5 | ⬜ not started |
| OAuth callback URL changes | 6 | 📄 documented below, not yet needed |
| Deployment config + release | 7 | ⬜ not started |

Plan: [`superpowers/plans/2026-08-06-v1.8-supertokens.md`](./superpowers/plans/2026-08-06-v1.8-supertokens.md)
Design: [`superpowers/specs/2026-08-01-postgres-supertokens-design.md`](./superpowers/specs/2026-08-01-postgres-supertokens-design.md) §5

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

*Pending Task 2.*

Will cover: the `registry.supertokens.io/supertokens/supertokens-postgresql`
container on port 3567, giving it its **own** database on the Postgres server
v1.7 stood up (never the rackstack database), and the two connection-string
footguns — the SuperTokens core requires the `postgresql://` scheme and
rejects `postgres://`, and the host may not be `localhost` from inside a
container.

> Note: `postgres://` being rejected is specific to the **SuperTokens core**.
> RackStack's own `DATABASE_URL` accepts either scheme — an earlier draft of
> the design claimed otherwise and v1.7 disproved it.

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
