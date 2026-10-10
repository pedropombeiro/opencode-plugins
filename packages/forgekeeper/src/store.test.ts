import { describe, expect, test } from 'bun:test';
import type { Repository } from './git';
import { ForgeError, type ReviewRequest } from './forge';
import { createStatusStore, type Lookup } from './store';

const repository = {
  head: '',
  branch: 'b',
  sourceBranch: 'b',
  source: { host: 'h', path: 'a/b' },
  targets: [],
} as Repository;
const found = (count = 1): Lookup => ({
  kind: 'found',
  repository,
  requests: Array.from({ length: count }, () => ({ iid: '1' }) as ReviewRequest),
});

function harness(
  load: (directory: string) => Promise<Lookup>,
  extra: Partial<Parameters<typeof createStatusStore>[0]> = {},
) {
  let clock = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 0;
  let changes = 0;
  const store = createStatusStore({
    ...extra,
    load,
    onChange: (key) => {
      changes++;
      extra.onChange?.(key);
    },
    now: () => clock,
    setTimer: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { at: clock + delay, callback });
      return id;
    },
    clearTimer: (id) => timers.delete(id as number),
    interval: 100,
    maxBackoff: 400,
    minEventInterval: 10,
  });
  return {
    store,
    changes: () => changes,
    pending: () => [...timers.values()].map((timer) => timer.at - clock),
    async advance(ms: number) {
      clock += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > clock) continue;
        timers.delete(id);
        timer.callback();
      }
      await Bun.sleep(0);
    },
  };
}

