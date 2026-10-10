import { describe, expect, test } from 'bun:test';
import type { FeedbackSnapshot, ReviewComment, ReviewRequest } from './forge';
import {
  baselineOf,
  createFeedbackWatcher,
  eligibleFeedback,
  FETCH_INTERVAL,
  feedbackKey,
  feedbackMessage,
  feedbackToast,
  recordFeedback,
  RETRY_DELAY,
  SETTLE_TIME,
  type FeedbackLog,
  type SeenComments,
} from './human-review-watch';
import { until } from './testing';

const MINUTE = 60_000;
const mr = {
  forge: 'gitlab',
  iid: '7',
  url: 'https://gitlab.com/g/p/-/merge_requests/7',
} as ReviewRequest;

const comment = (id: string, overrides: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  order: Number(id),
  url: `${mr.url}#note_${id}`,
  editedAt: 0,
  resolved: false,
  bot: false,
  authorID: 'gid://gitlab/User/2',
  username: 'alice',
  ...overrides,
});

const snapshot = (...comments: ReviewComment[]): FeedbackSnapshot => ({
  complete: true,
  viewerID: 'gid://gitlab/User/1',
  comments,
});

const seen = (baseline = 0, ...announced: string[]): SeenComments => ({
  baseline,
  announced: new Set(announced),
});

describe('eligibleFeedback', () => {
  test('requires a comment to stay unchanged for the settle time', () => {
    const comments = snapshot(comment('1', { editedAt: 0 }));
    expect(eligibleFeedback(comments, seen(), SETTLE_TIME - 1)).toEqual([]);
    expect(eligibleFeedback(comments, seen(), SETTLE_TIME)).toEqual([comment('1')]);
  });

  test('skips baseline, announced, bot, own, and resolved comments', () => {
    const comments = snapshot(
      comment('10'),
      comment('11'),
      comment('13', { bot: true }),
      comment('14', { authorID: 'gid://gitlab/User/1' }),
      comment('15', { resolved: true }),
      comment('16'),
    );
    expect(eligibleFeedback(comments, seen(10, '11'), SETTLE_TIME).map((n) => n.id)).toEqual([
      '16',
    ]);
  });

  test('treats comments at or below the baseline as old after deletions shift the window', () => {
    // Comments 3 and 4 predate the baseline of 9, but only now appear in the window.
    const comments = snapshot(comment('3'), comment('4'), comment('12'));
    expect(eligibleFeedback(comments, seen(9), SETTLE_TIME).map((n) => n.id)).toEqual(['12']);
  });

  test("orders comments by the forge's order, not by ID", () => {
    // Opaque IDs from separate comment types, as on GitHub.
    const comments = snapshot(
      comment('1', { id: 'review-9', order: 20 }),
      comment('1', { id: 'issue-500', order: 5 }),
    );
    expect(eligibleFeedback(comments, seen(10), SETTLE_TIME).map((c) => c.id)).toEqual([
      'review-9',
    ]);
    expect(
      eligibleFeedback(snapshot(comment('100')), seen(99), SETTLE_TIME).map((c) => c.id),
    ).toEqual(['100']);
  });

  test('waits until no human comment has changed for the settle time', () => {
    const comments = snapshot(
      comment('1', { editedAt: 0 }),
      comment('2', { editedAt: 2 * MINUTE }),
    );
    expect(eligibleFeedback(comments, seen(), SETTLE_TIME)).toEqual([]);
    expect(eligibleFeedback(comments, seen(), 2 * MINUTE + SETTLE_TIME).map((n) => n.id)).toEqual([
      '1',
      '2',
    ]);
  });

  test('counts edits to old comments as activity', () => {
    const comments = snapshot(
      comment('1', { editedAt: 4 * MINUTE }),
      comment('2', { editedAt: 0 }),
    );
    expect(eligibleFeedback(comments, seen(1), SETTLE_TIME)).toEqual([]);
  });

  test('ignores activity from bots, the viewer, and resolved threads', () => {
    const recent = 4 * MINUTE;
    const comments = snapshot(
      comment('1', { editedAt: 0 }),
      comment('2', { bot: true, editedAt: recent }),
      comment('3', { authorID: 'gid://gitlab/User/1', editedAt: recent }),
      comment('5', { resolved: true, editedAt: recent }),
    );
    expect(eligibleFeedback(comments, seen(), SETTLE_TIME).map((n) => n.id)).toEqual(['1']);
  });
});

describe('baselineOf', () => {
  test('returns the highest comment order, or 0 without comments', () => {
    expect(baselineOf(snapshot(comment('9'), comment('100'), comment('42')))).toBe(100);
    expect(baselineOf(snapshot())).toBe(0);
  });
});

