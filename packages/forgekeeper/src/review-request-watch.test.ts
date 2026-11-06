import { describe, expect, test } from 'bun:test';
import type {
  FeedbackSnapshot,
  ReviewComment,
  ReviewRequest,
  ReviewRequestEvent,
  ReviewRequestHistory,
} from './forge';
import {
  authorReplies,
  createReviewRequestWatcher,
  MAX_REQUEST_REPLIES,
  REQUEST_INTERVAL,
  REQUEST_RETRY_DELAY,
  repliesLine,
  type RequestRecord,
  type RequestWindow,
} from './review-request-watch';

const mr = {
  forge: 'gitlab',
  iid: '7',
  url: 'https://gitlab.com/g/p/-/merge_requests/7',
} as ReviewRequest;

const viewer = 'gid://gitlab/User/1';
const author = 'gid://gitlab/User/2';

const request = (id: string, requester = author): ReviewRequestEvent => ({
  id,
  order: Number(id),
  url: `${mr.url}#note_${id}`,
  at: Number(id) * 1000,
  requester: { id: requester, username: requester === viewer ? 'pedro' : 'cleveland' },
});

const history = (newest: number, ...requests: ReviewRequestEvent[]): ReviewRequestHistory => ({
  complete: true,
  viewerID: viewer,
  newest,
  requests,
});

function harness(initial: ReviewRequestHistory, stored = new Map<string, RequestRecord>()) {
  let clock = 0;
  let current = initial;
  let failing = false;
  let reads = 0;
  const sent: Array<{ event: string; window: RequestWindow }> = [];
  const make = () =>
    createReviewRequestWatcher({
      record: async (key) => structuredClone(stored.get(key)),
      persist: (key, record) => void stored.set(key, structuredClone(record)),
      fetch: async () => {
        reads++;
        return current;
      },
      current: () => true,
      send: async (_sessionID, _request, event, window) => {
        if (failing) throw new Error('session unavailable');
        sent.push({ event: event.id, window });
      },
      now: () => clock,
    });
  return {
    stored,
    sent,
    reads: () => reads,
    make,
    set: (next: ReviewRequestHistory) => void (current = next),
    advance: (ms = REQUEST_INTERVAL) => void (clock += ms),
    fail: (value: boolean) => void (failing = value),
  };
}

describe('createReviewRequestWatcher', () => {
  test("records a baseline first, so existing requests aren't announced", async () => {
    const h = harness(history(10, request('4'), request('9')));
    const watcher = h.make();
    await watcher.check('one', mr);
    expect(h.sent).toEqual([]);
    expect([...h.stored.values()]).toEqual([{ baseline: 10, announced: [], seenAt: 0 }]);
    h.advance();
    await watcher.check('one', mr);
    expect(h.sent).toEqual([]);
  });

  test('announces a new request, and a repeated one, with the window since the previous', async () => {
    const h = harness(history(10, request('4')));
    const watcher = h.make();
    await watcher.check('one', mr);
    h.set(history(12, request('4'), request('12')));
    h.advance();
    await watcher.check('one', mr);
    expect(h.sent).toEqual([
      { event: '12', window: { previous: request('4'), after: 4, viewerID: viewer } },
    ]);
    // The viewer stays a reviewer: GitLab records the repeated request as
    // another note.
    h.set(history(20, request('4'), request('12'), request('20')));
    h.advance();
    await watcher.check('one', mr);
    expect(h.sent.map((entry) => [entry.event, entry.window.after])).toEqual([
      ['12', 4],
      ['20', 12],
    ]);
  });

  test('uses the baseline as the window without an earlier request', async () => {
    const h = harness(history(10));
    const watcher = h.make();
    await watcher.check('one', mr);
    h.set(history(15, request('15')));
    h.advance();
    await watcher.check('one', mr);
    expect(h.sent).toEqual([{ event: '15', window: { after: 10, viewerID: viewer } }]);
  });

  test("skips the viewer's own requests, but dates the next request's window from them", async () => {
    const h = harness(history(10));
    const watcher = h.make();
    await watcher.check('one', mr);
    h.set(history(12, request('12', viewer)));
    h.advance();
    await watcher.check('one', mr);
    expect(h.sent).toEqual([]);
    h.set(history(14, request('12', viewer), request('14')));
    h.advance();
    await watcher.check('one', mr);
    expect(h.sent.map((entry) => [entry.event, entry.window.after])).toEqual([['14', 12]]);
  });

  test('announces requests that piled up once, about the newest', async () => {
    const h = harness(history(10));
    const watcher = h.make();
    await watcher.check('one', mr);
    h.set(history(14, request('12'), request('14')));
    h.advance();
    await watcher.check('one', mr);
    h.advance();
    await watcher.check('one', mr);
    expect(h.sent.map((entry) => entry.event)).toEqual(['14']);
    expect([...h.stored.values()][0].announced).toEqual(['12', '14']);
  });

  test("doesn't announce a request again after a reload or reconnect", async () => {
    const h = harness(history(10));
    await h.make().check('one', mr);
    h.set(history(12, request('12')));
    h.advance();
    await h.make().check('one', mr);
    // A new instance, as after a reload, reads the stored record.
    const reloaded = h.make();
    h.advance();
    await reloaded.check('one', mr);
    // A subscription reconnect invalidates and reads again at once.
    reloaded.invalidate('one', mr);
    await reloaded.check('one', mr);
    expect(h.sent.map((entry) => entry.event)).toEqual(['12']);
  });

  test('never announces a request again once more requests than it lists were announced', async () => {
    const h = harness(history(10));
    const watcher = h.make();
    await watcher.check('one', mr);
    const requests: ReviewRequestEvent[] = [];
    for (let id = 11; id <= 115; id++) {
      requests.push(request(String(id)));
      h.set(history(id, ...requests));
      h.advance();
      await watcher.check('one', mr);
    }
    expect(h.sent).toHaveLength(105);
    // A reloaded instance reads the stored record, whose list dropped the
    // oldest IDs.
    const reloaded = h.make();
    h.advance();
    await reloaded.check('one', mr);
    expect(h.sent).toHaveLength(105);
    expect([...h.stored.values()][0]).toMatchObject({ processed: 115 });
  });

  test('reads the history at most once per interval, unless invalidated', async () => {
    const h = harness(history(10));
    const watcher = h.make();
    await watcher.check('one', mr);
    await watcher.check('one', mr);
    expect(h.reads()).toBe(1);
    watcher.invalidate('one', mr);
    await watcher.check('one', mr);
    expect(h.reads()).toBe(2);
  });

  test("ignores incomplete reads, and doesn't record a baseline from one", async () => {
    const h = harness({ ...history(10), complete: false });
    const watcher = h.make();
    await watcher.check('one', mr);
    expect(h.stored.size).toBe(0);
  });

  test('retries a failed send after the delay, and keeps it unannounced until then', async () => {
    const h = harness(history(10));
    const watcher = h.make();
    await watcher.check('one', mr);
    h.set(history(12, request('12')));
    h.fail(true);
    h.advance();
    await watcher.check('one', mr);
    expect([...h.stored.values()][0].announced).toEqual([]);
    h.fail(false);
    h.advance();
    await watcher.check('one', mr);
    expect(h.sent).toEqual([]);
    h.advance(REQUEST_RETRY_DELAY);
    await watcher.check('one', mr);
    expect(h.sent.map((entry) => entry.event)).toEqual(['12']);
  });

  test('keeps separate records per session', async () => {
    const h = harness(history(10));
    const watcher = h.make();
    await watcher.check('one', mr);
    await watcher.check('two', mr);
    h.set(history(12, request('12')));
    h.advance();
    await watcher.check('one', mr);
    await watcher.check('two', mr);
    expect(h.sent.map((entry) => entry.event)).toEqual(['12', '12']);
  });
});

