import { describe, expect, test } from 'bun:test';
import { duoFindings, duoReady } from './review-feedback';
import type { FeedbackSnapshot, ReviewComment, ReviewRequest } from '../../forge';
import {
  applyFeedback,
  createFeedbackWatcher,
  SETTLE_TIME,
  type FeedbackRecord,
} from '../../human-review-watch';
import { deferred } from '../../testing';

const request = {
  forge: 'gitlab',
  url: 'https://gitlab.com/g/p/-/merge_requests/1',
} as ReviewRequest;
const finding = (id: string, overrides: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  order: Number(id),
  url: `${request.url}#note_${id}`,
  editedAt: 0,
  resolved: false,
  bot: true,
  authorID: 'duo',
  username: 'GitLabDuo',
  automated: { reviewer: 'GitLab Duo', finding: true, runID: 'run-1', status: 'FINISHED' },
  ...overrides,
});

function harness() {
  let clock = SETTLE_TIME;
  let snapshot: FeedbackSnapshot = { complete: true, viewerID: 'me', comments: [] };
  let record: FeedbackRecord | undefined;
  const sent: string[][] = [];
  let fail = false;
  let fetch = async () => snapshot;
  const create = () =>
    createFeedbackWatcher({
      select: duoFindings,
      ready: duoReady,
      record: async () => record,
      persist: (_key, change, at) => {
        record = applyFeedback(record, change, at);
      },
      current: () => true,
      fetch: () => fetch(),
      send: async (_session, _request, comments) => {
        if (fail) throw new Error('storage unavailable');
        sent.push(comments.map((comment) => comment.id));
      },
      now: () => clock,
    });
  return {
    create,
    sent,
    record: () => record,
    set: (comments: ReviewComment[], complete = true) => {
      snapshot = { ...snapshot, comments, complete };
    },
    advance: (ms = SETTLE_TIME) => {
      clock += ms;
    },
    fail: (value: boolean) => {
      fail = value;
    },
    fetch: (value: () => Promise<FeedbackSnapshot>) => {
      fetch = value;
    },
    check: (watcher: ReturnType<typeof create>) => watcher.check('one', request),
  };
}

describe('published Duo feedback', () => {
  test('records an empty baseline and catches a completed review without observing it running', async () => {
    const app = harness();
    const watcher = app.create();
    await app.check(watcher);
    expect(app.record()?.baseline).toBe(0);
    app.set([finding('1')]);
    app.advance();
    await app.check(watcher);
    expect(app.sent).toEqual([['1']]);
    await app.check(app.create());
    expect(app.sent).toHaveLength(1);
    app.set([
      finding('1'),
      finding('2', {
        automated: { reviewer: 'GitLab Duo', finding: true, runID: 'run-2', status: 'FINISHED' },
      }),
    ]);
    app.advance();
    await app.check(app.create());
    expect(app.sent).toEqual([['1'], ['2']]);
  });

  test('baselines historical findings and ignores summaries, other bots and resolved findings', async () => {
    const app = harness();
    app.set([finding('1')]);
    const watcher = app.create();
    await app.check(watcher);
    app.advance();
    app.set([
      finding('1'),
      finding('2', { resolved: true }),
      finding('3', { automated: { reviewer: 'GitLab Duo', finding: false } }),
      finding('4', { automated: undefined }),
    ]);
    await app.check(watcher);
    expect(app.sent).toEqual([]);
  });

  test('waits for publication and settling, supports unlinked classic findings and retries failures', async () => {
    const app = harness();
    const watcher = app.create();
    await app.check(watcher);
    app.advance();
    app.set([
      finding('1', {
        automated: { reviewer: 'GitLab Duo', finding: true, runID: 'run-1', status: 'RUNNING' },
      }),
    ]);
    await app.check(watcher);
    expect(app.sent).toEqual([]);
    app.advance();
    app.set([finding('1', { editedAt: 3 * SETTLE_TIME })]);
    await app.check(watcher);
    expect(app.sent).toEqual([]);
    app.advance();
    app.set([finding('1', { automated: { reviewer: 'GitLab Duo', finding: true } })]);
    app.fail(true);
    await app.check(watcher);
    expect(app.record()?.announced).toEqual([]);
    app.fail(false);
    await app.check(app.create());
    expect(app.sent).toEqual([['1']]);
  });

  test('does not baseline incomplete data or deliver findings resolved during the final fetch', async () => {
    const app = harness();
    const watcher = app.create();
    app.set([finding('1')], false);
    await app.check(watcher);
    expect(app.record()).toBeUndefined();
    app.set([]);
    await app.check(watcher);
    app.advance();
    app.set([finding('1', { editedAt: 2 * SETTLE_TIME })]);
    await app.check(watcher);
    app.advance();
    const gate = deferred<FeedbackSnapshot>();
    app.fetch(() => gate.promise);
    const check = app.check(watcher);
    gate.resolve({ complete: true, viewerID: 'me', comments: [finding('1', { resolved: true })] });
    await check;
    expect(app.sent).toEqual([]);
  });
});