describe('recordFeedback', () => {
  test('keeps the first baseline, adds announced IDs once, and prunes old records', () => {
    const log: FeedbackLog = { records: { old: { baseline: 1, announced: [], seenAt: 0 } } };
    const now = 31 * 24 * 60 * MINUTE;
    recordFeedback(log, 'k', { baseline: 5 }, now);
    recordFeedback(log, 'k', { baseline: 8, announced: ['6', '7'] }, now);
    recordFeedback(log, 'k', { announced: ['7', '9'] }, now);
    expect(log.records).toEqual({ k: { baseline: 5, announced: ['6', '7', '9'], seenAt: now } });
  });
});

describe('feedback text', () => {
  test('names authors and links each comment', () => {
    const comments = [comment('1'), comment('2', { username: 'bob' }), comment('3')];
    const message = feedbackMessage(mr, comments);
    expect(message).toContain('New review feedback from @alice and @bob on !7');
    expect(message).toContain(`- @bob: ${mr.url}#note_2`);
    expect(feedbackToast(mr, comments)).toEqual({
      title: 'New review feedback on !7',
      message: '3 comments from @alice and @bob. Sent to the agent.',
    });
    expect(feedbackToast(mr, [comment('1')]).message).toBe(
      '1 comment from @alice. Sent to the agent.',
    );
  });

  test('lists three or more authors with commas and caps the links', () => {
    const comments = Array.from({ length: 22 }, (_, index) =>
      comment(String(index), { username: ['a', 'b', 'c'][index % 3] }),
    );
    const message = feedbackMessage(mr, comments);
    expect(message).toContain('from @a, @b, and @c on');
    expect(message).toContain('- and 2 more');
  });
});

function harness(initial: FeedbackSnapshot | null = snapshot()) {
  let clock = 0;
  let current = initial;
  let isCurrent = true;
  let fail: Error | undefined;
  const log: FeedbackLog = { records: {} };
  const sent: string[][] = [];
  const sendErrors: unknown[] = [];
  const fetchErrors: unknown[] = [];
  let fetches = 0;
  const watcher = createFeedbackWatcher({
    record: async (key) => log.records[key],
    persist: (key, change, at) => recordFeedback(log, key, change, at),
    fetch: async () => {
      fetches++;
      if (current === null) throw new Error('fetch failed');
      return current;
    },
    current: () => isCurrent,
    send: async (_sessionID, _mr, comments) => {
      if (fail) throw fail;
      sent.push(comments.map((n) => n.id));
    },
    onSendError: (error) => sendErrors.push(error),
    onFetchError: (error) => fetchErrors.push(error),
    now: () => clock,
  });
  return {
    watcher,
    log,
    sent,
    sendErrors,
    fetchErrors,
    fetches: () => fetches,
    set: (next: FeedbackSnapshot | null) => (current = next),
    setCurrent: (value: boolean) => (isCurrent = value),
    setFail: (error: Error | undefined) => (fail = error),
    // Advances past the fetch throttle by default.
    tick: (ms = FETCH_INTERVAL) => (clock += ms),
    check: () => watcher.check('ses_1', mr),
    now: () => clock,
  };
}

