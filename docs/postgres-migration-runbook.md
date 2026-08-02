# Postgres Migration — Backup, Cutover and Rollback Runbook

**Status: READY TO RUN.** All of Tasks 1–8 have landed (see §0) - Parts A, B
and C below are all valid to use now. `npm run test:all` passes on both
backends and all six `tests/e2e/smoke-v1*.mjs` suites pass against Postgres.

Applies to the Unraid install at `/mnt/user/appdata/rackstack-server/data`.

---

## 0. What actually exists right now

| Piece | Task | State |
|---|---|---|
| Async db interface | 1 | ✅ merged to branch |
| Facade + SQLite driver | 2 | ✅ merged to branch |
| Postgres test harness | 3 | ✅ merged to branch |
| Postgres schema + driver | 4 | ✅ merged to branch |
| `identities` auth split | 5 | ✅ merged to branch |
| **The migrator itself** (`npm run migrate:pg`) | 6 | ✅ merged to branch |
| Auto-migrate on boot | 7 | ✅ merged to branch |
| Compose/Unraid/docs | 8 | ✅ merged to branch |

**The migration tool is written, tested and wired into boot.** Task 5's
earlier open defects (permanent account lockout on partial write; SQLite's
foreign-key check running after `COMMIT` so it couldn't roll back the rebuild
it was supposed to guard) were fixed in subsequent rounds of review. Parts B
and C below are safe to use.

---

## Part A — Back up now (do this today)

Valid regardless of migration timing, and it is what unblocks verification.

### A1. Stop the container first

```
Unraid → Docker → rackstack-server → Stop
```

**Do not skip this.** SQLite keeps recently-committed writes in a separate
write-ahead log. Copying a running database captures the main file without the
log, so the newest progress — potentially hours of it — is silently absent from
your backup. The copy will look valid and open fine. It will just be stale.

### A2. Copy all three files

```bash
cd /mnt/user/appdata/rackstack-server
mkdir -p /mnt/user/backups/rackstack/$(date +%F)
cp -av data/rackstack.db     /mnt/user/backups/rackstack/$(date +%F)/
cp -av data/rackstack.db-wal /mnt/user/backups/rackstack/$(date +%F)/ 2>/dev/null || true
cp -av data/rackstack.db-shm /mnt/user/backups/rackstack/$(date +%F)/ 2>/dev/null || true
ls -la /mnt/user/backups/rackstack/$(date +%F)/
```

`-wal` and `-shm` may legitimately be absent if the database was closed cleanly
— that is why those two lines tolerate failure. `rackstack.db` must be there.

### A3. Verify the backup opens and holds what you expect

```bash
cd /mnt/user/backups/rackstack/$(date +%F)
sqlite3 rackstack.db "PRAGMA integrity_check;"
sqlite3 rackstack.db "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
sqlite3 rackstack.db "SELECT count(*) AS users FROM users;"
sqlite3 rackstack.db "SELECT count(*) AS saves FROM saves;"
sqlite3 rackstack.db "SELECT user_id, length(data) AS bytes, datetime(last_save/1000,'unixepoch') FROM saves;"
```

`integrity_check` must print `ok`. Record the user and save counts — they are
what the migration verifies against later.

### A4. Restart the container

```
Unraid → Docker → rackstack-server → Start
```

Confirm you can log in and your save is intact before walking away.

### A5. Send the export for verification

Copy that dated backup folder somewhere I can read it. It is used to prove the
migration reproduces every save byte-for-byte, and to confirm each stored
`provider_id` matches what SuperTokens will compute in v1.8 — the check that
prevents a player silently landing on a brand-new empty save after the auth
change.

If you would rather not share save contents, the counts and shapes from A3 plus
the output of

```bash
sqlite3 rackstack.db "SELECT id, provider, provider_id, username IS NOT NULL FROM users;"
```

are enough for the identity-mapping half, though not for the byte-for-byte half.

---

## Part B — Cutover

### B1. Stand up Postgres

