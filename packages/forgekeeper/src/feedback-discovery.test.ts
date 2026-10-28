import { describe, expect, test } from 'bun:test';
import { createFeedbackDiscovery, RECENT_ACTIVITY } from './feedback-discovery';
import { deferred } from './testing';

describe('feedback discovery', () => {
  test('discovers only recent non-archived root sessions in its checkout', async () => {
    const watched: string[][] = [];
    const at = 10 * RECENT_ACTIVITY;
    let paused = false;
    const discovery = createFeedbackDiscovery({
      directory: '/repo',
      now: () => at,
      candidates: async () => [
        'recent',
        'boundary',
        'old',
        'child',
        'archived',
        'foreign',
        'empty',
      ],
      session: async (id) => ({
        parentID: id === 'child' ? 'parent' : undefined,
        time: { archived: id === 'archived' ? at : undefined },
        location: { directory: id === 'foreign' ? '/elsewhere' : '/repo' },
      }),
      activity: async (id) =>
        id === 'empty'
          ? undefined
          : at - (id === 'old' ? RECENT_ACTIVITY + 1 : id === 'boundary' ? RECENT_ACTIVITY : 1),
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
