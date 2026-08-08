# Authentication: migration plan and how to add more login methods

Two things live here:

1. **[Part 1](#part-1--the-migration-plan)** — the full path from where RackStack
   is today (Discord + GitHub via passport) to SuperTokens, with the gates
   between each phase and an honest account of what is not built yet.
2. **[Part 2](#part-2--adding-more-authentication-methods)** — how to add
   further login methods once you are there, from "another OAuth provider"
   (genuinely small) to "email and password" (not small, and it changes the
   identity model).

Companion documents: the operator runbook is
[`supertokens-rollout-runbook.md`](./supertokens-rollout-runbook.md); the
design is [`superpowers/specs/2026-08-01-postgres-supertokens-design.md`](./superpowers/specs/2026-08-01-postgres-supertokens-design.md).

---

## The identity model — read this first

Everything in both parts is constrained by one decision made in v1.0 and never
revisited:

```
users.id  ===  `${provider}:${providerId}`      e.g.  github:37058311
```

That string is the primary key of `users`. It is the target of three foreign
keys (`saves.user_id`, `event_participation.user_id`, `identities.user_id`),
and it is the literal value an operator puts in `SUPER_ADMIN_IDS` to grant
themselves admin.

Since v1.7 the login methods themselves live in a separate table:

```sql
identities
  PRIMARY KEY (provider, provider_id)
  user_id              → users(id) ON DELETE CASCADE
  supertokens_user_id  TEXT UNIQUE NULL
  created_at, last_login_at
```

**This split is what makes new login methods cheap.** A `users` row can already
have many `identities` rows pointing at it — the schema has permitted it since
v1.7. What does not exist is any code that *creates* a second one for the same
user, or any UI to trigger it. That is the account-linking question, and Part 2
cannot avoid it.

Three consequences worth internalising:

- **A new provider means new accounts, not new logins for old accounts.** By
  default, a player who has always used GitHub and then clicks "Continue with
  Google" becomes `google:1234...` — a different `users.id`, therefore a
  different save. This is not a bug; it is what `users.id` means. It is also
  the single most likely thing to upset people, so decide about linking
  *before* you ship a third provider, not after.
- **`provider` values are permanent.** `identities.provider` is half a primary
  key and is embedded in every `users.id`. Renaming `github` to `gh` later
  would orphan every save. Choose the string once.
- **Provider ids must be treated as opaque strings.** Never parse them, and
  never build `users.id` from anything a user can choose freely. Today's ids
  are a GitHub numeric id and a Discord snowflake — both provider-assigned and
  immutable. See [the username trap](#the-username-trap) in Part 2.

---

# Part 1 — The migration plan

## Where things actually stand

| Layer | State |
|---|---|
| `AUTH_MODE` switch, validation, containment | ✅ built, tested |
| SuperTokens init, provider config, mounting | ✅ built, tested |
| Identity mapping (`signInUp` override) | ✅ built, tested, mutation-verified |
| Auth chain (SuperTokens → JWT → 401) | ✅ built, tested in all three modes |
| Shadow-mode gate (`npm run shadow:check`) | ✅ built, tested, read-only — **run against production 2026-08-08: `GATE: PASS`, 6/6** |
| `oAuthTokens` bypass fix | ✅ built, tested, mutation-verified |
| SuperTokens core hardening (API key, port) | ✅ enforced at boot |
| Whole-branch security & code review | ✅ run; all findings fixed |
| **Client-side SuperTokens login flow** | ❌ **does not exist** |
| **Client-side session refresh** | ❌ **does not exist** |
| Account linking | ❌ out of scope, by design |

The server side of the rollout is complete and has been through a three-reviewer
audit whose findings are fixed. The **client side has not been started**, and
that is what bounds how far the rollout can go — see Phase 5.

## Phase 0 — Prerequisites

1. ~~v1.7 running in production on Postgres.~~ **DONE.** Confirmed 2026-08-08
   by the v1.8.1 shadow report, which names the database it read:
   `postgres postgresql://rackstack_user@…:5432/rackstack`. The SuperTokens
   core in Phase 2 needs its **own** database on that same instance — never the
   `rackstack` one.
2. ~~A current production export supplied, for the shadow gate.~~ **Moot —
   satisfied a better way.** The gate was run directly on the Unraid container
   on 2026-08-08 (`GATE: PASS`, 6/6), which audits the live database rather
   than a copy of it. No export is needed.
3. **A backup**, taken the same way as for the Postgres migration.

**Gate:** 3 (a backup). 1 is done and Phase 3 has already passed, so the only
work left before `dual` is Phases 1 and 2.

## Phase 1 — Widen the OAuth redirect URLs

Additive and reversible; nothing is removed and passport keeps working. Safe to
do days early, and it must happen **before** `AUTH_MODE` changes.

- **GitHub** — widen the registered Authorization callback URL from
  `https://<domain>/auth/github/callback` to the parent path
  `https://<domain>/auth`. Both `/auth/github/callback` (passport) and
  `/auth/callback/github` (SuperTokens) are then subdirectories of it and both
  work simultaneously. Without this, every SuperTokens GitHub login fails with
  a `redirect_uri` mismatch while passport logins carry on — which looks like
  SuperTokens being broken rather than an OAuth app being misconfigured.
- **Discord** — *add* `https://<domain>/auth/callback/discord` alongside the
  existing redirect. Discord permits several. Keep both.

Leave `GITHUB_CALLBACK_URL` / `DISCORD_CALLBACK_URL` pointing at the passport
paths. They tell passport where to send people and passport has not moved.

**Gate:** log in with both providers. Both must still work — at this point
nothing about RackStack has changed, only what the providers will accept.

## Phase 2 — Stand up the SuperTokens core

Inert while `AUTH_MODE` is blank; RackStack never contacts it.

- Give it **its own database** on the existing Postgres server — not a schema
  inside `rackstack`. `docker/init-supertokens-db.sql` does this on a *fresh*
  `pgdata` only; any install that already migrated in v1.7 needs the
  `CREATE DATABASE supertokens` run by hand.
- `POSTGRESQL_CONNECTION_URI` must use the **`postgresql://`** scheme (the core
  rejects `postgres://` — this is specific to the core; RackStack's own
  `DATABASE_URL` accepts either) and must not use `localhost` from inside a
  container.
- **Set an API key, and do not publish port 3567.** A SuperTokens core with no
  `API_KEYS` serves its entire API unauthenticated, and that API will mint a
  session for *any* user id you ask for. Because the id mapping makes
  `session.getUserId()` return `github:37058311` verbatim, anyone who can reach
  that port can mint a valid RackStack session for any value in
  `SUPER_ADMIN_IDS` — which are deterministic and effectively public — without
  a single request touching RackStack, and therefore without meeting any of its
  guards. Generate with `openssl rand -hex 32`, set it as `API_KEYS` on the
  core and `SUPERTOKENS_API_KEY` on RackStack. The server refuses to start in
  `dual`/`supertokens` against a non-loopback core with no key.
- Set `SUPERTOKENS_CONNECTION_URI` on RackStack but **leave `AUTH_MODE` blank.**

> **Your Postgres role is `rackstack_user`, not `rackstack`.** Every example in
> this repo says `rackstack`, because `docker-compose.yml` stands up its own
> Postgres container with that user. On the real deployment substitute
> `rackstack_user` in `CREATE DATABASE ... OWNER`, in
> `POSTGRESQL_CONNECTION_URI`, and in `DATABASE_URL`.

**Gate:** the core answers `Hello`. With the port unpublished, ask from inside:
`docker compose exec supertokens bash -c 'curl -s http://127.0.0.1:3567/hello'`.

## Phase 3 — The shadow gate

```bash
npm run shadow:check
```

Genuinely read-only: it opens its own connection (SQLite read-only, Postgres in
a `READ ONLY` transaction) and issues one SELECT. Safe against production with
players online, and against a restored export on a laptop.

It audits every `identities` row and asks the two questions that cannot be
answered by reading library source:

- does `user_id` equal `provider:provider_id` for every row actually stored?
- does each row's `user_id` point at a user that **exists**?

**Gate: `GATE: PASS` (exit 0).** The report names the database it audited, so a
PASS can be checked against the box you meant to audit (the Postgres password
is stripped).

> **Status: passed on 2026-08-08** against the Unraid deployment — 6 identities
> compared, 6 matched, 0 mismatched, 0 orphaned, 100%. Phase 4 is cleared.

| Result | Meaning |
|---|---|
| `MISMATCH` | That player would land on the wrong save. |
| `ORPHAN` | The identity points at a user that does not exist — that player cannot log in at all. |
| `NOT RUN` | Nothing comparable was found, usually the wrong database. Deliberately **not** a pass; exits non-zero. |

A run of nothing but brand-new players is `NOT RUN`, not `PASS` — comparing
zero rows is not evidence of anything.

> Before v1.8.0-rc this command was **not** read-only: it ran the schema
> migration on load, which on SQLite renames case-colliding usernames and
> rebuilds `users`. Pointed at a pre-v1.7 export it quietly rewrote it and
> still printed `GATE: PASS`. If you are on an older build, do not point it at
> anything you care about.

## Phase 4 — `AUTH_MODE=dual`

Set it, restart. Both stacks live, sessions from either accepted.

**Nobody is logged out.** Existing cookies are 90-day JWTs and `dual` keeps
accepting them.

Verify in this order: an already-open session still works without a login
prompt; a fresh login through the normal button still works; your save and
admin access are intact.

> **`dual` is the intended resting state for v1.8.** There is no schedule to
> keep. Both stacks work, rollback stays free, and nothing degrades by leaving
> it there indefinitely.

An important nuance about what `dual` actually exercises: because the client
still drives logins through the passport routes (see Phase 5), turning on
`dual` does **not** by itself start routing anyone through SuperTokens. It
makes SuperTokens sessions *acceptable*, and it stands the whole stack up so it
can be exercised deliberately — it does not migrate live traffic. That is a
feature for a first cutover, but do not mistake a quiet `dual` deployment for
evidence that the SuperTokens path works end to end.

## Phase 5 — `supertokens` mode — blocked on client work

**This is the honest state: `supertokens`-only mode cannot be used yet, and the
blocker is larger than "not recommended".**

The server side is complete — SuperTokens' middleware serves
`GET /auth/authorisationurl` and `POST /auth/signinup`, the mapping override
runs, and sessions resolve to the right `users.id`. The client has never been
taught to call any of it:

1. **No login flow.** `client/src/Login.jsx` hardcodes
   `<a href="/auth/discord">` and `<a href="/auth/github">` — the *passport*
   routes. In `supertokens` mode those routes are not registered, so the
   request falls through to the SPA and the button silently does nothing.
   Existing sessions keep working via the JWT fallback, but **no one can log
   in**. Building this means: fetch the authorisation URL for the chosen
   provider, redirect the browser to it, then hand the returned code to
   `POST /auth/signinup` with `redirectURIInfo` (note: the raw-`oAuthTokens`
   form is deliberately rejected — see below).
2. **No session refresh.** There is no SuperTokens frontend SDK and so no
   interceptor to refresh an expired access token. In `dual` this is invisible
   because the legacy cookie still authenticates; in `supertokens`-only mode,
   once a player's legacy cookie has also expired, they are silently logged out
   when the access token expires.

Both are frontend work of a size worth planning separately. Until they exist,
Phase 5 is not reachable, and the runbook should not be read as implying
otherwise.

## Phase 6 — Rollback (available at every phase)

```
AUTH_MODE=passport  (or blank)  →  restart
```

Legacy cookies remain valid for their full 90 days, so a rollback days later
costs nothing and logs nobody out. Unlike the Postgres migration there is no
one-way door — changing `AUTH_MODE` rewrites no player data.

**Do not change `JWT_SECRET` during any of this.** It logs out every player and
looks exactly like the auth rollout having gone wrong.

---

# Part 2 — Adding more authentication methods

## Decide the linking question first

Before adding any third method, answer this, because retrofitting is much worse
than choosing:

> When a player who already has an account signs in with a **new** method, do
> they get their existing save, or a new empty one?

**Option A — separate accounts (today's behaviour).** Each provider is its own
player. Zero new code. Already true for Discord vs GitHub: they have always
been two different players with two different saves.

**Option B — account linking.** One `users.id`, many `identities` rows. The
schema already supports it. Needs: a "link another login method" flow for a
signed-in user, a rule for what happens when someone signs in with an unlinked
method that shares an email, and a decision about merging two saves that both
already have progress.

**Recommendation: A for OAuth providers you add now, and treat B as its own
release.** Option B's genuinely hard part is not the schema — it is that two
accounts can both have real progress, and merging them is a game-design
question (whose wafers? whose upgrades? whose achievements?), not a database
one. Deciding that under time pressure because you already shipped Google is
the bad version of this.

If you do choose B, note the trap: **automatic linking by email address is an
account-takeover vector** unless every provider involved verifies email
ownership. An attacker who can create an account at a provider that does not
verify email, using the victim's address, would inherit the victim's save. Link
only on an explicit, authenticated action by the already-signed-in user.

## Tier 1 — Another OAuth provider (Google, Twitch, GitLab, Apple…)

This is the easy path: roughly 20 lines plus config. SuperTokens ships built-in
providers for the common ones.

**1. Choose the `thirdPartyId` and never change it.** It becomes the `provider`
half of the primary key and the prefix of every `users.id` for those players.
Use SuperTokens' built-in id (`google`, `twitch`, `gitlab`, `apple`, …) so the
built-in provider config applies.

**2. Add it to `PROVIDER_IDS` and `buildProviders`** in
`server/supertokens/providers.js`:

```js
export const PROVIDER_IDS = Object.freeze(['github', 'discord', 'google']);

// inside buildProviders(env):
if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
  providers.push({
    config: {
      thirdPartyId: 'google',
      clients: [{
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Only if you narrow the default scope AND the narrowed set no
        // longer returns an email — see the requireEmail note below.
      }],
    },
  });
}
```

Follow the existing shape exactly: a provider with no credentials is **omitted**
rather than half-configured, so an operator running Discord-only is never
forced to supply credentials they do not have.

**3. `requireEmail: false` — when, and why it is not optional.** SuperTokens'
API layer returns `NO_EMAIL_GIVEN_BY_PROVIDER` and fails the login *before* the
mapping override ever runs, unless `requireEmail: false` is set for a provider
that yields no email. This bit Discord: pinning the scope to `identify` (to
match what passport asks for) removed the email, and without `requireEmail:
false` every Discord login would have failed at the API layer where our own
code never sees it. Google's default scopes return an email, so it does not
need the flag — but if you narrow any provider's scopes, re-check this.

**4. Register the OAuth app** with the redirect
`https://<domain>/auth/callback/google`. Note this is *only* the SuperTokens
path — a provider added now has no passport equivalent and does not need the
widening from Phase 1.

**5. Environment and deployment.** Add `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
to `.env.example`, `docker-compose.yml` and `unraid-template.xml`, following the
existing entries.

**6. The login button.** This is where Tier 1 collides with Phase 5: the login
screen drives passport, and **passport has no Google strategy**. So a new
provider is reachable only through the SuperTokens client flow, which does not
exist yet. In practice this means:

> **Adding a new OAuth provider requires the Phase 5 client work first.** There
> is no shortcut where the new provider works in `dual` through the old buttons.

**7. Tests.** Mirror the existing ones: `buildProviders` includes/omits it on
credentials, `PROVIDER_IDS` contains it, and — most importantly — an
end-to-end mapping test in `tests/supertokens.mapping.test.js` proving a login
resolves to `google:<id>` and creates exactly one identity.

**What you do NOT need to touch:** the mapping override, the auth chain,
`requireAuth`, `requireRole`, any route handler, or the database schema. The
mapping is provider-agnostic — it keys off `(thirdPartyId, thirdPartyUserId)`
whatever those are.

## Tier 2 — Non-OAuth methods (email+password, magic links, passkeys)

Materially harder, because they break the assumption `users.id` is built on.

**The identity problem.** `users.id` is `provider:providerId`, where
`providerId` is an immutable, provider-assigned id. Email/password has no such
thing:

- **Do not use the email address as `providerId`.** It is user-changeable and
  sometimes recycled. `email:alice@example.com` bakes a mutable value into a
  primary key referenced by three foreign keys — and if a user ever changes
  their email, either their save is orphaned or you are rewriting a primary key
  across the whole database.
- **Use SuperTokens' own user id instead**, giving `emailpassword:<st-uuid>`.
  It is opaque, immutable, and already unique. This inverts the mapping
  direction for these users — for OAuth, SuperTokens' id is mapped onto ours;
  here ours is derived from theirs — so `server/supertokens/mapping.js` needs a
  branch, and it is the one place in the codebase where getting it wrong loses
  saves. Test it the way the OAuth path is tested, ordering assertions and all.

**Other things that change:**

- **The nodemailer advisory becomes live.** It is currently accepted as
  unreachable *precisely because* only ThirdParty and Session recipes are
  initialised, so no SMTP delivery service is ever constructed. Adding
  `emailpassword`, `emailverification`, `passwordless` or `webauthn` makes that
  reachable and the assessment must be redone. See the Task 2 findings in the
  v1.8 plan.
- **You now run authentication infrastructure**, not just an OAuth
  redirect: password reset, email verification, rate limiting on login, and an
  SMTP sender that must actually deliver. Every one of those is a support
  burden that Discord and GitHub currently absorb for you.
- **Passkeys (`webauthn`)** avoid passwords and email delivery, and are the
  nicest of the three from a security standpoint — but SuperTokens' recipe is
  newer, and you still need an account-recovery story for a lost device, which
  usually drags email back in anyway.

**Recommendation:** if the goal is "more ways to sign in", stay in Tier 1.
Tier 2 is worth it only if the goal is specifically "sign in without a
third-party account", and it deserves its own design document rather than a
section in this one.

## The username trap

`deriveUsername()` in `server/supertokens/mapping.js` picks a display name from
the provider profile for **new players only** — a returning player's username
is never touched, deliberately, so that a weaker derivation can never silently
rename someone mid-rollout.

When adding a provider, check what its raw profile actually contains. The
current chain is `login` (GitHub) → `username` (Discord) → `global_name` →
`name` → email local-part → `${thirdPartyId}-${thirdPartyUserId}`. Google, for
instance, returns `name` (a display name, frequently "Firstname Lastname" with
a space) and no `login` or `username`. That will collide with the
`USERNAME_RE` validation used elsewhere far more often than GitHub's `login`
does, and `upsertUser`'s collision suffixing (`-2`, `-3`) will fire a lot.
Decide deliberately what a Google player should be called on first login.

And to be explicit, because it is the security-relevant half: **the username is
cosmetic and must never be part of identity.** Only `(provider, providerId)`
identifies a player.

## Checklist for adding an OAuth provider

- [ ] `thirdPartyId` chosen and understood to be permanent
- [ ] Linking question answered (Option A or B) — before shipping, not after
- [ ] `PROVIDER_IDS` + `buildProviders()` updated, omitting on missing credentials
- [ ] `requireEmail` re-checked if scopes were narrowed
- [ ] OAuth app registered with `/auth/callback/<id>`
- [ ] `.env.example`, `docker-compose.yml`, `unraid-template.xml` updated
- [ ] Phase 5 client login flow exists (or the provider is unreachable)
- [ ] `deriveUsername()` checked against the provider's actual profile shape
- [ ] Mapping test proving a login resolves to `<provider>:<id>` with one identity
- [ ] `npm run test:all` green on **both** backends
- [ ] `npm run shadow:check` still passes

## Things that would break the identity model

Collected because each one loses saves, silently:

| Do not | Because |
|---|---|
| Rename an existing `provider` value | It is half a primary key and the prefix of every `users.id` for those players. Every save orphans. |
| Use an email, username, or any user-changeable value as `providerId` | It is baked into a primary key referenced by three foreign keys. |
| Auto-link accounts by matching email | Account takeover unless every provider verifies email ownership. Link only on an explicit action by a signed-in user. |
| Accept `oAuthTokens` at `signInUpPOST` | This is the bypass fixed in `rejectRawOAuthTokens`. A token from *any* OAuth app the victim authorised would authenticate as them. Keep the redirect-URI flow as the only path. |
| Create the user-id mapping after the session | The session carries SuperTokens' internal id forever and the player lands on an empty save, with no error. |
| Add a recipe without redoing the nodemailer assessment | The advisory is only unreachable because no email-bearing recipe is initialised. |