Add an official `postgres:16` container in Unraid with its **own** appdata path
(not rackstack's). Create a database and a user for it:

```sql
CREATE USER rackstack WITH PASSWORD 'choose-something-long';
CREATE DATABASE rackstack OWNER rackstack;
```

### B2. Take a fresh backup

Repeat Part A. The backup from a week ago is not the one you want to restore
from if something goes wrong tonight.

### B3. Configure rackstack

Set on the rackstack container:

```
DATABASE_URL=postgresql://rackstack:PASSWORD@192.168.x.x:5432/rackstack
```

Three ways this line commonly goes wrong:

- It must be `postgresql://`. `postgres://` is rejected outright.
- Use the host's LAN IP, not `localhost` or `127.0.0.1` — inside the container
  those point at the container itself.
- **Leave the `/app/data` volume mapping in place.** It is the migration source
  and your rollback path. Removing it is the one irreversible mistake here.

### B4. Start and watch

```
Unraid → Docker → rackstack-server → Start, then the log
```

Expected: a `[migrate]` line per table with a verified row count, then
`committed`, then `listening on :3000`.

Compare those counts against what you recorded in A3. They must match exactly.

If migration fails, **the container refuses to start by design.** That is not a
malfunction. Serving an empty game over live save data is worse than being
down: a stopped container gets investigated, an empty leaderboard might not be
noticed until saves have been overwritten on top of it. The log names the table
that failed.

### B5. Verify before you walk away

- Log in with **both** Discord and GitHub if you use both.
- Confirm your wafers/racks match what you had.
- Check the admin dashboard loads — that proves `SUPER_ADMIN_IDS` still
  resolves, which it should, because `users.id` is deliberately unchanged by
  this migration.
- Check the leaderboard renders with real numbers, not blanks. Blank
  `rungsClaimed` values would indicate the camelCase-alias problem.

---

## Part C — Rollback

Four layers, cheapest first. **Read C0 before you need it.**

### C0. The one-way door

Rollback is free **until players start making progress on Postgres.**

Your SQLite file is never modified or deleted by the migration, so reverting to
it always works mechanically. But it is frozen at the moment of cutover. Once
players have been on Postgres for a while, going back to SQLite silently
discards everything earned since — and nobody gets an error, they just find
their progress reverted.

So: verify immediately after cutover (B5), and decide fast. A rollback ten
minutes after cutover costs nothing. A rollback three days later costs three
days of everyone's progress.

If you must roll back late, take a Postgres dump first so the interim progress
is at least recoverable:

```bash
pg_dump -U rackstack -h 192.168.x.x rackstack > rackstack-postgres-$(date +%F).sql
```

### C1. Migration failed, container won't start

Nothing was committed — the migrator runs in a single transaction and rolls the
whole thing back on any verification mismatch. Your SQLite data is untouched.

```
Remove DATABASE_URL from the container config → Start
```

You are back on SQLite exactly as before. Send me the `[migrate]` log lines.

### C2. Migration succeeded but the app misbehaves

```
Remove DATABASE_URL → Restart
```

Back on SQLite. Subject to C0 — fine immediately after cutover, lossy later.

Leave the Postgres database in place rather than dropping it; it is evidence.

### C3. SQLite data itself looks wrong

```
Stop the container
cd /mnt/user/appdata/rackstack-server/data
mv rackstack.db rackstack.db.suspect
cp -av /mnt/user/backups/rackstack/<DATE>/rackstack.db* .
Start the container
```

Restore all three files if all three were backed up. Keep the suspect copy.

### C4. Full revert to the previous release

Point the container back at the last known-good image tag:

```
Repository: ghcr.io/neverendingcode/rackstack-server:1.6.0
```

then apply C3. v1.6.0 has no knowledge of Postgres or of the `identities`
table, so it needs a pre-migration SQLite file — which is exactly what your
Part A backup is.

**Do not change `JWT_SECRET` at any point during any of this.** Changing it
logs out every player, which looks alarmingly like data loss and will send you
chasing the wrong problem.

---

## Quick reference

| Situation | Action |
|---|---|
| Before you touch anything | Part A, container stopped, all three files |
| Migration failed | Remove `DATABASE_URL`, restart — nothing was committed |
| App misbehaving right after cutover | Remove `DATABASE_URL`, restart |
| App misbehaving days after cutover | `pg_dump` first, then remove `DATABASE_URL` — you will lose interim progress |
| Save data looks wrong | Restore backup files (C3) |
| Need the old version back | Pin image to `1.6.0`, then C3 |
| Logins broke | Check `JWT_SECRET` is unchanged before anything else |
