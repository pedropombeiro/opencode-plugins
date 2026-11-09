import { describe, expect, test } from 'bun:test';
import {
  contextCeilingTip,
  estimateTokens,
  largeOutputTip,
  modelSwitchTip,
  warmingTip,
} from './tips';

const opus = { name: 'Opus 5.5', price: { input: 4, output: 20, read: 0.2, write: 5 } };
const sonnet = { name: 'Sonnet 5.5', price: { input: 2, output: 10, read: 0.1, write: 2.5 } };
const haiku = { name: 'Haiku 5.5', price: { input: 0.5, output: 2.5, read: 0.05, write: 0.625 } };
const limits = { minTokens: 50_000, minCost: 0.1 };

describe('modelSwitchTip', () => {
  test('warns that a switch on a warm cache rewrites it', () => {
    const tip = modelSwitchTip({ tokens: 250_000, warm: true, from: opus, to: sonnet, ...limits });
    expect(tip).toMatchObject({ key: 'model-switch', variant: 'warning' });
    expect(tip?.message).toBe(
      'Your next message on Sonnet 5.5 writes ~250K tokens to a new cache (~$0.63). Staying on Opus 5.5 reads them from its cache (~$0.05). To compact, switch back, compact, and then switch.',
    );
  });

  test('stays quiet below the size or cost thresholds', () => {
    expect(
      modelSwitchTip({ tokens: 40_000, warm: true, from: opus, to: sonnet, ...limits }),
    ).toBeUndefined();
    expect(
      modelSwitchTip({ tokens: 60_000, warm: true, from: opus, to: haiku, ...limits }),
    ).toBeUndefined();
  });

  test('warns without prices', () => {
    const tip = modelSwitchTip({
      tokens: 250_000,
      warm: true,
      from: { name: 'A' },
      to: { name: 'B' },
      ...limits,
    });
    expect(tip?.message).toContain('Staying on A reads them from its cache instead.');
  });

  test('suggests the cheaper model once the cache expired', () => {
    const tip = modelSwitchTip({ tokens: 250_000, warm: false, from: opus, to: haiku, ...limits });
    expect(tip).toMatchObject({ key: 'model-switch-cold', variant: 'info' });
    expect(tip?.message).toBe(
      'The next message rewrites ~250K tokens on any model: ~$0.16 on Haiku 5.5, ~$1.25 on Opus 5.5. If you plan to compact, compacting on Haiku 5.5 costs less (~$0.16).',
    );
  });

  test('suggests the configured compaction model once the cache expired', () => {
    const tip = modelSwitchTip({
      tokens: 250_000,
      warm: false,
      from: opus,
      to: { name: 'Opus 4.8', price: opus.price },
      compaction: { name: 'GPT-6.1 Sol', cost: 0.625 },
      ...limits,
    });
    expect(tip?.message).toBe(
      'The next message rewrites ~250K tokens on any model: ~$1.25 on Opus 4.8, ~$1.25 on Opus 5.5. If you plan to compact, compacting on GPT-6.1 Sol costs less (~$0.63).',
    );
  });

  test('stays quiet after expiry when the new model costs more', () => {
    expect(
      modelSwitchTip({ tokens: 250_000, warm: false, from: haiku, to: opus, ...limits }),
    ).toBeUndefined();
  });
});

describe('contextCeilingTip', () => {
  test('suggests compacting near the limit', () => {
    const tip = contextCeilingTip({
      tokens: 205_000,
      ceiling: { tokens: 250_000, reason: 'limit' },
      ratio: 0.8,
      price: opus.price,
    });
    expect(tip?.title).toBe('Close to the context limit');
    expect(tip?.message).toBe(
      "This session's context is at ~205K of 250K tokens. Compacting now, while the cache is warm, reads the context from the cache for ~$0.04. After the cache expires, the same compaction pays ~$1.02 to write it again.",
    );
  });

  test('names the higher price when the ceiling is a price tier', () => {
    const tip = contextCeilingTip({
      tokens: 85_000,
      ceiling: { tokens: 100_000, reason: 'price' },
      ratio: 0.8,
    });
    expect(tip?.title).toBe('Close to a higher price');
    expect(tip?.message).toBe(
      "This session's context is at ~85K tokens, and this model charges a higher price for prompts over 100K tokens. Compacting now, while the cache is warm, reads the context from the cache instead of writing it again.",
    );
  });

  test('stays quiet below the ratio', () => {
    expect(
      contextCeilingTip({
        tokens: 150_000,
        ceiling: { tokens: 250_000, reason: 'limit' },
        ratio: 0.8,
      }),
    ).toBeUndefined();
  });
});

describe('largeOutputTip', () => {
  test('names the tool and the cost per request', () => {
    const tip = largeOutputTip({
      tool: 'read',
      tokens: 32_000,
      threshold: 20_000,
      price: opus.price,
    });
    expect(tip?.key).toBe('large-output:read');
    expect(tip?.message).toBe(
      'read returned ~32K tokens. They stay in every later request in this session, adding ~$0.01 to each request as cache reads. Next time, ask for a narrower result, for example with grep, head, or a line range.',
    );
  });

  test('stays quiet below the threshold', () => {
    expect(largeOutputTip({ tool: 'read', tokens: 10_000, threshold: 20_000 })).toBeUndefined();
  });
});

describe('warmingTip', () => {
  const base = {
    ttl: 300_000,
    warming: { interval: 270_000, duration: 900_000 },
    model: 'Claude Opus 5.5',
    written: 225_000,
    prompt: 226_000,
    minTokens: 50_000,
    minCost: 0.1,
    price: opus.price,
  };

  test('reports that warming missed the cache', () => {
    const tip = warmingTip({ ...base, gap: 9 * 60_000 });
    expect(tip).toMatchObject({ key: 'warming', variant: 'warning' });
    expect(tip?.message).toBe(
      "Warming didn't keep the cache this time: this request wrote ~225K tokens again (~$1.13) after 9 minutes away. Warming requests also cost money, so consider turning warming off for Claude Opus 5.5.",
    );
  });

  test('leaves the cost out without prices', () => {
    expect(warmingTip({ ...base, gap: 9 * 60_000, price: undefined })?.message).toContain(
      'wrote ~225K tokens again after 9 minutes away.',
    );
  });

  test('stays quiet when the rewrite is cheap', () => {
    expect(warmingTip({ ...base, gap: 9 * 60_000, minCost: 2 })).toBeUndefined();
  });

  test('stays quiet when the cache did not expire', () => {
    expect(warmingTip({ ...base, gap: 4 * 60_000 })).toBeUndefined();
  });

  test('stays quiet when the request mostly read the cache', () => {
    expect(warmingTip({ ...base, gap: 7 * 60_000, written: 2000 })).toBeUndefined();
  });

  test('stays quiet beyond the warming window', () => {
    expect(warmingTip({ ...base, gap: 16 * 60_000 })).toBeUndefined();
  });

  test('stays quiet for small contexts', () => {
    expect(
      warmingTip({ ...base, gap: 7 * 60_000, written: 20_000, prompt: 20_000 }),
    ).toBeUndefined();
  });
});

test('estimateTokens', () => {
  expect(estimateTokens('a'.repeat(4001))).toBe(1001);
});