const comment = (id: string, overrides: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  order: Number(id),
  url: `${mr.url}#note_${id}`,
  editedAt: 0,
  resolved: false,
  bot: false,
  authorID: author,
  username: 'cleveland',
  ...overrides,
});

const snapshot = (...comments: ReviewComment[]): FeedbackSnapshot => ({
  complete: true,
  viewerID: viewer,
  comments,
});

describe('authorReplies', () => {
  test("includes the author's replies since the window, resolved or not", () => {
    const context = authorReplies(
      snapshot(
        comment('3'),
        comment('5', { authorID: viewer, discussionID: 'd1' }),
        comment('6', { discussionID: 'd1', resolved: true }),
        comment('7', { authorID: 'other' }),
        comment('8', { bot: true }),
        comment('9', { discussionID: 'd2' }),
      ),
      new Set([author]),
      4,
    );
    expect(context.replies.map((entry) => entry.id)).toEqual(['6', '9']);
    expect(context).toMatchObject({ participated: 1, resolved: 1, more: 0 });
  });

  test('puts replies in threads the viewer took part in first, within the limit', () => {
    const many = Array.from({ length: MAX_REQUEST_REPLIES + 2 }, (_, index) =>
      comment(String(100 + index)),
    );
    const context = authorReplies(
      snapshot(
        comment('50', { authorID: viewer, discussionID: 'mine' }),
        ...many,
        comment('200', { discussionID: 'mine' }),
      ),
      new Set([author]),
      0,
    );
    expect(context.replies[0].id).toBe('200');
    expect(context.replies).toHaveLength(MAX_REQUEST_REPLIES);
    expect(context.more).toBe(3);
  });

  test('says nothing without a snapshot', () => {
    expect(authorReplies(undefined, new Set([author]), 0)).toEqual({
      replies: [],
      participated: 0,
      resolved: 0,
      more: 0,
    });
  });
});

describe('repliesLine', () => {
  test('names counts only', () => {
    expect(repliesLine({ replies: [], participated: 0, resolved: 0, more: 0 }, true)).toBe(
      undefined,
    );
    expect(
      repliesLine(
        { replies: [comment('6'), comment('9')], participated: 1, resolved: 1, more: 1 },
        true,
      ),
    ).toBe(
      'The author replied 3 times since the previous request: 1 in threads you took part in, 1 in resolved threads.',
    );
    expect(
      repliesLine({ replies: [comment('6')], participated: 0, resolved: 0, more: 0 }, false),
    ).toBe('The author replied 1 time since monitoring started.');
  });
});
