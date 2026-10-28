import { describe, expect, test } from 'bun:test';
import { createRequestCache } from './request-cache';
import { deferred } from './testing';

describe('shared request cache', () => {
  test('inspects bounded fetch health without fetching and preserves success across failures', async () => {
    let clock = 1;
    const cache = createRequestCache<number>({ ttl: () => 0, now: () => clock, capacity: 1 });
    expect(cache.inspect('a')).toEqual({ loading: false });
    const gate = deferred<number>();
    const first = cache.get('a', () => gate.promise);
    expect(cache.inspect('a')).toEqual({ loading: true });
    gate.resolve(1);
    await first;
    expect(cache.inspect('a')).toEqual({
      loading: false,
      fetchedAt: 1,
      attemptedAt: 1,
      result: 'usable',
    });
    clock = 2;
    await expect(
      cache.get('a', async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow('offline');
    expect(cache.inspect('a')).toEqual({
      loading: false,
      fetchedAt: 1,
      attemptedAt: 2,
      result: 'usable',
      error: { message: 'offline', at: 2 },
    });
    cache.inspect('a').error!.message = 'mutated';
    expect(cache.inspect('a').error?.message).toBe('offline');
    await cache.get('a', async () => 2);
    const healthy = { loading: false, fetchedAt: 2, attemptedAt: 2, result: 'usable' } as const;
    expect(cache.inspect('a')).toEqual(healthy);
    cache.clear();
    expect(cache.inspect('a')).toEqual(healthy);
    await cache.get('b', async () => 3);
    expect(cache.inspect('a')).toEqual({ loading: false });
  });

  test('keeps the last usable fetch when a later result is incomplete or unavailable', async () => {
    let clock = 1;
    const cache = createRequestCache<number | undefined>({
      ttl: () => 0,
      now: () => clock,
      classify: (value) => (value === undefined ? 'unavailable' : value ? 'usable' : 'incomplete'),
    });
    await cache.get('a', async () => 0);
    expect(cache.inspect('a')).toEqual({ loading: false, attemptedAt: 1, result: 'incomplete' });
    clock = 2;
    await cache.get('a', async () => 1);
    clock = 3;
    await cache.get('a', async () => undefined);
    expect(cache.inspect('a')).toEqual({
      loading: false,
      fetchedAt: 2,
      attemptedAt: 3,
      result: 'unavailable',
    });
  });
  test('coalesces concurrent requests and reuses results until expiry', async () => {
    let clock = 0;
    let calls = 0;
    const cache = createRequestCache<number>({ ttl: () => 100, now: () => clock });
    const gate = deferred<number>();
    const load = () => {
      calls++;
      return gate.promise;
    };
    const first = cache.get('mr', load);
    const second = cache.get('mr', load);
    expect(second).toBe(first);
    gate.resolve(7);
    expect(await first).toBe(7);
    expect(await cache.get('mr', load)).toBe(7);
    expect(calls).toBe(1);
    clock = 100;
    await cache.get('mr', load);
    expect(calls).toBe(2);
  });

  test('isolates keys and retries failures instead of caching them', async () => {
    const cache = createRequestCache<number>({ ttl: () => 100 });
    await expect(
      cache.get('a', async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow('offline');
    expect(await cache.get('a', async () => 1)).toBe(1);
    expect(await cache.get('b', async () => 2)).toBe(2);
  });

  test('invalidation during a fetch prevents its result from replacing a fresh fetch', async () => {
    const cache = createRequestCache<number>({ ttl: () => 100 });
    const stale = deferred<number>();
    const first = cache.get('mr', () => stale.promise);
    cache.invalidate('mr');
    expect(await cache.get('mr', async () => 2)).toBe(2);
    stale.resolve(1);
    await first;
    expect(await cache.get('mr', async () => 3)).toBe(2);
  });

  test('does not retain incomplete results and bounds settled entries', async () => {
    const cache = createRequestCache<number>({ ttl: (value) => (value ? 100 : 0), capacity: 1 });
    expect(await cache.get('a', async () => 0)).toBe(0);
    expect(await cache.get('a', async () => 1)).toBe(1);
    await cache.get('b', async () => 2);
    expect(await cache.get('a', async () => 3)).toBe(3);
  });
});
