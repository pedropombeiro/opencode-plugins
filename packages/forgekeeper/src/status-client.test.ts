import { describe, expect, test } from 'bun:test';
import { HOME, type Output } from './rpc';
import { createStatusClient } from './status-client';
import type { Snapshot } from './store';

const found = (iid: string): Snapshot => ({
  loading: false,
  lookup: { kind: 'found', requests: [{ iid } as never] },
});

function harness() {
  const watches: Array<{ directory: string; keys: string[]; visible?: string }> = [];
  const enabled = new Map<string, boolean>();
  const statuses = new Map<string, Record<string, Snapshot>>();
  const released: string[] = [];
  let failing = false;
  const timers: Array<() => void> = [];
  const client = createStatusClient({
    clientID: 'cli',
    watch: async (directory, input) => {
      if (failing) throw new Error('plugin reloading');
      watches.push({
        directory,
        keys: input.keys,
        ...(input.visible !== undefined ? { visible: input.visible } : {}),
      });
      return { enabled: enabled.get(directory) ?? true, statuses: statuses.get(directory) ?? {} };
    },
    refresh: async (directory, key) => ({
      enabled: enabled.get(directory) ?? true,
      snapshot: statuses.get(directory)?.[key] ?? { loading: false },
    }),
    release: async (directory) => void released.push(directory),
    onChange: () => {},
    setTimer: (callback) => timers.push(callback),
    clearTimer: () => {},
  });
  return {
    client,
    watches,
    enabled,
    statuses,
    released,
    timers,
    fail: (value: boolean) => void (failing = value),
    settle: () => Bun.sleep(0),
  };
}

describe('createStatusClient', () => {
  test("moves a session's lease when the session moves to another directory", async () => {
    const app = harness();
    app.statuses.set('/a', { ses_1: found('1') });
    app.client.show({ directory: '/a', key: 'ses_1' });
    await app.settle();
    expect(app.client.snapshot({ directory: '/a', key: 'ses_1' })).toEqual(found('1'));

    // The footer hides the old place and shows the new one in one change.
    app.client.hide({ directory: '/a', key: 'ses_1' });
    app.client.show({ directory: '/b', key: 'ses_1' });
    await app.settle();
    expect(app.watches.slice(1)).toEqual([
      { directory: '/a', keys: [] },
      { directory: '/b', keys: ['ses_1'], visible: 'ses_1' },
    ]);
    expect(app.client.snapshot({ directory: '/a', key: 'ses_1' })).toEqual({ loading: false });
    expect(app.client.hasShown('ses_1')).toBe(true);

    // Later heartbeats renew only the new directory's lease.
    app.watches.length = 0;
    app.client.heartbeat();
    await app.settle();
    expect(app.watches).toEqual([
      { directory: '/a', keys: [] },
      { directory: '/b', keys: ['ses_1'], visible: 'ses_1' },
    ]);
  });

  test("keeps each directory's home status, which is not a session", async () => {
    const app = harness();
    app.client.show({ directory: '/a', key: HOME });
    app.client.show({ directory: '/b', key: HOME });
    await app.settle();
    app.watches.length = 0;
    app.client.heartbeat();
    await app.settle();
    expect(app.watches).toEqual([
      { directory: '/a', keys: [HOME] },
      { directory: '/b', keys: [HOME], visible: HOME },
    ]);
  });

  test("follows each directory's own reviewStatus setting", async () => {
    const app = harness();
    app.enabled.set('/off', false);
    app.client.show({ directory: '/off', key: 'ses_1' });
    app.client.show({ directory: '/on', key: 'ses_2' });
    await app.settle();
    expect(app.client.enabled('/off')).toBe(false);
    expect(app.client.enabled('/on')).toBe(true);
    // The last answer from another directory doesn't change it.
    app.client.heartbeat();
    await app.settle();
    expect(app.client.enabled('/off')).toBe(false);
    await app.client.refresh({ directory: '/on', key: 'ses_2' });
    expect(app.client.enabled('/off')).toBe(false);
  });

  test('keeps the last status, marked stale, while the server is unavailable, and retries', async () => {
    const app = harness();
    app.statuses.set('/a', { ses_1: found('1') });
    app.client.show({ directory: '/a', key: 'ses_1' });
    await app.settle();
    app.fail(true);
    app.client.heartbeat();
    await app.settle();
    expect(app.client.snapshot({ directory: '/a', key: 'ses_1' })).toMatchObject({
      lookup: found('1').lookup,
      error: { kind: 'request', message: 'PR/MR status service unavailable: plugin reloading' },
    });
    expect(app.timers).toHaveLength(1);
    app.fail(false);
    app.timers[0]();
    await app.settle();
    expect(app.client.snapshot({ directory: '/a', key: 'ses_1' })).toEqual(found('1'));
  });

  test('keeps the newest snapshot when an older RPC response arrives after an event', async () => {
    let answer = (_value: Output<'watch'>) => {};
    const client = createStatusClient({
      clientID: 'cli',
      watch: () => new Promise((resolve) => (answer = resolve)),
      refresh: async () => ({ enabled: true, snapshot: { loading: false } }),
      release: async () => {},
      onChange: () => {},
    });
    const place = { directory: '/a', key: 'ses_1' };
    client.show(place);
    await Bun.sleep(0);
    const done = { ...found('1'), revision: 12 };
    client.receive('/a', 'ses_1', done);
    answer({ enabled: true, statuses: { ses_1: { loading: true, revision: 11 } } });
    await Bun.sleep(0);
    expect(client.snapshot(place)).toEqual(done);
    // A newer response replaces it, and one without a revision never does.
    client.receive('/a', 'ses_1', { loading: false });
    expect(client.snapshot(place)).toEqual(done);
    client.receive('/a', 'ses_1', { ...found('2'), revision: 13 });
    expect(client.snapshot(place).revision).toBe(13);
  });

  test("ignores status events for keys it hasn't shown, and releases its leases", async () => {
    const app = harness();
    app.client.show({ directory: '/a', key: 'ses_1' });
    await app.settle();
    app.client.receive('/a', 'ses_2', found('2'));
    app.client.receive('/b', 'ses_1', found('3'));
    app.client.receive('/a', 'ses_1', found('1'));
    expect(app.client.snapshot({ directory: '/a', key: 'ses_2' })).toEqual({ loading: false });
    expect(app.client.snapshot({ directory: '/b', key: 'ses_1' })).toEqual({ loading: false });
    expect(app.client.snapshot({ directory: '/a', key: 'ses_1' })).toEqual(found('1'));
    app.client.dispose();
    expect(app.released).toEqual(['/a']);
  });
});
