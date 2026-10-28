import { describe, expect, test } from 'bun:test';
import type { GitLabMergeRequest, ReviewRequest } from './forge';
import { createStatusService, HOME } from './status-service';
import type { Lookup } from './store';
import { flush } from './testing';

const mr = (overrides: Partial<GitLabMergeRequest> = {}): GitLabMergeRequest =>
  ({
    forge: 'gitlab',
    iid: '1',
    url: 'https://gitlab.com/g/p/-/merge_requests/1',
    state: 'opened',
    ...overrides,
  }) as GitLabMergeRequest;

const targets = (...requests: ReviewRequest[]): Lookup => ({
  kind: 'found',
  explicitTarget: true,
  requests,
});

function harness({
  human = false,
  pending = () => false,
  owns = () => true,
}: { human?: boolean; pending?: () => boolean; owns?: (key: string) => boolean } = {}) {
  let clock = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 0;
  const lookups = new Map<string, Lookup>();
  const loads: string[] = [];
  const checked: string[] = [];
  const observed: string[] = [];
  const removed = new Set<string>();
  const subscribed = new Map<string, ReviewRequest[]>();
  const service = createStatusService({
    load: async (key) => {
      loads.push(key);
      return lookups.get(key) ?? { kind: 'none', reason: 'No PR/MR' };
    },
    isTarget: (_sessionID, url) => !removed.has(url),
    owns,
    publish: () => {},
    feedbackTargets: (key, requests) => {
      subscribed.set(key, requests);
    },
    automated: {
      observe: async (sessionID) => void observed.push(sessionID),
      hasPending: (sessionID) => pending() && sessionID !== HOME,
    },
    ...(human
      ? {
          human: {
            check: (sessionID: string, request: ReviewRequest) =>
              void checked.push(`${sessionID} ${request.iid}`),
          },
        }
      : {}),
    interval: 100,
    activeInterval: 30,
    leaseTime: 300,
    now: () => clock,
    setTimer: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { at: clock + delay, callback });
      return id;
    },
    clearTimer: (id) => timers.delete(id as number),
  });
  return {
    service,
    lookups,
    loads,
    checked,
    observed,
    removed,
    subscribed,
    async advance(ms: number) {
      const end = clock + ms;
      for (;;) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        clock = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
        await flush();
      }
      clock = end;
      await flush();
    },
  };
}

