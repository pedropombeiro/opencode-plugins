import { describe, expect, test } from 'bun:test';
import {
  aboutUsd,
  cacheState,
  contextCeiling,
  contextTokens,
  details,
  formatRemaining,
  formatTokens,
  formatUsd,
  indicator,
  lastStep,
  nextCost,
  parseTtl,
  priceFor,
  type Cost,
  type Step,
  type Tokens,
} from './cache';

const opus = { providerID: 'anthropic', id: 'claude-opus-5-5' };
const sonnet = { providerID: 'anthropic', id: 'claude-sonnet-5-5' };

const tokens = (read: number, write: number, input = 0, output = 0): Tokens => ({
  input,
  output,
  reasoning: 0,
  cache: { read, write },
});

const assistant = (id: string, value: Tokens, created = 1000) => ({
  type: 'assistant',
  id,
  model: opus,
  tokens: value,
  time: { created },
});

const step = (value: Tokens, started = 0): Step => ({
  id: 'a',
  model: opus,
  started,
  tokens: value,
});

describe('lastStep', () => {
  test('returns the newest assistant message with usage', () => {
    const messages = [
      assistant('a1', tokens(10, 5)),
      { type: 'user', id: 'u1', time: { created: 2000 } },
      assistant('a2', tokens(20, 5), 3000),
      { type: 'assistant', id: 'a3', model: opus, time: { created: 4000 } },
    ];
    expect(lastStep(messages)?.id).toBe('a2');
  });

  test('prefers the locally observed start time', () => {
    const messages = [assistant('a1', tokens(10, 5), 1000)];
    expect(lastStep(messages, (id) => (id === 'a1' ? 5000 : undefined))?.started).toBe(5000);
  });

  test('stops at a completed compaction', () => {
    const messages = [
      assistant('a1', tokens(10, 5)),
      { type: 'compaction', id: 'c1', status: 'completed', time: { created: 2000 } },
    ];
    expect(lastStep(messages)).toBeUndefined();
  });

  test('records when the step ended and skips the given step', () => {
    const messages = [
      { ...assistant('a1', tokens(10, 5), 1000), time: { created: 1000, completed: 1500 } },
      assistant('a2', tokens(20, 5), 3000),
    ];
    expect(lastStep(messages, undefined, 'a2')).toMatchObject({ id: 'a1', ended: 1500 });
  });

  test('skips steps without tokens', () => {
    const messages = [assistant('a1', tokens(10, 5)), assistant('a2', tokens(0, 0))];
    expect(lastStep(messages)?.id).toBe('a1');
  });
});

describe('priceFor', () => {
  const haiku: Cost[] = [
    { input: 0.1, output: 0.5, cache: { read: 0.01, write: 0.125 } },
    {
      tier: { type: 'context', size: 100_000 },
      input: 0.5,
      output: 2.5,
      cache: { read: 0.05, write: 0.625 },
    },
  ];

  test('uses the base price up to the tier size', () => {
    expect(priceFor(haiku, 100_000)?.write).toBe(0.125);
  });

  test('uses the tier price above its size', () => {
    expect(priceFor(haiku, 250_000)?.write).toBe(0.625);
  });

  test('falls back to the input price without cache prices', () => {
    expect(priceFor([{ input: 2, output: 8, cache: { read: 0, write: 0 } }], 10)).toEqual({
      input: 2,
      output: 8,
      read: 2,
      write: 2,
    });
  });

  test('returns nothing for free or unpriced models', () => {
    expect(priceFor([], 10)).toBeUndefined();
    expect(priceFor([{ input: 0, output: 0, cache: { read: 0, write: 0 } }], 10)).toBeUndefined();
  });
});

describe('contextCeiling', () => {
  const tiered: Cost[] = [
    { input: 0.1, output: 0.5, cache: { read: 0.01, write: 0.125 } },
    {
      tier: { type: 'context', size: 100_000 },
      input: 0.5,
      output: 2.5,
      cache: { read: 0.05, write: 0.625 },
    },
  ];
  const flat: Cost[] = [{ input: 4, output: 20, cache: { read: 0.2, write: 5 } }];

  test('defaults to 250K', () => {
    expect(contextCeiling({ costs: flat, modelLimit: 1_000_000 })).toEqual({
      tokens: 250_000,
      reason: 'limit',
    });
  });

  test('defaults to where the higher price starts', () => {
    expect(contextCeiling({ costs: tiered, modelLimit: 1_000_000 })).toEqual({
      tokens: 100_000,
      reason: 'price',
    });
  });

  test('uses the lowest of several price tiers', () => {
    const costs: Cost[] = [...tiered, { tier: { type: 'context', size: 50_000 }, ...flat[0] }];
    expect(contextCeiling({ costs }).tokens).toBe(50_000);
  });

  test('prefers the configured ceiling', () => {
    expect(contextCeiling({ configured: 180_000, costs: tiered })).toEqual({
      tokens: 180_000,
      reason: 'limit',
    });
  });

  test('caps at the model limit', () => {
    expect(contextCeiling({ costs: flat, modelLimit: 128_000 }).tokens).toBe(128_000);
    expect(contextCeiling({ configured: 300_000, modelLimit: 200_000 }).tokens).toBe(200_000);
    expect(contextCeiling({ costs: tiered, modelLimit: 64_000 })).toEqual({
      tokens: 64_000,
      reason: 'limit',
    });
  });
});

test('parseTtl', () => {
  expect(parseTtl('5m')).toBe(300_000);
  expect(parseTtl('1h')).toBe(3_600_000);
  expect(parseTtl('90s')).toBe(90_000);
  expect(parseTtl('0m')).toBeUndefined();
  expect(parseTtl('soon')).toBeUndefined();
  expect(parseTtl(5)).toBeUndefined();
});

