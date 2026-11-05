import { describe, expect, test } from 'bun:test';
import type { FeedbackEvents, ReviewRequest } from './forge';
import { createFeedbackSubscriptions } from './feedback-subscriptions';
import { SubscriptionRateLimit } from './subscription-retry';
import { flush } from './testing';

const mr = { forge: 'gitlab', url: 'https://gitlab.com/g/p/-/merge_requests/1' } as ReviewRequest;

describe('feedback subscriptions', () => {
  test('shares server cooldowns across MRs, preserves them on re-enrollment, and isolates hosts', async () => {
    let clock = 0;
    const timers = new Map<() => void, number>();
    const calls: string[] = [];
    const manager = createFeedbackSubscriptions({
      directory: '/repo',
      exec: async () => {
        throw new Error('Unexpected command');
      },
      changed: () => {},
      now: () => clock,
      capability: () => async (_run, _cwd, request) => {
        calls.push(request.url);
        throw new SubscriptionRateLimit(clock + 3_600_000);
      },
      setTimer: (callback, delay) => {
        timers.set(callback, delay);
        return callback;
      },
      clearTimer: (timer) => {
        timers.delete(timer as () => void);
      },
    });
    manager.update('one', [mr]);
    await flush();
    expect([...timers.values()]).toEqual([3_600_000]);
    expect(manager.connected(mr.url)).toBe(false);
    expect(manager.inspect('one', mr.url)).toMatchObject({
      state: 'waiting',
      retryAt: 3_600_000,
      cooldownUntil: 3_600_000,
    });
    manager.update('two', [{ ...mr, url: `${mr.url}2` }]);
    expect(calls).toEqual([mr.url]);
    manager.update('one', []);
    manager.update('one', [mr]);
    expect(calls).toEqual([mr.url]);
    const other = { ...mr, url: mr.url.replace('gitlab.com', 'gitlab.example.com') };
    manager.update('other', [other]);
    await flush();
    expect(calls).toEqual([mr.url, other.url]);
    clock = 3_599_999;
    const early = [...timers.keys()][0];
    timers.delete(early);
    early();
    expect(calls).toHaveLength(2);
    expect([...timers.values()]).toContain(1);
    clock++;
    const due = [...timers.entries()].find(([, delay]) => delay === 1)![0];
    timers.delete(due);
    due();
    await flush();
    expect(calls).toHaveLength(3);
    manager.dispose();
    expect(timers.size).toBe(0);
  });

  test('shares connections, recovers from disconnects, and cancels after the last session leaves', async () => {
    const connections: { events: FeedbackEvents; signal: AbortSignal; close: () => void }[] = [];
    const timers = new Map<() => void, number>();
    const changes: string[] = [];
    const manager = createFeedbackSubscriptions({
      directory: '/repo',
      exec: async () => {
        throw new Error('Unexpected command');
      },
      changed: (url) => {
        changes.push(url);
      },
      capability: () => async (_run, _cwd, _request, events, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
          connections.push({ events, signal, close: resolve });
        }),
      setTimer: (callback, delay) => {
        timers.set(callback, delay);
        return callback;
      },
      clearTimer: (timer) => {
        timers.delete(timer as () => void);
      },
    });
    manager.update('one', [mr]);
    manager.update('two', [mr]);
    expect(connections).toHaveLength(1);
    expect(manager.connected(mr.url)).toBe(false);
    expect(manager.inspect('one', mr.url)).toEqual({ state: 'connecting' });
    expect(manager.inspect('unknown', mr.url)).toEqual({ state: 'inactive' });
    connections[0].events.connected();
    connections[0].events.changed();
    expect(manager.connected(mr.url)).toBe(true);
    expect(manager.inspect('one', mr.url)).toEqual({ state: 'connected' });
    expect(changes).toEqual([mr.url, mr.url]);
    manager.update('one', []);
    expect(connections[0].signal.aborted).toBe(false);
    connections[0].close();
    await flush();
    expect(manager.connected(mr.url)).toBe(false);
    expect([...timers.values()]).toEqual([30_000]);
    const retry = [...timers.keys()][0];
    timers.delete(retry);
    retry();
    expect(connections).toHaveLength(2);
    connections[1].events.connected();
    expect(manager.connected(mr.url)).toBe(true);
    manager.update('two', []);
    expect(connections[1].signal.aborted).toBe(true);
    connections[1].events.changed();
    expect(changes).toHaveLength(3);
    await flush();
    expect(timers.size).toBe(0);
    manager.dispose();
  });

  test('leaves unsupported forges polling and backs off failed subscriptions until disposal', async () => {
    const timers = new Map<() => void, number>();
    let calls = 0;
    const manager = createFeedbackSubscriptions({
      directory: '/repo',
      exec: async () => {
        throw new Error('Unexpected command');
      },
      changed: () => {},
      capability: (request) =>
        request.forge === 'gitlab'
          ? async () => {
              calls++;
              throw new Error('Rejected');
            }
          : undefined,
      setTimer: (callback, delay) => {
        timers.set(callback, delay);
        return callback;
      },
      clearTimer: (timer) => {
        timers.delete(timer as () => void);
      },
    });
    manager.update('github', [
      { ...mr, forge: 'github', url: 'https://github.com/g/p/pull/1' } as ReviewRequest,
    ]);
    expect(calls).toBe(0);
    expect(manager.inspect('github', 'https://github.com/g/p/pull/1')).toEqual({
      state: 'polling-only',
    });
    manager.update('gitlab', [mr]);
    await flush();
    expect(manager.connected(mr.url)).toBe(false);
    expect(manager.inspect('gitlab', mr.url)).toMatchObject({
      state: 'waiting',
      error: { message: 'Rejected' },
    });
    const retry = [...timers.keys()][0];
    timers.delete(retry);
    retry();
    await flush();
    expect([...timers.values()]).toEqual([60_000]);
    manager.dispose();
    expect(timers.size).toBe(0);
    manager.update('gitlab', [mr]);
    expect(calls).toBe(2);
  });
});
