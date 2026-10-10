import { describe, expect, test } from 'bun:test';
import type { Exec } from './exec';
import { createLimiter, limitExec, mapLimit } from './limit';
import { deferred, until, type Deferred } from './testing';

describe('mapLimit', () => {
  test('keeps the order of the items', async () => {
    // The tasks finish in the order 1, 2, 3, which isn't the order of the items.
    const gates = new Map([3, 1, 2].map((value) => [value, deferred()]));
    const started: number[] = [];
    const mapped = mapLimit([3, 1, 2], 2, async (value) => {
      started.push(value);
      await gates.get(value)!.promise;
      return value * 10;
    });
    await until(() => started.length === 2);
    gates.get(1)!.resolve();
    await until(() => started.length === 3);
    gates.get(2)!.resolve();
    gates.get(3)!.resolve();
    expect(await mapped).toEqual([30, 10, 20]);
    expect(await mapLimit([], 4, async (value) => value)).toEqual([]);
  });
});

describe('createLimiter', () => {
  test('runs at most the limit at once, in order, even when tasks arrive during a handoff', async () => {
    const limited = createLimiter(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const gates = new Map<number, Deferred>();
    const task = (id: number) =>
      limited(async () => {
        peak = Math.max(peak, ++running);
        order.push(id);
        gates.set(id, deferred());
        await gates.get(id)!.promise;
        running--;
        // A task queued as a slot frees up must still wait its turn.
        if (id === 1) void task(99);
      });
    const done = Promise.all([1, 2, 3, 4, 5].map(task));
    // Each task finishes once it has started, so every one that follows
    // starts as a slot frees up.
    for (const id of [1, 2, 3, 4, 5, 99]) {
      await until(() => gates.has(id));
      gates.get(id)!.resolve();
    }
    await done;
    await until(() => running === 0);
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5, 99]);
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
    const gates: Deferred[] = [];
    const run: Exec = async () => {
      peak = Math.max(peak, ++running);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      running--;
      return { stdout: '', stderr: '', code: 0 };
    };
    const limited = limitExec(run);
    const done = Promise.all(Array.from({ length: 50 }, () => limited('glab', [], '/repo')));
    for (let finished = 0; finished < 50; finished++) {
      await until(() => gates.length > finished);
      gates[finished].resolve();
    }
    await done;
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
    await until(() => ran.length === 1);
    stopped.abort();
    finish();
    expect((await first).code).toBe(0);
    expect(await queued).toEqual({ stdout: '', stderr: 'The plugin stopped', code: -1 });
    expect((await limited('later', [], '/repo')).code).toBe(-1);
    expect(ran).toEqual(['first']);
  });
});
