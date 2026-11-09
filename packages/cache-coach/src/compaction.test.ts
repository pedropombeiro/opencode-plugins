import { describe, expect, test } from 'bun:test';
import { compactionChoice, expiryNotice, formatClock } from './compaction';

const opus = { providerID: 'gitlab', id: 'duo-chat-opus-5-5' };
const opusPrice = { input: 4, output: 20, read: 0.2, write: 5 };
const sol = {
  ref: { providerID: 'gitlab', id: 'duo-chat-gpt-6-1-sol' },
  name: 'GPT-6.1 Sol',
  costs: [
    { input: 2, output: 10, cache: { read: 0.1, write: 2.5 } },
    {
      tier: { type: 'context' as const, size: 272_000 },
      input: 4,
      output: 15,
      cache: { read: 0.2, write: 5 },
    },
  ],
  limit: 922_000,
};
const haiku = {
  ref: { providerID: 'gitlab', id: 'duo-chat-haiku-5-5' },
  name: 'Haiku 5.5',
  costs: [{ input: 0.5, output: 2.5, cache: { read: 0.05, write: 0.625 } }],
  limit: 200_000,
};
const base = { current: opus, price: opusPrice, minCost: 0.1 };

describe('compactionChoice', () => {
  test('picks the first configured model that saves enough', () => {
    expect(compactionChoice({ ...base, candidates: [sol, haiku], tokens: 225_000 })).toEqual({
      ref: sol.ref,
      name: 'GPT-6.1 Sol',
      cost: 0.5625,
    });
  });

  test('skips a model whose higher price removes the saving', () => {
    expect(
      compactionChoice({ ...base, candidates: [sol, haiku], tokens: 300_000 }),
    ).toBeUndefined();
  });

  test('skips a model whose context limit is too small', () => {
    expect(compactionChoice({ ...base, candidates: [haiku], tokens: 250_000 })).toBeUndefined();
  });

  test('skips the current model and models without prices', () => {
    const current = { ref: opus, name: 'Opus 5.5', costs: [] };
    expect(
      compactionChoice({
        ...base,
        candidates: [current, { ...haiku, costs: [] }],
        tokens: 100_000,
      }),
    ).toBeUndefined();
  });

  test('needs the current price', () => {
    expect(
      compactionChoice({ ...base, price: undefined, candidates: [sol], tokens: 225_000 }),
    ).toBeUndefined();
  });
});

test('formatClock uses a 24-hour clock', () => {
  expect(formatClock(new Date(2026, 10, 9, 15, 4).getTime())).toBe('15:04');
  expect(formatClock(new Date(2026, 10, 9, 9, 30).getTime())).toBe('09:30');
});

describe('expiryNotice', () => {
  const notice = {
    time: '14:32',
    tokens: 225_000,
    from: { name: 'Opus 5.5', price: opusPrice },
    minTokens: 50_000,
    minCost: 0.1,
  };

  test('names the configured compaction model', () => {
    expect(
      expiryNotice({ ...notice, choice: { ref: sol.ref, name: 'GPT-6.1 Sol', cost: 0.5625 } }),
    ).toBe(
      'Prompt cache expires at 14:32. After that, the next message writes ~225K tokens to the cache again (~$1.13 on Opus 5.5). To compact, switch to GPT-6.1 Sol first (~$0.56), run /compact, then switch back.',
    );
  });

  test('stays general without a compaction model', () => {
    expect(expiryNotice(notice)).toEndWith('Compacting on a cheaper model costs less.');
  });

  test('stays quiet for small or cheap contexts', () => {
    expect(expiryNotice({ ...notice, tokens: 40_000 })).toBeUndefined();
    expect(
      expiryNotice({ ...notice, from: { name: 'Haiku', price: { ...opusPrice, write: 0.3 } } }),
    ).toBeUndefined();
  });

  test('leaves the cost out without prices', () => {
    expect(expiryNotice({ ...notice, from: { name: 'A' } })).toStartWith(
      'Prompt cache expires at 14:32. After that, the next message writes ~225K tokens to the cache again. ',
    );
  });
});
