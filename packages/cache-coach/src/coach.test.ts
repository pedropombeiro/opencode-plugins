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
const free = {
  providerID: 'local',
  id: 'free',
  modelID: 'free',
  name: 'Free',
  cost: [],
  limit: { context: 1_000_000 },
};
const duo = {
  ...opus,
  id: 'duo-chat-sonnet-5-5',
  modelID: 'duo-chat-sonnet-5-5',
  providerID: 'gitlab',
};
const tokens = (read: number, write = 0) => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read, write },
});

function harness(
  options: { settings?: Partial<Settings>; parentID?: string; config?: unknown[] } = {},
) {
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
      model: { list: () => [opus, cheap, free, duo], sync: async () => {} },
      provider: { list: () => [], sync: async () => {} },
    },
  } as unknown as CoachData;
  const coach = createCoach({
    data,
    client: () => ({ config: { get: async () => options.config ?? [] } }) as never,
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
  test('meters Duo calls without cache data and gates tool-loop advice by user turn', () => {
    const { coach, messages } = harness();
    const seen = new Set<string>();
    const gate = createTipGate({
      has: (key) => seen.has(key),
      add: (key) => seen.add(key),
      remove: (key) => seen.delete(key),
    });
    for (const turn of ['first', 'second']) {
      messages.push({ type: 'user', id: turn, time: { created: 0 } });
      expect(coach.view('one', 0).indicator).toBeUndefined();
      for (let i = 1; i <= 10; i++) {
        const id = `${turn}-${i}`;
        const finish = i === 8 ? 'stop' : 'tool-calls';
        const usage = { ...tokens(0), input: 50 };
        messages.push({
          type: 'assistant',
          model: duo,
          id,
          finish,
          tokens: usage,
          time: { created: i, completed: i + 1 },
        });
        const tips =
          coach.stepEnded({ sessionID: 'one', assistantMessageID: id, tokens: usage, finish }, true)
            ?.tips ?? [];
        expect(tips.filter((tip) => gate.take('one', tip))).toHaveLength(i === 9 ? 1 : 0);
        if (i === 8)
          expect(coach.view('one', i).indicator?.text).toBe('Duo this turn: 8 calls · ~2.5 cr');
      }
    }
  });
  test('keeps Duo cache diagnostics separate from call-based billing', () => {
    const { coach, messages } = harness({ settings: { contextCeiling: 100_000 } });
    const event = { sessionID: 'one', assistantMessageID: 'a', tokens: tokens(100_000) };
    messages.push({
      type: 'assistant',
      id: 'a',
      model: duo,
      tokens: event.tokens,
      time: { created: 0, completed: 1000 },
    });
    const result = coach.stepEnded(event, true, 0);
    expect(result?.notice).toBeUndefined();
    expect(result?.tips[0]?.message).toBe("This session's context is at ~100K of 100K tokens.");
    expect(coach.switchTip('one', cheap, MINUTE)).toBeUndefined();
    const lines = coach.describe('one', MINUTE);
    expect(lines).toContain('duo-chat-sonnet-5-5: 1 observed call · ~0.31 GitLab Credits');
    expect(lines.join(' ')).not.toContain('$');
    expect(lines.join(' ')).toContain('100% read from the cache');
  });

  test('estimates each Duo step at its prompt tier, including steps without cache reads', () => {
    const { coach, messages } = harness();
    const call = {
      type: 'assistant',
      model: { ...duo, id: 'duo-chat-gpt-6-2-sol' },
      time: { created: 0, completed: 1 },
    };
    messages.push(
      { ...call, tokens: { ...tokens(0), input: 272_000, output: 10 } },
      { ...call, tokens: { ...tokens(0), input: 272_001 } },
      { ...call, finish: 'error' },
      { ...call, time: { created: 2 } },
      { ...call, model: { ...duo, id: 'duo-chat-unknown' } },
    );
    const lines = coach.describe('one', MINUTE);
    expect(lines).toContain('duo-chat-gpt-6-2-sol: 2 observed calls · ~1 GitLab Credits');
    expect(lines).toContain('duo-chat-unknown: 1 observed call');
  });
  test('estimates remaining room from the effective config even without cached tokens', async () => {
    const config = [
      { type: 'document', info: { compaction: { auto: false, buffer: '20%' } } },
      { type: 'document', info: { compaction: { auto: true } } },
    ];
    const { coach } = harness({ config });
    const event = {
      sessionID: 'one',
      assistantMessageID: 'a',
      tokens: { ...tokens(0), input: 780_000 },
    };
    coach.prepare('one');
    await Promise.resolve();
    expect(coach.stepEnded(event, true)?.tips).toMatchObject([
      { key: 'automatic-compaction', message: expect.stringContaining('About 20K tokens') },
    ]);
    expect(coach.stepEnded(event, false)?.tips ?? []).toEqual([]);
    config.pop();
    coach.configUpdated();
    coach.prepare('one');
    await Promise.resolve();
    expect(coach.stepEnded(event, true)?.tips ?? []).toEqual([]);
  });
  test('reports a warm cache until the lifetime ends', () => {
    const { coach, step } = harness();
    step('a', 0, 100_000);
    const warm = coach.view('one', 2 * MINUTE);
    expect(warm.state).toMatchObject({ kind: 'warm', remaining: 3 * MINUTE });
    expect(warm.next.cost).toBeCloseTo(0.05);
    expect(coach.view('one', 6 * MINUTE).state).toMatchObject({ kind: 'cold', reason: 'expired' });
  });

  test('uses the lifetime of the matching ttl key, or falls back to the default', () => {
    const matched = harness({ settings: { ttl: [{ pattern: 'anthropic/*', ttl: 30 * MINUTE }] } });
    matched.step('a', 0, 100_000);
    expect(matched.coach.view('one', 20 * MINUTE).state).toMatchObject({
      kind: 'warm',
      remaining: 10 * MINUTE,
    });
    const other = harness({ settings: { ttl: [{ pattern: 'gitlab/*', ttl: 30 * MINUTE }] } });
    other.step('a', 0, 100_000);
    expect(other.coach.view('one', 6 * MINUTE).state).toMatchObject({ kind: 'cold' });
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

describe('cache health', () => {
  const usage = (read: number, write: number, input = 1000) => ({
    input,
    output: 2000,
    reasoning: 0,
    cache: { read, write },
  });

  function run(
    options: Parameters<typeof harness>[0] & {
      model?: { providerID: string; id: string; variant?: string };
      agent?: string;
      from?: number;
    } = {},
  ) {
    const { coach, messages } = harness(options);
    let count = options.from ?? 0;
    const send = (
      value: ReturnType<typeof usage>,
      visible = true,
      model = options.model ?? { providerID: 'anthropic', id: 'opus' },
    ) => {
      count += 1;
      const id = `m${count}`;
      const at = count * 30_000;
      messages.push({
        type: 'assistant',
        id,
        model,
        ...(options.agent ? { agent: options.agent } : {}),
        tokens: value,
        time: { created: at, completed: at + 1000 },
        content: [],
      });
      return coach.stepEnded(
        { sessionID: 'one', assistantMessageID: id, tokens: value },
        visible,
        at,
      );
    };
    const keys = (result: ReturnType<typeof send>) => (result?.tips ?? []).map((tip) => tip.key);
    return { coach, messages, send, keys };
  }

  const cold = usage(0, 100_000);
  const warm = usage(95_000, 3000, 2000);

  const repeat = (times: number, send: () => unknown) => {
    for (let index = 0; index < times; index += 1) send();
  };

  test('stays silent on detection and warns once when misses persist', () => {
    const { send, keys } = run();
    for (let index = 0; index < 7; index += 1) expect(keys(send(cold))).toEqual([]);
    const result = send(cold);
    expect(result?.notice).toMatchObject({ stepID: 'm8' });
    expect(result?.tips).toEqual([
      expect.objectContaining({
        key: 'cache-health:anthropic/opus:150000',
        title: 'Cache reuse still low',
        attention: true,
      }),
    ]);
    expect(result?.tips[0].message).toContain('for Claude Opus: 0% of 404K input tokens');
    expect(result?.tips[0].message).toContain('Over 7 requests, an estimated ~707K tokens');
    expect(result?.tips[0].message).toContain('(~$4.06 extra)');
    for (let index = 0; index < 4; index += 1) expect(keys(send(cold))).toEqual([]);
  });

  test('stays silent through a short incident', () => {
    const { send, keys } = run();
    for (let index = 0; index < 5; index += 1) expect(keys(send(cold))).toEqual([]);
    for (let index = 0; index < 4; index += 1) expect(keys(send(warm))).toEqual([]);
  });

  test('holds a warning for a hidden session until it is visible', () => {
    const { send, keys } = run();
    for (let index = 0; index < 8; index += 1) expect(keys(send(cold, false))).toEqual([]);
    expect(keys(send(cold))).toEqual(['cache-health:anthropic/opus:150000']);
  });

  test('drops a hidden warning that recovered before it was shown', () => {
    const { send, keys } = run();
    repeat(8, () => send(cold, false));
    repeat(3, () => send(warm, false));
    expect(keys(send(warm))).toEqual([]);
  });

  test('reports the recovery of a persistent incident once', () => {
    const { send, keys } = run();
    repeat(8, () => send(cold));
    expect(keys(send(warm))).toEqual([]);
    expect(keys(send(warm))).toEqual(['cache-health-recovered:anthropic/opus:150000']);
    expect(keys(send(warm))).toEqual([]);
  });

  test('keeps working with tips off and stops with health off', () => {
    const quiet = run({ settings: { tips: false } });
    repeat(7, () => quiet.send(cold));
    expect(quiet.keys(quiet.send(cold))).toEqual(['cache-health:anthropic/opus:150000']);
    const off = run({ settings: { health: false } });
    for (let index = 0; index < 10; index += 1) expect(off.keys(off.send(cold))).toEqual([]);
  });

  test('skips subagent sessions', () => {
    const { send } = run({ parentID: 'root' });
    for (let index = 0; index < 10; index += 1) expect(send(cold)).toBeUndefined();
  });

  test('detects misses on models without prices when the provider reports cache use', () => {
    const { send, keys } = run({ model: free });
    repeat(7, () => send(cold));
    const result = send(cold);
    expect(keys(result)).toEqual(['cache-health:local/free:150000']);
    expect(result?.tips[0].message).toContain('for Free:');
    expect(result?.tips[0].message).not.toContain('extra');
  });

  test('records incidents assumed from cache prices without warning about them', () => {
    const { coach, send } = run();
    for (let index = 0; index < 12; index += 1) expect(send(usage(0, 0, 100_000))).toBeUndefined();
    expect(coach.describe('one', 400_000).at(-1)).toContain('They may not be real misses');
  });

  test('drops a hidden warning when compaction ends its incident', () => {
    const { coach, send, keys } = run();
    repeat(8, () => send(cold, false));
    coach.compacted('one');
    expect(keys(send(warm))).toEqual([]);
  });

  test('warns about a new incident after the coach is recreated', () => {
    const shown = new Set<string>();
    const gate = createTipGate({
      has: (key) => shown.has(key),
      add: (key) => shown.add(key),
      remove: (key) => shown.delete(key),
    });
    const delivered = (from: number) => {
      const { send } = run({ from });
      const titles: string[] = [];
      for (let index = 0; index < 8; index += 1)
        for (const tip of send(cold)?.tips ?? []) if (gate.take('one', tip)) titles.push(tip.title);
      return titles;
    };
    expect(delivered(0)).toEqual(['Cache reuse still low']);
    expect(delivered(100)).toEqual(['Cache reuse still low']);
  });

  test('stays quiet without cache telemetry or cache prices', () => {
    const { send } = run({ model: free });
    for (let index = 0; index < 10; index += 1) expect(send(usage(0, 0, 100_000))).toBeUndefined();
  });

  test('resets after compaction', () => {
    const { coach, send, keys } = run();
    repeat(7, () => send(cold));
    coach.compacted('one');
    for (let index = 0; index < 7; index += 1) expect(keys(send(cold))).toEqual([]);
  });

  test('keeps the session incidents in the details after compaction', () => {
    const { coach, messages, send } = run();
    repeat(5, () => send(cold));
    messages.push({ type: 'compaction', id: 'c', status: 'completed', time: { created: 200_000 } });
    coach.compacted('one');
    const lines = coach.describe('one', 210_000).join('\n');
    expect(lines).toContain('Cache misses this session: 1 incident.');
    expect(lines).toContain('Last incident on anthropic/opus: 4 requests, ended.');
    expect(lines).not.toContain('Cache health:');
  });

  test('ignores failed steps', () => {
    const { coach, send, keys } = run();
    repeat(7, () => send(cold));
    coach.stepFailed({ sessionID: 'one', assistantMessageID: 'm8' });
    expect(keys(send(cold))).toEqual([]);
    expect(keys(send(cold))).toEqual(['cache-health:anthropic/opus:150000']);
  });

  test('keys incidents by model variant and agent', () => {
    const { coach, send, keys } = run({
      model: { providerID: 'anthropic', id: 'opus', variant: 'high' },
      agent: 'build',
    });
    repeat(7, () => send(cold));
    expect(keys(send(cold))).toEqual(['cache-health:anthropic/opus#high@build:150000']);
    expect(coach.describe('one', 250_000).join('\n')).toContain(
      'Cache health: reuse unexpectedly low',
    );
  });

  test('adds the health status and session incidents to the details', () => {
    const { coach, send } = run();
    send(cold);
    expect(coach.describe('one', 40_000).at(-1)).toBe(
      'Cache health: waiting for more requests on this model',
    );
    repeat(4, () => send(warm));
    expect(coach.describe('one', 160_000).at(-1)).toBe(
      'Cache health: 95% of 400K input tokens read from the cache across the last 4 requests',
    );
    repeat(4, () => send(cold));
    repeat(3, () => send(warm));
    expect(coach.describe('one', 400_000).slice(-2)).toEqual([
      "Cache misses this session: 1 incident. In total, an estimated ~418K tokens from earlier prompts weren't read from the cache (~$2.39 extra).",
      'Last incident on anthropic/opus: 7 requests, ended. In most of the missed requests, little or nothing was read from the cache.',
    ]);
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
