import { describe, expect, test } from 'bun:test';
import type { GitLabMergeRequest, ReviewRequest } from './forge';
import { createStatusService, HOME } from './status-service';
import type { Lookup } from './store';

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
  const service = createStatusService({
    load: async (key) => {
      loads.push(key);
      return lookups.get(key) ?? { kind: 'none', reason: 'No PR/MR' };
    },
    isTarget: (_sessionID, url) => !removed.has(url),
    owns,
    publish: () => {},
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
        await Bun.sleep(0);
      }
      clock = end;
      await Bun.sleep(0);
    },
  };
}

describe('createStatusService', () => {
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
