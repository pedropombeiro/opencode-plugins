import { describe, expect, test } from 'bun:test';
import { reply, waitForReply } from './pending.ts';

describe('waitForReply', () => {
  test("resolves with the reply's action", async () => {
    const waiting = waitForReply('req-1', 1_000);
    expect(reply('req-1', 'tab')).toBe(true);
    expect(await waiting).toBe('tab');
  });

  test('resolves undefined after the timeout and ignores late replies', async () => {
    expect(await waitForReply('req-2', 10)).toBeUndefined();
    expect(reply('req-2', 'route')).toBe(false);
  });

  test('resolves undefined when aborted', async () => {
    const controller = new AbortController();
    const waiting = waitForReply('req-3', 1_000, controller.signal);
    controller.abort();
    expect(await waiting).toBeUndefined();
  });
});
