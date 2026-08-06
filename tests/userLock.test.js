import { describe, it, expect } from 'vitest';
import { withUserLock, __pendingUserCount } from '../server/userLock.js';

/** Resolves after `n` microtask turns, so interleaving is deterministic. */
async function ticks(n) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

describe('withUserLock', () => {
  it('runs work for the same user strictly one at a time', async () => {
    const events = [];
    const slow = async (tag, turns) => {
      events.push(`${tag}:start`);
      await ticks(turns);
      events.push(`${tag}:end`);
    };

    // `a` is deliberately the slower one: if the lock were absent, `b` would
    // start (and finish) while `a` was still awaiting, producing
    // a:start, b:start, b:end, a:end.
    await Promise.all([
      withUserLock('u1', () => slow('a', 5)),
      withUserLock('u1', () => slow('b', 1)),
    ]);

    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('does not serialize different users against each other', async () => {
    const events = [];
    const slow = async (tag, turns) => {
      events.push(`${tag}:start`);
      await ticks(turns);
      events.push(`${tag}:end`);
    };

    await Promise.all([
      withUserLock('alice', () => slow('alice', 5)),
      withUserLock('bob', () => slow('bob', 1)),
    ]);

    // Bob must not have waited for Alice: he starts before she finishes.
    expect(events.indexOf('bob:start')).toBeLessThan(events.indexOf('alice:end'));
    expect(events).toContain('bob:end');
  });

  it('propagates the return value and the rejection to the caller', async () => {
    await expect(withUserLock('u2', async () => 'value')).resolves.toBe('value');
    await expect(withUserLock('u2', async () => { throw new Error('boom'); }))
      .rejects.toThrow('boom');
  });

  it('keeps serving a user after one of their requests throws', async () => {
    const failing = withUserLock('u3', async () => { throw new Error('first'); });
    const following = withUserLock('u3', async () => 'second');

    // Attach the rejection handler before awaiting `following` so a poisoned
    // queue shows up as a timeout/hang rather than an unhandled rejection.
    await expect(failing).rejects.toThrow('first');
    await expect(following).resolves.toBe('second');
  });

  it('releases the user entry once the queue drains, so the map does not grow', async () => {
    const before = __pendingUserCount();
    await withUserLock('ephemeral', async () => ticks(2));
    // The cleanup is itself a microtask chained off the tail.
    await ticks(3);
    expect(__pendingUserCount()).toBe(before);
  });

  it('holds the entry while later work is still queued behind the current holder', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });

    const first = withUserLock('held', () => gate);
    const second = withUserLock('held', async () => 'done');

    await ticks(2);
    expect(__pendingUserCount()).toBeGreaterThan(0);

    release();
    await first;
    await expect(second).resolves.toBe('done');
  });
});
