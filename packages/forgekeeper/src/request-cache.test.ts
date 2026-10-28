import { describe, expect, test } from 'bun:test';
import { createRequestCache } from './request-cache';
import { deferred } from './testing';

describe('shared request cache', () => {
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
