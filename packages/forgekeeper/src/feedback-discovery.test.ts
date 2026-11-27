import { describe, expect, test } from 'bun:test';
import { createFeedbackDiscovery, RECENT_ACTIVITY } from './feedback-discovery';
import { linkedMetadata } from './linked-session';
import { deferred } from './testing';

describe('feedback discovery', () => {
  test('expires indexed activity, retries unreadable contexts, and rebuilds after a pause', async () => {
    let now = 2 * RECENT_ACTIVITY;
    let paused = false;
    let fail = true;
    let scans = 0;
    const reads: string[] = [];
    let watched: string[] = [];
    const discovery = createFeedbackDiscovery({
      directory: '/repo',
      now: () => now,
      paused: async () => paused,
      candidates: async () => {
        scans++;
        return ['old', 'retry'];
      },
      candidate: async () => true,
      session: async () => ({ time: {}, location: { directory: '/repo' } }),
      activity: async (id) => {
        reads.push(id);
        if (id === 'retry' && fail) throw new Error('unavailable');
        return id === 'old' ? RECENT_ACTIVITY : now;
      },
      watch: (ids) => {
        watched = ids;
      },
      error: () => {},
    });
    await discovery.refresh();
    expect(watched).toEqual(['old']);
    reads.length = 0;
    now++;
    fail = false;
    await discovery.refresh();
    expect(watched).toEqual(['retry']);
    await discovery.refresh();
    expect(reads).toEqual(['retry']);
    expect(scans).toBe(1);
    paused = true;
    await discovery.refresh();
    expect(watched).toEqual([]);
    paused = false;
    await discovery.refresh();
    expect(scans).toBe(2);
    expect(watched).toEqual(['retry']);
  });
  test('a targeted refresh reads one session and keeps the other sessions enrolled', async () => {
    let scans = 0;
    let eligible = true;
    const reads: string[] = [];
    let watched: string[] = [];
    const discovery = createFeedbackDiscovery({
      directory: '/repo',
      candidates: async () => {
        scans++;
        return ['one', 'two'];
      },
      candidate: async () => eligible,
      session: async (id) => {
        reads.push(id);
        return { time: {}, location: { directory: '/repo' } };
      },
      activity: async () => Date.now(),
      paused: async () => false,
      watch: (ids) => {
        watched = ids;
      },
      error: (error) => {
        throw error;
      },
    });
    await discovery.refresh();
    reads.length = 0;
    await discovery.refresh('two');
    expect(reads).toEqual(['two']);
    eligible = false;
    await discovery.refresh('two');
    expect(watched).toEqual(['one']);
    expect(scans).toBe(1);
  });
  test('discovers only recent non-archived root sessions in its checkout, without linked ones', async () => {
    const watched: string[][] = [];
    const at = 10 * RECENT_ACTIVITY;
    let paused = false;
    const discovery = createFeedbackDiscovery({
      directory: '/repo',
      candidate: async () => true,
      now: () => at,
      candidates: async () => [
        'recent',
        'boundary',
        'old',
        'child',
        'archived',
        'foreign',
        'empty',
        'linked',
      ],
      session: async (id) => ({
        parentID: id === 'child' ? 'parent' : undefined,
        time: { archived: id === 'archived' ? at : undefined },
        location: { directory: id === 'foreign' ? '/elsewhere' : '/repo' },
        ...(id === 'linked' ? { metadata: linkedMetadata('recent', 'batch', 'linked') } : {}),
      }),
      activity: async (id) => {
        switch (id) {
          case 'empty':
            return undefined;
          case 'old':
            return at - (RECENT_ACTIVITY + 1);
          case 'boundary':
            return at - RECENT_ACTIVITY;
          default:
            return at - 1;
        }
      },
      paused: async () => paused,
      watch: (ids) => watched.push(ids.sort()),
      error: (error) => {
        throw error;
      },
    });
    await discovery.refresh();
    expect(watched).toEqual([['boundary', 'recent']]);
    paused = true;
    await discovery.refresh();
    expect(watched.at(-1)).toEqual([]);
    discovery.stop();
    await discovery.refresh();
    expect(watched).toHaveLength(2);
  });

  test('does not register sessions after cleanup while discovery is in flight', async () => {
    const gate = deferred<string[]>();
    const watched: string[][] = [];
    const discovery = createFeedbackDiscovery({
      directory: '/repo',
      candidates: () => gate.promise,
      candidate: async () => true,
      session: async () => ({ time: {}, location: { directory: '/repo' } }),
      activity: async () => Date.now(),
      paused: async () => false,
      watch: (ids) => watched.push(ids),
      error: () => {},
    });
    const running = discovery.refresh();
    discovery.stop();
    gate.resolve(['one']);
    await running;
    expect(watched).toEqual([]);
  });
});