describe('createFeedbackWatcher', () => {
  test("doesn't fetch feedback for a PR/MR that is no longer a target", async () => {
    const h = harness();
    h.setCurrent(false);
    await h.check();
    expect(h.fetches()).toBe(0);
    // The skipped check doesn't count against the fetch throttle.
    h.setCurrent(true);
    await h.check();
    expect(h.fetches()).toBe(1);
  });

  test('establishes a baseline on the first complete snapshot', async () => {
    const h = harness(snapshot(comment('1')));
    await h.check();
    h.tick(SETTLE_TIME);
    await h.check();
    expect(h.sent).toEqual([]);
    expect(h.log.records[feedbackKey('ses_1', mr)]).toMatchObject({ baseline: 1, announced: [] });
  });

  test("doesn't announce older comments that deletions shift into the window", async () => {
    const h = harness(snapshot(comment('50')));
    await h.check();
    h.set(snapshot(comment('3'), comment('50'), comment('60')));
    h.tick(SETTLE_TIME);
    await h.check();
    expect(h.sent).toEqual([['60']]);
  });

  test("doesn't baseline from an incomplete snapshot", async () => {
    const h = harness({ ...snapshot(comment('1')), complete: false });
    await h.check();
    expect(h.log.records).toEqual({});
  });

  test('announces a new comment once it has settled', async () => {
    const h = harness();
    await h.check();
    h.set(snapshot(comment('1', { editedAt: h.now() })));
    h.tick(SETTLE_TIME - MINUTE);
    await h.check();
    expect(h.sent).toEqual([]);
    h.tick(MINUTE);
    await h.check();
    expect(h.sent).toEqual([['1']]);
    h.tick();
    await h.check();
    expect(h.sent).toEqual([['1']]);
  });

  test('restarts the settle time after an edit', async () => {
    const h = harness();
    await h.check();
    h.set(snapshot(comment('1', { editedAt: h.now() })));
    h.tick(4 * MINUTE);
    h.set(snapshot(comment('1', { editedAt: h.now() })));
    h.tick(2 * MINUTE);
    await h.check();
    expect(h.sent).toEqual([]);
    h.tick(3 * MINUTE);
    await h.check();
    expect(h.sent).toEqual([['1']]);
  });

  test('a newer comment delays the whole batch', async () => {
    const h = harness();
    await h.check();
    const start = h.now();
    h.tick(2 * MINUTE);
    h.set(
      snapshot(
        comment('1', { editedAt: start }),
        comment('2', { editedAt: start }),
        comment('3', { editedAt: h.now() }),
      ),
    );
    h.tick(3 * MINUTE);
    await h.check();
    expect(h.sent).toEqual([]);
    h.tick(2 * MINUTE);
    await h.check();
    expect(h.sent).toEqual([['1', '2', '3']]);
  });

  test('an edit to an announced comment delays new ones', async () => {
    const h = harness();
    await h.check();
    h.set(snapshot(comment('1')));
    h.tick(SETTLE_TIME);
    await h.check();
    expect(h.sent).toEqual([['1']]);
    h.set(
      snapshot(
        comment('1', { editedAt: h.now() }),
        comment('2', { editedAt: h.now() - SETTLE_TIME }),
      ),
    );
    h.tick();
    await h.check();
    expect(h.sent).toEqual([['1']]);
    h.tick(SETTLE_TIME);
    await h.check();
    expect(h.sent).toEqual([['1'], ['2']]);
  });

  test("doesn't repeat announced comments after a restart", async () => {
    const h = harness();
    await h.check();
    h.set(snapshot(comment('1')));
    h.tick(SETTLE_TIME);
    await h.check();
    const restarted = createFeedbackWatcher({
      record: async (key) => h.log.records[key],
      persist: (key, change, at) => recordFeedback(h.log, key, change, at),
      fetch: async () => snapshot(comment('1')),
      current: () => true,
      send: async (_sessionID, _mr, comments) => void h.sent.push(comments.map((n) => n.id)),
      now: () => h.now() + SETTLE_TIME,
    });
    await restarted.check('ses_1', mr);
    expect(h.sent).toEqual([['1']]);
  });

  test('announces comments posted while no TUI was watching', async () => {
    const h = harness();
    await h.check();
    const restarted = createFeedbackWatcher({
      record: async (key) => h.log.records[key],
      persist: (key, change, at) => recordFeedback(h.log, key, change, at),
      fetch: async () => snapshot(comment('1')),
      current: () => true,
      send: async (_sessionID, _mr, comments) => void h.sent.push(comments.map((n) => n.id)),
      now: () => SETTLE_TIME,
    });
    await restarted.check('ses_1', mr);
    expect(h.sent).toEqual([['1']]);
  });

  test('retries a failed send after a delay', async () => {
    const h = harness();
    await h.check();
    h.set(snapshot(comment('1')));
    h.setFail(new Error('offline'));
    h.tick(SETTLE_TIME);
    await h.check();
    expect(h.sendErrors).toEqual([new Error('offline')]);
    h.setFail(undefined);
    h.tick();
    await h.check();
    expect(h.sent).toEqual([]);
    h.tick(RETRY_DELAY);
    await h.check();
    expect(h.sent).toEqual([['1']]);
  });

  test('sends a batch once when checks overlap', async () => {
    let release: () => void = () => {};
    const log: FeedbackLog = {
      records: { [feedbackKey('ses_1', mr)]: { baseline: 0, announced: [], seenAt: 0 } },
    };
    const sent: string[][] = [];
    let clock = SETTLE_TIME;
    const watcher = createFeedbackWatcher({
      record: async (key) => log.records[key],
      persist: (key, change, at) => recordFeedback(log, key, change, at),
      fetch: async () => snapshot(comment('1')),
      current: () => true,
      send: (_sessionID, _mr, comments) =>
        new Promise((resolve) => {
          sent.push(comments.map((n) => n.id));
          release = resolve;
        }),
      now: () => clock,
    });
    const first = watcher.check('ses_1', mr);
    await until(() => sent.length === 1);
    clock += FETCH_INTERVAL;
    await watcher.check('ses_1', mr);
    release();
    await first;
    clock += FETCH_INTERVAL;
    await watcher.check('ses_1', mr);
    expect(sent).toEqual([['1']]);
  });

  test('throttles fetches', async () => {
    const h = harness();
    await h.check();
    h.tick(FETCH_INTERVAL - 1);
    await h.check();
    expect(h.fetches()).toBe(1);
    h.tick(1);
    await h.check();
    expect(h.fetches()).toBe(2);
  });

  test('drops results for a request that is no longer the target', async () => {
    const h = harness();
    h.setCurrent(false);
    await h.check();
    expect(h.log.records).toEqual({});
  });

  test('reports fetch failures without recording anything', async () => {
    const h = harness(null);
    await h.check();
    expect(h.fetchErrors).toEqual([new Error('fetch failed')]);
    expect(h.log.records).toEqual({});
  });
});
