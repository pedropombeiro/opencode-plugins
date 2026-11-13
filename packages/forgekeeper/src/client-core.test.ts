import { describe, expect, test } from 'bun:test';
import { connectStatus, loadFeedback, type ForgeRpcClient } from './client-core';
import { flush } from './testing';

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
