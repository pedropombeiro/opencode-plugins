import { describe, expect, test } from 'bun:test';
import {
  connectStatus,
  createFeedbackLoader,
  createLiveStatus,
  loadFeedback,
  type ForgeRpcClient,
} from './client-core';
import { deferred, flush } from './testing';
import type { InboxState } from './feedback-inbox';

function fakeRpc() {
  const calls: Array<{ method: string; input: unknown; directory: string }> = [];
  const listeners = new Map<string, (event: { data: unknown }) => void>();
  const stopped: string[] = [];
  const method =
    (name: string, result: unknown) =>
    async (input: unknown, options: { location: { directory: string } }) => {
      calls.push({ method: name, input, directory: options.location.directory });
      return result;
    };
  const rpc = {
    watch: method('watch', { enabled: true, statuses: {} }),
    refresh: method('refresh', { enabled: true, snapshot: { loading: false } }),
    release: method('release', {}),
    feedback: method('feedback', { items: [], paused: true }),
    events: {
      on: (name: string, listener: (event: { data: unknown }) => void) => {
        listeners.set(name, listener);
        return () => void stopped.push(name);
      },
    },
  } as unknown as ForgeRpcClient;
  return { rpc, calls, listeners, stopped };
}

describe('client connection', () => {
  test('restores leases and accepts reset revisions after replacing the server client', async () => {
    const first = fakeRpc();
    const second = fakeRpc();
    const live = createLiveStatus({ clientID: 'gui', onChange: () => {} });
    const place = { directory: '/repo', key: 'one' };
    live.show(place);
    live.connect(first.rpc);
    await flush();
    first.listeners.get('status')!({
      data: { ...place, snapshot: { loading: false, revision: 100 } },
    });
    expect(live.client!.snapshot(place).revision).toBe(100);
    live.connect(second.rpc);
    await flush();
    expect(first.stopped).toEqual(['status']);
    expect(first.calls.at(-1)?.method).toBe('release');
    expect(second.calls[0]).toMatchObject({
      method: 'watch',
      input: { keys: ['one'], visible: 'one' },
    });
    second.listeners.get('status')!({
      data: { ...place, snapshot: { loading: false, revision: 1 } },
    });
    expect(live.client!.snapshot(place).revision).toBe(1);
    await live.client!.refresh(place);
    expect(second.calls.at(-1)?.method).toBe('refresh');
    live.dispose();
  });

  test('restores hidden leases without making them visible', async () => {
    const { rpc, calls } = fakeRpc();
    const live = createLiveStatus({ clientID: 'gui', onChange: () => {} });
    live.show({ directory: '/old', key: 'one' });
    live.show({ directory: '/new', key: 'one' });
    live.hide({ directory: '/new', key: 'one' });
    live.connect(rpc);
    await flush();
    expect(calls).toEqual([
      { method: 'watch', directory: '/new', input: { clientID: 'gui:1', keys: ['one'] } },
    ]);
    live.dispose();
  });
  test('leases shown places in their directory and applies status events', async () => {
    const { rpc, calls, listeners, stopped } = fakeRpc();
    let changes = 0;
    const connection = connectStatus(rpc, { clientID: 'gui', onChange: () => changes++ });
    connection.client.show({ directory: '/repo', key: 'one' });
    await flush();
    expect(calls[0]).toEqual({
      method: 'watch',
      input: { clientID: 'gui', keys: ['one'], visible: 'one' },
      directory: '/repo',
    });
    listeners.get('status')!({
      data: { directory: '/repo', key: 'one', snapshot: { loading: false, revision: 1 } },
    });
    expect(connection.client.snapshot({ directory: '/repo', key: 'one' }).revision).toBe(1);
    expect(changes).toBeGreaterThan(0);

    connection.dispose();
    await flush();
    expect(stopped).toEqual(['status']);
    expect(calls.at(-1)).toMatchObject({ method: 'release', directory: '/repo' });
  });

  test("reads a checkout's inbox from its own server instance", async () => {
    const { rpc, calls } = fakeRpc();
    expect(await loadFeedback(rpc, '/repo')).toEqual({ items: [], paused: true });
    expect(calls).toEqual([{ method: 'feedback', input: {}, directory: '/repo' }]);
  });
});

describe('feedback loading', () => {
  test('retries a directory whose first load failed', async () => {
    let attempts = 0;
    const states: InboxState[] = [];
    const errors: string[] = [];
    const state = { items: [], paused: true };
    const loader = createFeedbackLoader({
      load: async () => {
        if (++attempts === 1) throw new Error('offline');
        return state;
      },
      changed: (_directory, value) => states.push(value),
      failed: (_directory, error) => errors.push(error),
    });
    await loader.reload('/repo');
    expect(loader.has('/repo')).toBe(true);
    expect(errors).toEqual(['offline']);
    await loader.refresh();
    expect(states).toEqual([state]);
  });

  test('ignores late responses from a previous connection or request', async () => {
    const pending = Array.from({ length: 3 }, () => deferred<InboxState>());
    let index = 0;
    const states: InboxState[] = [];
    const loader = createFeedbackLoader({
      load: () => pending[index++].promise,
      changed: (_directory, state) => states.push(state),
      failed: () => {
        throw new Error('stale failure');
      },
    });
    const first = loader.reload('/repo');
    loader.invalidate();
    const second = loader.refresh();
    const third = loader.reload('/repo');
    pending[2].resolve({ items: [], paused: true });
    await third;
    pending[1].resolve({ items: [], paused: false });
    pending[0].reject(new Error('old connection'));
    await Promise.all([first, second]);
    expect(states).toEqual([{ items: [], paused: true }]);
  });
});
