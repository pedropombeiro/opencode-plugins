import { describe, expect, test } from 'bun:test';
import { DEFAULTS, parseOptions, ttlForModel } from './options';

const MINUTE = 60_000;

test('uses defaults without options', () => {
  expect(parseOptions(undefined)).toEqual({ ...DEFAULTS, contextCeiling: undefined });
});

test('reads valid options', () => {
  expect(
    parseOptions({
      tips: false,
      notices: false,
      health: false,
      compactionModel: ['gitlab/duo-chat-gpt-6-1-sol', 'anthropic/claude-sonnet-5-5'],
      ttl: '1h',
      contextCeiling: 180_000,
      contextRatio: 0.9,
      minTokens: 20_000,
      minCost: 0.05,
      largeOutput: 10_000,
    }),
  ).toEqual({
    tips: false,
    notices: false,
    health: false,
    compactionModels: [
      { providerID: 'gitlab', id: 'duo-chat-gpt-6-1-sol' },
      { providerID: 'anthropic', id: 'claude-sonnet-5-5' },
    ],
    ttl: [{ pattern: '*', ttl: 3_600_000 }],
    contextCeiling: 180_000,
    contextRatio: 0.9,
    minTokens: 20_000,
    minCost: 0.05,
    largeOutput: 10_000,
  });
});

test('reads a single compaction model and skips invalid ones', () => {
  expect(parseOptions({ compactionModel: 'gitlab/duo-chat-gpt-6-1-sol' }).compactionModels).toEqual(
    [{ providerID: 'gitlab', id: 'duo-chat-gpt-6-1-sol' }],
  );
  expect(parseOptions({ compactionModel: ['sol', '/x', 'gitlab/', 4] }).compactionModels).toEqual(
    [],
  );
});

test('ignores invalid options', () => {
  expect(
    parseOptions({
      tips: 'no',
      health: 'no',
      ttl: 'later',
      contextCeiling: -1,
      contextRatio: 2,
      minCost: 'x',
    }),
  ).toEqual({ ...DEFAULTS, contextCeiling: undefined });
});

test('reads per-model lifetimes and drops invalid entries', () => {
  expect(
    parseOptions({
      ttl: { 'gitlab/*-sol': '30m', 'anthropic/*': '1h', 'openai/x': 'later', 'a/b': 5, '': '1m' },
    }).ttl,
  ).toEqual([
    { pattern: 'gitlab/*-sol', ttl: 30 * MINUTE },
    { pattern: 'anthropic/*', ttl: 60 * MINUTE },
  ]);
  expect(parseOptions({ ttl: ['1h'] }).ttl).toEqual([]);
  expect(parseOptions({ ttl: 5 }).ttl).toEqual([]);
});

describe('ttlForModel', () => {
  const ref = (providerID: string, id: string) => ({ providerID, id });
  const rules = parseOptions({
    ttl: {
      '*': '10m',
      'gitlab/*': '15m',
      'gitlab/*-sol': '30m',
      'gitlab/duo-*': '20m',
      'gitlab/duo-chat-gpt-6-1-sol': '45m',
      'openai/*mini': '2m',
      'openai/gpt-*': '3m',
    },
  }).ttl;

  test('prefers an exact key over any pattern', () => {
    expect(ttlForModel(rules, ref('gitlab', 'duo-chat-gpt-6-1-sol'))).toBe(45 * MINUTE);
  });

  test('picks the pattern with the most literal characters', () => {
    expect(ttlForModel(rules, ref('gitlab', 'duo-chat-gpt-6-astra'))).toBe(20 * MINUTE);
    expect(ttlForModel(rules, ref('gitlab', 'other-sol'))).toBe(30 * MINUTE);
    expect(ttlForModel(rules, ref('gitlab', 'other'))).toBe(15 * MINUTE);
    expect(ttlForModel(rules, ref('anthropic', 'opus'))).toBe(10 * MINUTE);
  });

  test('breaks ties in favor of the key listed first', () => {
    expect(ttlForModel(rules, ref('openai', 'gpt-mini'))).toBe(2 * MINUTE);
  });

  test('lets * match across slashes, case-sensitively', () => {
    const nested = parseOptions({ ttl: { 'a*z': '1m', 'openrouter/*/opus': '1h' } }).ttl;
    expect(ttlForModel(nested, ref('openrouter', 'anthropic/opus'))).toBe(60 * MINUTE);
    expect(ttlForModel(nested, ref('a', 'b/z'))).toBe(MINUTE);
    expect(ttlForModel(nested, ref('openrouter', 'anthropic/Opus'))).toBeUndefined();
  });

  test('treats other characters literally', () => {
    const dotted = parseOptions({ ttl: { 'a/gpt-6.1': '1m' } }).ttl;
    expect(ttlForModel(dotted, ref('a', 'gpt-6x1'))).toBeUndefined();
  });

  test('finds nothing without a matching key or model', () => {
    const only = parseOptions({ ttl: { 'gitlab/*': '1m' } }).ttl;
    expect(ttlForModel(only, ref('anthropic', 'opus'))).toBeUndefined();
    expect(ttlForModel(only, undefined)).toBeUndefined();
  });
});
