import { describe, expect, test } from 'bun:test';
import type { Exec } from './exec';
import { createLimiter, limitExec, mapLimit } from './limit';

describe('mapLimit', () => {
  test('keeps the order of the items', async () => {
    expect(
      await mapLimit([3, 1, 2], 2, async (value) => (await Bun.sleep(value), value * 10)),
    ).toEqual([30, 10, 20]);
    expect(await mapLimit([], 4, async (value) => value)).toEqual([]);
  });
});

describe('createLimiter', () => {
  test('runs at most the limit at once, in order, even when tasks arrive during a handoff', async () => {
    const limited = createLimiter(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (id: number) =>
      limited(async () => {
        peak = Math.max(peak, ++running);
        order.push(id);
        await Bun.sleep(1);
        running--;
        // A task queued as a slot frees up must still wait its turn.
        if (id === 1) void task(99);
      });
    await Promise.all([1, 2, 3, 4, 5].map(task));
    await Bun.sleep(5);
    expect(peak).toBe(2);
    expect(order.slice(0, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  test('frees the slot of a failed task', async () => {
    const limited = createLimiter(1);
    await expect(limited(async () => Promise.reject(new Error('nope')))).rejects.toThrow('nope');
    expect(await limited(async () => 'ok')).toBe('ok');
  });
});

describe('limitExec', () => {
  test('shares one limit across every command', async () => {
    let running = 0;
    let peak = 0;
    const run: Exec = async () => {
      peak = Math.max(peak, ++running);
      await Bun.sleep(1);
      running--;
      return { stdout: '', stderr: '', code: 0 };
    };
    const limited = limitExec(run);
    await Promise.all(Array.from({ length: 50 }, () => limited('glab', [], '/repo')));
    expect(peak).toBe(4);
  });
});

describe('limitExec cancellation', () => {
  test('stops running queued and new commands once the signal aborts', async () => {
    const ran: string[] = [];
    let finish = () => {};
    const run: Exec = async (file) => {
      ran.push(file);
      if (file === 'first') await new Promise<void>((resolve) => (finish = resolve));
      return { stdout: '', stderr: '', code: 0 };
    };
    const stopped = new AbortController();
    const limited = limitExec(run, 1, stopped.signal);
    const first = limited('first', [], '/repo');
    const queued = limited('queued', [], '/repo');
    await Bun.sleep(0);
    stopped.abort();
    finish();
    expect((await first).code).toBe(0);
    expect(await queued).toEqual({ stdout: '', stderr: 'The plugin stopped', code: -1 });
    expect((await limited('later', [], '/repo')).code).toBe(-1);
    expect(ran).toEqual(['first']);
  });
});
