import { describe, expect, test } from 'bun:test';
import {
  createCoach,
  createNotices,
  createSwitchWatcher,
  createTipGate,
  type CoachData,
  type Notice,
} from './coach';
import { DEFAULTS, type Settings } from './options';

const MINUTE = 60_000;
const opus = {
  providerID: 'anthropic',
  id: 'opus',
  modelID: 'opus',
  name: 'Claude Opus',
  cost: [{ input: 5, output: 25, cache: { read: 0.5, write: 6.25 } }],
  limit: { context: 1_000_000 },
};
const cheap = {
  providerID: 'openai',
  id: 'cheap',
  modelID: 'cheap',
  name: 'Cheap',
  cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 1 } }],
  limit: { context: 1_000_000 },
};
const tokens = (read: number, write = 0) => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read, write },
});

function harness(options: { settings?: Partial<Settings>; parentID?: string } = {}) {
  const messages: unknown[] = [];
  const state = {
    status: 'idle',
    selected: undefined as { providerID: string; id: string } | undefined,
  };
  const data = {
    session: {
      get: () => ({
        id: 'one',
        location: { directory: '/repo' },
        model: { providerID: 'anthropic', id: 'opus' },
        ...(options.parentID ? { parentID: options.parentID } : {}),
      }),
      status: () => state.status,
      cost: () => 1.5,
      message: {
        list: () => messages,
        get: (_: string, id: string) =>
          messages.find((message) => (message as { id: string }).id === id),
      },
    },
    location: {
      model: { list: () => [opus, cheap], sync: async () => {} },
      provider: { list: () => [], sync: async () => {} },
    },
  } as unknown as CoachData;
  const coach = createCoach({
    data,
    client: () => ({ config: { get: async () => [] } }) as never,
    settings: { ...DEFAULTS, ...options.settings },
    selectedModel: () => state.selected,
    startedAt: () => undefined,
  });
  const step = (id: string, at: number, read: number, write = 0) =>
    messages.push({
      type: 'assistant',
      id,
      model: { providerID: 'anthropic', id: 'opus' },
      tokens: tokens(read, write),
      time: { created: at, completed: at + 1000 },
      content: [],
    });
  return { coach, messages, state, step };
}

describe('createCoach', () => {
  test('reports a warm cache until the lifetime ends', () => {
    const { coach, step } = harness();
    step('a', 0, 100_000);
    const warm = coach.view('one', 2 * MINUTE);
    expect(warm.state).toMatchObject({ kind: 'warm', remaining: 3 * MINUTE });
    expect(warm.next.cost).toBeCloseTo(0.05);
    expect(coach.view('one', 6 * MINUTE).state).toMatchObject({ kind: 'cold', reason: 'expired' });
  });

  test('offers a cheaper compaction model once the cache is cold', () => {
    const { coach, step } = harness({
      settings: { compactionModels: [{ providerID: 'openai', id: 'cheap' }] },
    });
    step('a', 0, 100_000);
    expect(coach.view('one', 10 * MINUTE).alternative).toMatchObject({ name: 'Cheap', cost: 0.1 });
  });

  test('describes the cache with the session cost', () => {
    const { coach, step } = harness();
    step('a', 0, 100_000);
    expect(coach.describe('one', MINUTE)).toContain('Session cost so far: $1.50');
  });

  test('schedules an expiry notice and tips only for visible sessions', () => {
    const { coach, step } = harness({ settings: { contextCeiling: 100_000 } });
    step('a', 0, 100_000);
    const event = { sessionID: 'one', assistantMessageID: 'a', tokens: tokens(100_000) };
    const hidden = coach.stepEnded(event, false, 0);
    expect(hidden?.notice).toMatchObject({ stepID: 'a', at: 4 * MINUTE, expires: 5 * MINUTE });
    expect(hidden?.tips).toEqual([]);
    expect(coach.stepEnded(event, true, 0)?.tips.map((tip) => tip.key)).toEqual(['context-limit']);
  });

  test('skips subagent sessions', () => {
    const { coach, step } = harness({ parentID: 'root' });
    step('a', 0, 100_000);
    expect(
      coach.stepEnded({ sessionID: 'one', assistantMessageID: 'a', tokens: tokens(100_000) }, true),
    ).toBeUndefined();
  });

  test('keeps tips off when tips are disabled', () => {
    const { coach, step } = harness({ settings: { tips: false, contextCeiling: 100_000 } });
    step('a', 0, 100_000);
    const event = { sessionID: 'one', assistantMessageID: 'a', tokens: tokens(100_000) };
    expect(coach.stepEnded(event, true, 0)?.tips).toEqual([]);
    expect(coach.switchTip('one', { providerID: 'openai', id: 'cheap' }, 0)).toBeUndefined();
  });

  test('warns about a model switch on a warm cache', () => {
    const { coach, step } = harness();
    step('a', 0, 200_000);
    expect(coach.switchTip('one', { providerID: 'openai', id: 'cheap' }, MINUTE)).toMatchObject({
      key: 'model-switch:a',
    });
  });

  test('flags large tool output', () => {
    const { coach, messages } = harness();
    messages.push({
      type: 'assistant',
      id: 'a',
      model: { providerID: 'anthropic', id: 'opus' },
      time: { created: 0 },
      content: [{ type: 'tool', id: 't', name: 'bash' }],
    });
    const tip = coach.toolOutput({
      sessionID: 'one',
      assistantMessageID: 'a',
      id: 't',
      content: [{ type: 'text', text: 'x'.repeat(100_000) }],
    });
    expect(tip).toMatchObject({ key: 'large-output:bash' });
  });
});

