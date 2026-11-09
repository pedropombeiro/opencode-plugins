import { expect, test } from 'bun:test';
import { DEFAULTS, parseOptions } from './options';

test('uses defaults without options', () => {
  expect(parseOptions(undefined)).toEqual({
    ...DEFAULTS,
    ttl: undefined,
    contextCeiling: undefined,
  });
});

test('reads valid options', () => {
  expect(
    parseOptions({
      tips: false,
      notices: false,
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
    compactionModels: [
      { providerID: 'gitlab', id: 'duo-chat-gpt-6-1-sol' },
      { providerID: 'anthropic', id: 'claude-sonnet-5-5' },
    ],
    ttl: 3_600_000,
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
    parseOptions({ tips: 'no', ttl: 'later', contextCeiling: -1, contextRatio: 2, minCost: 'x' }),
  ).toEqual({ ...DEFAULTS, ttl: undefined, contextCeiling: undefined });
});