describe('cacheState', () => {
  const base = { now: 60_000, ttl: 300_000, running: false };

  test('is unknown without cache tokens', () => {
    expect(cacheState({ ...base, step: step(tokens(0, 0, 100)) }).kind).toBe('unknown');
    expect(cacheState({ ...base }).kind).toBe('unknown');
  });

  test('is warm within the lifetime', () => {
    expect(cacheState({ ...base, step: step(tokens(10, 5)) })).toMatchObject({
      kind: 'warm',
      remaining: 240_000,
    });
  });

  test('is cold after the lifetime', () => {
    expect(cacheState({ ...base, now: 300_001, step: step(tokens(10, 5)) })).toMatchObject({
      kind: 'cold',
      reason: 'expired',
    });
  });

  test('is cold when another model is selected', () => {
    expect(cacheState({ ...base, selected: sonnet, step: step(tokens(10, 5)) })).toMatchObject({
      kind: 'cold',
      reason: 'model',
    });
  });

  test('flags warming without counting on it', () => {
    const warming = { interval: 240_000, duration: 1_800_000 };
    const value = { ...step(tokens(10, 5)), ended: 2000 };
    expect(cacheState({ ...base, now: 100_000, step: value, warming })).toMatchObject({
      kind: 'warm',
      warming: true,
      remaining: 300_000 - 100_000,
    });
    expect(cacheState({ ...base, now: 600_000, step: value, warming }).kind).toBe('cold');
  });

  test('is running while a request runs', () => {
    expect(cacheState({ ...base, running: true, step: step(tokens(10, 5)) }).kind).toBe('running');
  });
});

test('contextTokens adds the reply to the prompt', () => {
  expect(contextTokens(tokens(200, 40, 10, 5))).toBe(255);
});

test('formatting', () => {
  expect(formatTokens(950)).toBe('950');
  expect(formatTokens(250_400)).toBe('250K');
  expect(formatTokens(1_250_000)).toBe('1.3M');
  expect(formatUsd(0.004)).toBe('<$0.01');
  expect(formatUsd(0.625)).toBe('$0.63');
  expect(aboutUsd(0.004)).toBe('under $0.01');
  expect(aboutUsd(0.625)).toBe('~$0.63');
  expect(formatRemaining(222_000)).toBe('3:42');
  expect(formatRemaining(-1)).toBe('0:00');
});

describe('indicator', () => {
  const value = step(tokens(240_000, 10_000));

  test('shows the time left while warm', () => {
    expect(indicator({ kind: 'warm', step: value, remaining: 222_000, warming: false })).toEqual({
      text: '● cache 3:42',
      tone: 'success',
    });
  });

  test('warns in the last minute', () => {
    expect(indicator({ kind: 'warm', step: value, remaining: 45_000, warming: false })).toEqual({
      text: '◐ cache 0:45',
      tone: 'warning',
    });
  });

  test('shows the rewrite cost when cold', () => {
    expect(
      indicator({ kind: 'cold', step: value, reason: 'expired' }, { tokens: 250_000, cost: 1.25 }),
    ).toEqual({ text: '○ cache cold · rewrite ~250K ($1.25)', tone: 'warning' });
  });

  test('names a cheaper compaction model while cold', () => {
    expect(
      indicator(
        { kind: 'cold', step: value, reason: 'expired' },
        { tokens: 225_000, cost: 1.125 },
        { name: 'Agentic Chat (GPT-6.1 Sol)', cost: 0.5625 },
      ),
    ).toEqual({
      text: '○ cache cold · rewrite ~225K ($1.13) · GPT-6.1 Sol $0.56',
      tone: 'warning',
    });
  });

  test('marks a countdown in a warmed session as unverified', () => {
    expect(indicator({ kind: 'warm', step: value, remaining: 1_444_000, warming: true })).toEqual({
      text: '● cache 24:04 · warming?',
      tone: 'success',
    });
  });

  test('hides without cache data', () => {
    expect(indicator({ kind: 'unknown' })).toBeUndefined();
  });
});

test('nextCost reads while warm and writes while cold', () => {
  const price = { input: 4, output: 20, read: 0.2, write: 5 };
  const value = step(tokens(240_000, 10_000));
  expect(
    nextCost({ kind: 'warm', step: value, remaining: 1, warming: false }, 250_000, price).cost,
  ).toBe(0.05);
  expect(nextCost({ kind: 'cold', step: value, reason: 'expired' }, 250_000, price).cost).toBe(
    1.25,
  );
  expect(
    nextCost({ kind: 'warm', step: value, remaining: 1, warming: false }, 250_000).cost,
  ).toBeUndefined();
});

test('details describe the last request and the next one', () => {
  const lines = details({
    state: {
      kind: 'warm',
      step: step(tokens(190_000, 10_000, 0, 2000)),
      remaining: 222_000,
      warming: false,
    },
    ttl: 300_000,
    next: { tokens: 202_000, cost: 0.04 },
    stepModel: 'Claude Opus 5.5',
    sessionCost: 3.21,
  });
  expect(lines).toEqual([
    'Cache: warm, about 3:42 left',
    'Cache lifetime: 5m after each request',
    'Warming: off',
    '',
    'Last request on Claude Opus 5.5: 200K prompt tokens, 95% read from the cache',
    'Read 190K · written 10K · uncached 0 · output 2K',
    'Next message: reads ~202K tokens from the cache (~$0.04)',
    'Session cost so far: $3.21',
  ]);
});