describe('createNotices', () => {
  const notice = (at: number): Notice => ({
    sessionID: 'one',
    stepID: 'a',
    at,
    expires: at + MINUTE,
    description: 'expires',
  });

  test('delivers a notice once it is due', () => {
    const delivered: Notice[] = [];
    const notices = createNotices({
      deliver: (value) => delivered.push(value),
      running: () => false,
    });
    notices.set('one', notice(10));
    notices.check(5);
    expect(delivered).toEqual([]);
    notices.check(10);
    notices.check(11);
    expect(delivered).toHaveLength(1);
    expect(notices.get('one')).toBeUndefined();
  });

  test('drops notices for running sessions and expired caches', () => {
    const delivered: Notice[] = [];
    let running = true;
    const notices = createNotices({
      deliver: (value) => delivered.push(value),
      running: () => running,
    });
    notices.set('one', notice(10));
    notices.check(10);
    running = false;
    notices.set('one', notice(10));
    notices.check(10 + MINUTE);
    expect(delivered).toEqual([]);
  });

  test('clears a pending notice', () => {
    const delivered: Notice[] = [];
    const notices = createNotices({
      deliver: (value) => delivered.push(value),
      running: () => false,
    });
    notices.set('one', notice(10));
    notices.set('one', undefined);
    notices.check(10);
    expect(delivered).toEqual([]);
  });
});

test('createSwitchWatcher reports switches within one session', () => {
  const switches: string[] = [];
  const watch = createSwitchWatcher((sessionID, selected) =>
    switches.push(`${sessionID}:${selected.id}`),
  );
  watch('one', { providerID: 'a', modelID: 'x' });
  watch('one', { providerID: 'a', modelID: 'x' });
  watch('two', { providerID: 'a', modelID: 'y' });
  watch('two', { providerID: 'a', modelID: 'z' });
  watch(undefined, undefined);
  watch('two', { providerID: 'a', modelID: 'x' });
  expect(switches).toEqual(['two:z']);
});

test('createTipGate shows each tip once per session until compaction', () => {
  const keys = new Set<string>();
  const gate = createTipGate({
    has: (key) => keys.has(key),
    add: (key) => keys.add(key),
    remove: (key) => keys.delete(key),
  });
  const tip = { key: 'context-limit', title: 'Tip', message: 'Compact', variant: 'info' as const };
  expect(gate.take('one', tip)).toBe(tip);
  expect(gate.take('one', tip)).toBeUndefined();
  expect(gate.take('two', tip)).toBe(tip);
  gate.compacted('one');
  expect(gate.take('one', tip)).toBe(tip);
  expect(gate.take('one', undefined)).toBeUndefined();
});
