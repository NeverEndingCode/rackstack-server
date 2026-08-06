// Per-user serialization for save read-modify-write sequences.
//
// Why this exists: before v1.7 every persistence call was a synchronous
// better-sqlite3 call, so `getSave -> evaluate -> putSave` completed inside a
// single event-loop turn and no second request for the same user could
// interleave with it. Node's single thread was the lock. v1.7 made the whole
// db interface async (Postgres cannot be synchronous), which removed that
// guarantee: two concurrent requests for one user now both await getSave,
// both observe the same state, and the second putSave silently overwrites the
// first. That is lost progress with no error on either request - the first
// caller already got a 200 describing a state that no longer exists.
//
// This is not hypothetical for an idle game: two open tabs are normal, and
// client/src/game/api.js only serializes the action-flush queue *within* one
// tab - fetchState() is not gated by it at all, and nothing coordinates
// across tabs.
//
// Scope: one process. The deployment is a single container (see
// docker-compose.yml / unraid-template.xml), so an in-process chain is
// sufficient and costs no round trip. If the server is ever run multi-process
// against one Postgres, this must become a row lock (`SELECT ... FOR UPDATE`
// on the save row inside a transaction) - an in-process map cannot see
// another process's writes.

/**
 * userId -> promise that settles when the currently queued work for that
 * user is done. Entries are deleted once the chain drains, so this does not
 * grow with the user table - only with users holding in-flight requests.
 */
const chains = new Map();

/**
 * Runs `fn` with exclusive access to `userId`'s save, queued behind any work
 * already in flight for that same user. Different users never block each
 * other.
 *
 * Returns whatever `fn` returns, and rejects with whatever `fn` throws - the
 * lock is transparent to callers. A rejection does NOT poison the queue: the
 * chain is linked on a tail that swallows outcomes, so one failed request
 * cannot wedge every subsequent request for that user.
 *
 * MUST NOT be called from inside another withUserLock for the same user -
 * the chain is not reentrant and would deadlock. Callers hold it around a
 * whole read-modify-write and call the unlocked primitives
 * (loadEvaluateAndSchedule, putSave) within it.
 */
export function withUserLock(userId, fn) {
  const previous = chains.get(userId) || Promise.resolve();

  // `previous` is always a swallowing tail, so it never rejects and fn always
  // runs. Chaining off it (rather than off the caller-visible promise) is
  // what keeps a thrown fn from breaking the queue for later callers.
  const result = previous.then(() => fn());

  const tail = result.then(() => {}, () => {});
  chains.set(userId, tail);

  // Drop the entry once this is the last queued work for the user. The
  // identity check matters: if another caller enqueued behind us before this
  // cleanup ran, chains holds *their* tail and deleting it would let a third
  // caller run concurrently with them.
  tail.then(() => {
    if (chains.get(userId) === tail) chains.delete(userId);
  });

  return result;
}

/** Test-only: number of users with work currently queued. */
export function __pendingUserCount() {
  return chains.size;
}