describe('createStatusService', () => {
  test('inspection does not create store entries, leases, timers, or lookups', async () => {
    const app = harness({ human: true });
    expect(app.service.inspect('unknown')).toEqual({
      discovered: false,
      leased: false,
      polling: false,
      paused: false,
      feedbackTargets: [],
    });
    expect(app.service.keys()).toEqual([]);
    expect(app.loads).toEqual([]);
    app.lookups.set('one', targets(mr()));
    app.service.discover(['one']);
    await app.advance(0);
    expect(app.service.inspect('one')).toMatchObject({
      discovered: true,
      leased: false,
      polling: true,
    });
    app.service.watch('cli', ['one']);
    expect(app.service.inspect('one').leased).toBe(true);
    await app.advance(301);
    expect(app.service.inspect('one').leased).toBe(false);
    await app.service.dispose();
  });
  test('routes feedback events to active sessions and drops subscriptions on pause or expiry', async () => {
    const app = harness({ human: true });
    app.lookups.set('one', targets(mr()));
    app.lookups.set('two', targets(mr()));
    app.service.discover(['one', 'two']);
    await app.advance(0);
    expect(app.subscribed.get('one')).toEqual([mr()]);
    app.checked.length = 0;
    const invalidated: string[] = [];
    app.service.checkFeedback(mr().url, (key) => {
      invalidated.push(key);
    });
    await app.advance(0);
    expect(invalidated).toEqual(['one', 'two']);
    expect(app.checked).toEqual(['one 1', 'two 1']);
    app.service.pauseFeedback(true);
    expect(app.subscribed.get('one')).toEqual([]);
    expect(app.subscribed.get('two')).toEqual([]);
    app.service.checkFeedback(mr().url, () => {
      throw new Error('Paused');
    });
    app.service.pauseFeedback(false);
    expect(app.subscribed.get('one')).toEqual([mr()]);
    app.service.discover([]);
    expect(app.subscribed.get('one')).toEqual([]);
    await app.service.dispose();
  });
  test('polls discovered open targets without a CLI and stops closed or expired sessions', async () => {
    const app = harness({ human: true });
    app.lookups.set('one', targets(mr()));
    app.lookups.set('closed', targets(mr({ state: 'merged' })));
    app.service.discover(['one', 'closed']);
    await app.advance(0);
    expect(app.service.polling('one')).toBe(true);
    expect(app.service.polling('closed')).toBe(false);
    expect(app.checked).toEqual(['one 1']);
    app.service.discover([]);
    expect(app.service.polling('one')).toBe(false);
    await app.service.dispose();
  });

  test('keeps retrying a discovered session whose explicit targets could not be resolved', async () => {
    const app = harness({ human: true });
    app.lookups.set('one', { kind: 'none', reason: 'Not found', explicitTarget: true });
    app.service.discover(['one']);
    await app.advance(0);
    expect(app.service.polling('one')).toBe(true);
    // Backs off like a failure: 200, then 400 ms.
    await app.advance(199);
    expect(app.loads).toEqual(['one']);
    await app.advance(1);
    expect(app.loads).toEqual(['one', 'one']);
    app.lookups.set('one', targets(mr()));
    await app.advance(400);
    expect(app.loads).toHaveLength(3);
    expect(app.checked).toEqual(['one 1']);
    expect(app.service.polling('one')).toBe(true);
    // A lookup that names nothing explicit, such as an archived session, stops.
    app.lookups.set('one', { kind: 'none', reason: 'The session is archived' });
    await app.service.refresh('one');
    await app.advance(0);
    expect(app.service.polling('one')).toBe(false);
    await app.service.dispose();
  });

  test('polls a visible key, and stops once it is hidden without reviews to watch', async () => {
    const app = harness();
    app.lookups.set('ses_1', targets(mr()));
    app.service.watch('cli', ['ses_1'], 'ses_1');
    await app.advance(0);
    expect(app.loads).toEqual(['ses_1']);
    expect(app.service.polling('ses_1')).toBe(true);
    await app.advance(100);
    expect(app.loads).toHaveLength(2);

    app.service.watch('cli', ['ses_1']);
    expect(app.service.polling('ses_1')).toBe(false);
    await app.advance(500);
    expect(app.loads).toHaveLength(2);
  });

  test('restarts a discovered session when a closed target changes to an open target without a CLI', async () => {
    const app = harness({ human: true });
    const closed = mr({ state: 'merged' });
    const opened = mr({ iid: '2', url: 'https://gitlab.com/g/p/-/merge_requests/2' });
    app.lookups.set('one', targets(closed));
    app.service.discover(['one']);
    await app.advance(0);
    expect(app.service.polling('one')).toBe(false);
    app.removed.add(closed.url);
    app.lookups.set('one', targets(opened));
    app.service.invalidate('one');
    await app.advance(0);
    expect(app.loads).toEqual(['one', 'one']);
    expect(app.service.polling('one')).toBe(true);
    expect(app.checked).toEqual(['one 2']);
    expect(app.subscribed.get('one')).toEqual([opened]);
    await app.advance(100);
    expect(app.loads).toEqual(['one', 'one', 'one']);
    app.service.discover([]);
    expect(app.service.polling('one')).toBe(false);
    await app.service.dispose();
  });

  test('keeps a hidden session polling while its review runs, even after its title or targets change', async () => {
    const app = harness();
    app.lookups.set('ses_1', targets(mr({ duoReviewState: 'REVIEW_STARTED' })));
    app.service.watch('cli', ['ses_1'], 'ses_1');
    await app.advance(0);
    app.service.watch('cli', ['ses_1'], HOME);
    expect(app.service.polling('ses_1')).toBe(true);

    app.service.invalidate('ses_1');
    await app.advance(0);
    expect(app.service.polling('ses_1')).toBe(true);
    await app.advance(30);
    expect(app.loads.length).toBeGreaterThanOrEqual(3);

    app.lookups.set('ses_1', targets(mr({ duoReviewState: 'REVIEWED' })));
    await app.advance(30);
    expect(app.service.polling('ses_1')).toBe(false);
  });

  test('watches human feedback on open targets only, and only targets the server still has', async () => {
    const app = harness({ human: true });
    app.lookups.set(
      'ses_1',
      targets(
        mr(),
        mr({ iid: '2', url: 'https://gitlab.com/g/p/-/merge_requests/2', state: 'merged' }),
      ),
    );
    app.service.watch('cli', ['ses_1'], 'ses_1');
    await app.advance(0);
    expect(app.checked).toEqual(['ses_1 1']);

    app.removed.add(mr().url);
    await app.service.refresh('ses_1');
    await app.advance(0);
    expect(app.checked).toEqual(['ses_1 1']);
    app.service.watch('cli', ['ses_1']);
    expect(app.service.polling('ses_1')).toBe(false);
  });

  test('keeps polling while a notification waits for a retry', async () => {
    let pending = true;
    const app = harness({ pending: () => pending });
    app.lookups.set('ses_1', targets(mr({ duoReviewState: 'REVIEWED' })));
    app.service.watch('cli', ['ses_1'], 'ses_1');
    await app.advance(0);
    app.service.watch('cli', ['ses_1']);
    expect(app.service.polling('ses_1')).toBe(true);
    pending = false;
    await app.advance(100);
    expect(app.service.polling('ses_1')).toBe(false);
  });

  test("ends a lease that isn't renewed, and keeps another CLI's lease", async () => {
    const app = harness();
    app.lookups.set('ses_1', targets(mr({ duoReviewState: 'REVIEW_STARTED' })));
    app.service.watch('one', ['ses_1'], 'ses_1');
    app.service.watch('two', ['ses_1']);
    await app.advance(0);
    await app.advance(200);
    app.service.watch('two', ['ses_1']);
    await app.advance(200);
    // CLI "one" stopped renewing, but "two" still leases the running review.
    expect(app.service.polling('ses_1')).toBe(true);
    await app.advance(400);
    expect(app.service.polling('ses_1')).toBe(false);
  });

  test("drops a CLI's leases when it releases them", async () => {
    const app = harness();
    app.lookups.set('ses_1', targets(mr()));
    app.service.watch('cli', ['ses_1', HOME], 'ses_1');
    await app.advance(0);
    app.service.release('cli');
    expect(app.service.polling('ses_1')).toBe(false);
  });

  test('returns the snapshots of the leased keys', async () => {
    const app = harness();
    app.lookups.set('ses_1', targets(mr()));
    app.service.watch('cli', ['ses_1'], 'ses_1');
    await app.advance(0);
    expect(app.service.watch('cli', ['ses_1'], 'ses_1')).toEqual({
      ses_1: expect.objectContaining({ lookup: targets(mr()), loading: false }),
    });
  });

  test('looks up a leased session it has no lookup for, and keeps it only if it has reviews to watch', async () => {
    const app = harness({ human: true });
    app.lookups.set('ses_1', targets(mr()));
    app.service.watch('cli', ['ses_1', 'ses_2', 'ses_3'], 'ses_3');
    await app.advance(0);
    expect(new Set(app.loads)).toEqual(new Set(['ses_1', 'ses_2', 'ses_3']));
    expect(app.checked).toEqual(['ses_1 1']);
    expect(app.service.polling('ses_1')).toBe(true);
    // Nothing to watch, so the hidden session stops after its first lookup.
    expect(app.service.polling('ses_2')).toBe(false);
  });

  test("looks a leased session up again when its targets change, even while it doesn't poll", async () => {
    const app = harness();
    app.service.watch('cli', ['ses_1']);
    await app.advance(0);
    expect(app.service.polling('ses_1')).toBe(false);
    app.lookups.set('ses_1', targets(mr({ duoReviewState: 'REVIEW_STARTED' })));
    app.service.invalidate('ses_1');
    await app.advance(0);
    expect(app.loads).toEqual(['ses_1', 'ses_1']);
    expect(app.service.polling('ses_1')).toBe(true);
  });

  test('only shows a session that another checkout owns', async () => {
    const app = harness({ human: true, owns: () => false });
    app.lookups.set('ses_1', targets(mr({ duoReviewState: 'REVIEW_STARTED' })));
    app.service.watch('cli', ['ses_1']);
    await app.advance(0);
    expect(app.loads).toEqual([]);
    app.service.watch('cli', ['ses_1'], 'ses_1');
    await app.advance(0);
    expect(app.loads).toEqual(['ses_1']);
    expect(app.observed).toEqual([]);
    expect(app.checked).toEqual([]);
    app.service.watch('cli', ['ses_1']);
    expect(app.service.polling('ses_1')).toBe(false);
  });
});