describe('createStatusStore', () => {
  test('deduplicates concurrent loads and polls while acquired', async () => {
    let calls = 0;
    const { store, pending, advance } = harness(async () => {
      calls++;
      return found();
    });
    const release = store.acquire('/a');
    const second = store.acquire('/a');
    await store.refresh('/a');
    expect(calls).toBe(1);
    expect(store.get('/a').lookup).toEqual(found());
    expect(pending()).toEqual([100]);

    await advance(100);
    expect(calls).toBe(2);
    release();
    expect(pending()).toEqual([100]);
    second();
    expect(pending()).toEqual([]);
  });

  test('reuses cached data when a session is shown again', async () => {
    let calls = 0;
    const { store, pending, advance } = harness(async () => {
      calls++;
      return found();
    });
    const hide = store.acquire('/a');
    await store.refresh('/a');
    hide();
    await advance(40);
    const hideAgain = store.acquire('/a');
    expect(calls).toBe(1);
    expect(pending()).toEqual([60]);
    hideAgain();
    await advance(60);
    store.acquire('/a');
    await store.refresh('/a');
    expect(calls).toBe(2);
  });

  test('does not retry a failed lookup on every switch', async () => {
    let calls = 0;
    const { store, advance } = harness(async () => {
      calls++;
      throw new ForgeError('auth', 'GitLab authentication failed');
    });
    const hide = store.acquire('/a');
    await store.refresh('/a');
    hide();
    store.acquire('/a')();
    store.acquire('/a')();
    expect(calls).toBe(1);
    await advance(200);
    store.acquire('/a');
    await store.refresh('/a');
    expect(calls).toBe(2);
  });

  test('does not poll without an MR', async () => {
    const { store, pending } = harness(async () => found(0));
    store.acquire('/a');
    await store.refresh('/a');
    expect(pending()).toEqual([]);
  });

  test('manual refresh bypasses the cache and updates subscribers while loading', async () => {
    let complete: (lookup: Lookup) => void = () => {};
    let calls = 0;
    const { store, changes } = harness(() => {
      calls++;
      return new Promise((resolve) => (complete = resolve));
    });
    const initial = store.refresh('/a');
    complete(found());
    await initial;
    const previousChanges = changes();

    const refresh = store.refresh('/a');
    expect(calls).toBe(2);
    expect(store.get('/a').loading).toBe(true);
    expect(store.get('/a').lookup).toEqual(found());
    expect(changes()).toBeGreaterThan(previousChanges);
    expect(store.refresh('/a')).toBe(refresh);

    complete(found(2));
    await refresh;
    expect(store.get('/a').loading).toBe(false);
    expect(store.get('/a').lookup).toEqual(found(2));
    store.dispose();
  });

  test('manual refresh recovers from a failure without waiting for backoff', async () => {
    let fail = true;
    const { store } = harness(async () => {
      if (fail) throw new ForgeError('request', 'GitLab unavailable');
      return found();
    });
    await store.refresh('/a');
    expect(store.get('/a').error?.message).toBe('GitLab unavailable');

    fail = false;
    await store.refresh('/a');
    expect(store.get('/a').error).toBeUndefined();
    expect(store.get('/a').lookup).toEqual(found());
    store.dispose();
  });

  test('keeps stale data on failure and backs off', async () => {
    let fail = false;
    const { store, pending, advance } = harness(async () => {
      if (fail) throw new ForgeError('rate-limit', 'GitLab rate limit reached');
      return found();
    });
    store.acquire('/a');
    await store.refresh('/a');
    fail = true;
    await advance(100);
    await store.refresh('/a');
    const snapshot = store.get('/a');
    expect(snapshot.lookup).toEqual(found());
    expect(snapshot.error).toMatchObject({ kind: 'rate-limit' });
    expect(pending()[0]).toBeGreaterThan(100);
    await advance(pending()[0]);
    await store.refresh('/a');
    expect(pending()).toEqual([400]);
  });

  test('throttles event refreshes but not invalidations', async () => {
    let calls = 0;
    const { store, advance } = harness(async () => {
      calls++;
      return found();
    });
    store.acquire('/a');
    await store.refresh('/a');
    store.notify('/a');
    expect(calls).toBe(1);
    await advance(10);
    store.notify('/a');
    await store.refresh('/a');
    expect(calls).toBe(2);
    store.invalidate('/a');
    await store.refresh('/a');
    expect(calls).toBe(3);
    store.notify('/b');
    expect(calls).toBe(3);
  });

  test('polls active lookups at the active interval', async () => {
    let active = true;
    const { store, pending, advance } = harness(async () => found(), {
      active: () => active,
      activeInterval: 30,
    });
    store.acquire('/a');
    await store.refresh('/a');
    expect(pending()).toEqual([30]);
    active = false;
    await advance(30);
    expect(pending()).toEqual([100]);
  });

  test('reports each load with the lookup it replaced', async () => {
    const loads: Array<[string, Lookup | undefined, Lookup]> = [];
    let count = 1;
    const { store } = harness(async () => found(count++), {
      onLoad: (directory, previous, next) => loads.push([directory, previous, next]),
    });
    await store.refresh('/a');
    await store.refresh('/a');
    expect(loads).toEqual([
      ['/a', undefined, found(1)],
      ['/a', found(1), found(2)],
    ]);
  });

  test('keeps polling a lookup acquired from its load callback', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const { store, pending, advance } = harness(
      async () => {
        calls++;
        return found();
      },
      { onLoad: (directory) => (release ??= store.acquire(directory)) },
    );
    const hide = store.acquire('/a');
    await store.refresh('/a');
    hide();
    expect(pending()).toEqual([100]);
    await advance(100);
    expect(calls).toBe(2);
    release?.();
    expect(pending()).toEqual([]);
  });

  test('reports a failing load callback and keeps loading', async () => {
    const errors: unknown[] = [];
    const { store } = harness(async () => found(), {
      onLoad: () => {
        throw new Error('boom');
      },
      onLoadError: (error) => errors.push(error),
    });
    await store.refresh('/a');
    expect(store.get('/a').loading).toBe(false);
    expect(errors).toEqual([new Error('boom')]);
    await store.refresh('/a');
    expect(store.get('/a').lookup).toEqual(found());
  });

  test('survives a failing error callback', async () => {
    const { store } = harness(async () => found(), {
      onLoad: () => {
        throw new Error('boom');
      },
      onLoadError: () => {
        throw new Error('worse');
      },
    });
    await store.refresh('/a');
    expect(store.get('/a').loading).toBe(false);
  });

  test('discards a load that started before an invalidation, even when nothing polls', async () => {
    const resolvers: Array<(lookup: Lookup) => void> = [];
    const loaded: Lookup[] = [];
    const { store } = harness(() => new Promise((done) => resolvers.push(done)), {
      onLoad: (_key, _previous, next) => void loaded.push(next),
    });
    const first = store.refresh('/a');
    store.invalidate('/a');
    resolvers[0](found(2));
    await Bun.sleep(0);
    expect(loaded).toEqual([]);
    expect(store.get('/a').lookup).toBeUndefined();
    resolvers[1](found());
    await first;
    expect(loaded).toEqual([found()]);
  });

  test('loads at once when acquired after an invalidation while nothing polled', async () => {
    let calls = 0;
    const { store, advance } = harness(async () => (calls++, found()));
    store.acquire('/a')();
    await advance(0);
    expect(calls).toBe(1);
    store.invalidate('/a');
    store.acquire('/a');
    await advance(0);
    expect(calls).toBe(2);
  });

  test("numbers every change, starting above any earlier store's revisions", async () => {
    const { store } = harness(async () => found());
    const loading = store.refresh('/a');
    const first = store.get('/a').revision ?? 0;
    await loading;
    expect(store.get('/a').revision).toBeGreaterThan(first);
    // The harness clock starts at 0. A store created a millisecond later
    // starts at 1000, above this one's few changes.
    expect(first).toBeLessThan(1000);
  });

  test('reports which key changed', async () => {
    const keys: string[] = [];
    const { store } = harness(async () => found(), { onChange: (key) => void keys.push(key) });
    await store.refresh('/a');
    expect(new Set(keys)).toEqual(new Set(['/a']));
  });

  test('reloads after an invalidation during a load', async () => {
    let resolve: (lookup: Lookup) => void = () => {};
    let calls = 0;
    const { store } = harness(() => {
      calls++;
      return new Promise((done) => (resolve = done));
    });
    store.acquire('/a');
    const first = store.refresh('/a');
    store.invalidate('/a');
    resolve(found());
    await Bun.sleep(0);
    expect(calls).toBe(2);
    resolve({ kind: 'none', reason: 'Detached HEAD' });
    await first;
    expect(store.get('/a').lookup).toEqual({ kind: 'none', reason: 'Detached HEAD' });
  });
});
