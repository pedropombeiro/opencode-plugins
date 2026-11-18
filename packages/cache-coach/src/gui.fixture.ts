import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import * as gui from '@opencode/plugin/gui';
import * as solid from 'solid-js';
import type { StepEnded } from './coach.ts';

type Handler = (event: { data: StepEnded }) => void;

const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 100_000, write: 0 } };
const model = { providerID: 'provider', modelID: 'one' };
const selected = solid.createSignal(model);

function server(id: string) {
  const handlers = new Map<string, Set<Handler>>();
  const messages = [
    {
      type: 'assistant',
      id: 'step',
      model: { providerID: 'provider', id: 'one' },
      tokens,
      time: { created: Date.now(), completed: Date.now() },
      content: [],
    },
  ];
  const data = {
    on(type: string, handler: Handler) {
      const listeners = handlers.get(type) ?? new Set<Handler>();
      listeners.add(handler);
      handlers.set(type, listeners);
      return () => listeners.delete(handler);
    },
    session: {
      get: () => ({ id: 'shared', location: { directory: '/repo' } }),
      status: () => 'idle',
      cost: () => 0,
      root: (sessionID: string) => sessionID,
      message: {
        list: () => messages,
        get: () => messages[0],
      },
    },
    location: {
      model: {
        list: () =>
          ['one', 'two'].map((id) => ({
            providerID: 'provider',
            id,
            modelID: id,
            name: id,
            cost: [{ input: 5, output: 25, cache: { read: 0.5, write: 6.25 } }],
            limit: { context: 1_000_000 },
          })),
        sync: async () => {},
      },
      provider: { list: () => [], sync: async () => {} },
    },
  };
  return {
    id,
    data,
    client: { config: { get: async () => [] } },
    emit(type: string, data: Partial<StepEnded> = {}) {
      for (const handler of handlers.get(type) ?? [])
        handler({ data: { sessionID: 'shared', assistantMessageID: 'step', tokens, ...data } });
    },
    listeners: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

const a = server('a');
const b = server('b');
const [servers, setServers] = solid.createSignal([a, b]);
const ref = (connection: ReturnType<typeof server>) => ({
  key: `${connection.id}\nshared`,
  id: 'shared',
  server: connection,
});
const [current, setCurrent] = solid.createSignal<ReturnType<typeof ref> | undefined>(ref(a));
const [tabs, setTabs] = solid.createSignal([ref(a), ref(b)]);
const toasts: { title: string }[] = [];
const notified: { title: string; id: string }[] = [];
const registrations = new Map<unknown, unknown>();
const intervals = new Set<() => void>();
const exports: { default?: gui.Plugin.Definition } = {};

runInNewContext(readFileSync(process.argv[2], 'utf8'), {
  exports,
  require(name: string) {
    if (name === '@opencode/plugin/gui') return gui;
    if (name === 'solid-js') return solid;
    if (name === 'solid-js/web') return { template: () => () => undefined };
    throw new Error(`Unexpected runtime module: ${name}`);
  },
  setInterval(callback: () => void) {
    intervals.add(callback);
    return callback;
  },
  clearInterval(callback: () => void) {
    intervals.delete(callback);
  },
});

let dispose = () => {};
const stop = solid.createRoot((cleanup) => {
  dispose = cleanup;
  return exports.default!.setup!({
    id: 'opencode-cache-coach',
    options: { contextCeiling: 1000 },
    add(registry: unknown, item: unknown) {
      registrations.set(registry, item);
    },
    sessions: { current, list: tabs },
    screen: { current: () => (current() ? { composer: { model: selected[0] } } : undefined) },
    servers: {
      list: () => servers().map((server) => server.id),
      get: (id: string) => servers().find((server) => server.id === id),
    },
    toast: { show: (value: { title: string }) => toasts.push(value) },
    layout: { open: () => {} },
    attention: {
      notify: async (value: { title: string; id: string }) => {
        notified.push(value);
        return {};
      },
    },
  } as unknown as Parameters<NonNullable<gui.Plugin.Definition['setup']>>[0]);
});

assert.equal(a.listeners(), 6);
assert.equal(b.listeners(), 6);

a.emit('session.step.ended');
b.emit('session.step.ended');
assert.equal(toasts.length, 2, 'Each server must show its own context-limit tip');
a.emit('session.step.ended');
b.emit('session.step.ended');
assert.equal(toasts.length, 2, 'Repeated tips must stay suppressed');

b.emit('session.compaction.ended');
a.emit('session.step.ended');
assert.equal(toasts.length, 2, 'Compaction on B must not reset tips on A');
b.emit('session.step.ended');
assert.equal(toasts.length, 3, 'Compaction on B must reset its own context-limit tip');

solid.batch(() => {
  setCurrent(ref(b));
  selected[1]({ providerID: 'provider', modelID: 'two' });
});
assert.equal(toasts.length, 3, 'Navigating between sessions must not warn about model switches');
setCurrent(undefined);
solid.batch(() => {
  selected[1](model);
  setCurrent(ref(a));
});
assert.equal(toasts.length, 3, 'Returning from Home must not warn about a model switch');
selected[1]({ providerID: 'provider', modelID: 'two' });
assert.equal(toasts.at(-1)?.title, 'This model switch rewrites the cache');
assert.equal(toasts.length, 4, 'An actual model switch must show a tip');

const command = registrations.get(gui.Command) as () => gui.Command;
assert.equal(command().enabled, true);
assert.equal(command().slash?.name, 'cache');
setCurrent(undefined);
assert.equal(command().enabled, false);

const reconnected = server('a');
setServers([reconnected, b]);
setTabs([ref(reconnected), ref(b)]);
setCurrent(ref(reconnected));
assert.equal(a.listeners(), 0, 'Reconnect must unsubscribe the old data store');
assert.equal(reconnected.listeners(), 6, 'Reconnect must subscribe the new data store once');
a.emit('session.compaction.ended');
reconnected.emit('session.step.ended');
assert.equal(toasts.length, 4, 'Events from the old data store must not reset tips');
reconnected.emit('session.compaction.ended');
reconnected.emit('session.step.ended');
assert.equal(toasts.length, 5, 'Events from the new data store must reach the coach');

const missed = { input: 1000, output: 0, reasoning: 0, cache: { read: 0, write: 100_000 } };
reconnected.emit('session.step.failed', { assistantMessageID: 'failed' });
for (let index = 1; index <= 5; index += 1)
  reconnected.emit('session.step.ended', { assistantMessageID: `miss-${index}`, tokens: missed });
assert.equal(toasts.length, 5, 'A short cache-miss incident must stay silent');
assert.equal(notified.length, 0, 'A short cache-miss incident must not notify');
for (let index = 6; index <= 8; index += 1)
  reconnected.emit('session.step.ended', { assistantMessageID: `miss-${index}`, tokens: missed });
assert.equal(toasts.length, 6, 'Persistent cache misses must show one warning');
assert.equal(toasts.at(-1)?.title, 'Cache reuse still low');
assert.equal(notified.length, 1, 'A cache health warning must also send one system notification');
assert.match(
  notified[0].id,
  /^cache-coach:a:shared:cache-health:provider\/one:\d+$/,
  'The notification must be keyed by the incident',
);

setServers([reconnected]);
assert.equal(b.listeners(), 0, 'Removing a server must unsubscribe its data store');
if (stop) await stop();
dispose();
assert.equal(reconnected.listeners(), 0, 'Unloading must remove all subscriptions');
assert.equal(intervals.size, 0, 'Unloading must stop the clock');
