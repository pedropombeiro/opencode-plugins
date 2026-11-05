import { expect, test } from 'bun:test';
import { createKeyedQueue } from './keyed-queue';
import { deferred, flush } from './testing';

test('serializes a key, lets other keys progress, and recovers after rejection', async () => {
  const queue = createKeyedQueue();
  const gate = deferred();
  const started: string[] = [];
  const first = queue.run('one', async () => {
    started.push('first');
    await gate.promise;
    throw new Error('failed');
  });
  const rejected = first.catch((error: unknown) => error);
  const next = queue.run('one', async () => {
    started.push('next');
    return 42;
  });
  await queue.run('two', async () => {
    started.push('other');
  });
  await flush();
  expect(started).toEqual(['first', 'other']);
  expect(queue.tasks()).toHaveLength(1);
  gate.resolve();
  expect(await rejected).toEqual(new Error('failed'));
  expect(await next).toBe(42);
  await Promise.all(queue.tasks());
  await flush();
  expect(started).toEqual(['first', 'other', 'next']);
  expect(queue.tasks()).toEqual([]);
});

test('keeps a later task tracked when an earlier task completes', async () => {
  const queue = createKeyedQueue();
  const gate = deferred();
  const first = queue.run('one', async () => 1);
  const next = queue.run('one', () => gate.promise);
  await first;
  await flush();
  expect(queue.tasks()).toHaveLength(1);
  gate.resolve();
  await next;
  await flush();
  expect(queue.tasks()).toEqual([]);
});
