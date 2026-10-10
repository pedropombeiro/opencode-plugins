import { describe, expect, test } from 'bun:test';
import {
  automatedReview,
  createAutomatedReviewWatcher,
  finishedReviews,
  isReviewRunning,
  notificationKey,
  reviewMessage,
  reviewOutcome,
  reviewTitle,
  reviewToast,
  RETRY_DELAY,
  type PendingDeliveries,
  type PendingDelivery,
} from './automated-review-watch';
import type { GitHubPullRequest, GitLabMergeRequest, ReviewRequest } from './forge';
import type { Lookup } from './store';

const mr = (duoReviewState?: string, iid = '4281', state = 'opened'): GitLabMergeRequest =>
  ({
    forge: 'gitlab',
    iid,
    url: `https://gitlab.com/group/project/-/merge_requests/${iid}`,
    state,
    duoReviewState,
  }) as GitLabMergeRequest;

const found = (...requests: ReviewRequest[]): Lookup => ({
  kind: 'found',
  explicitTarget: true,
  requests,
});

describe('isReviewRunning', () => {
  test('detects a running review', () => {
    expect(isReviewRunning(found(mr('REVIEWED'), mr('REVIEW_STARTED', '2')))).toBe(true);
  });

  test.each([['REVIEWED'], ['APPROVED'], [undefined]])('ignores %s', (state) => {
    expect(isReviewRunning(found(mr(state)))).toBe(false);
  });

  test('handles missing lookups', () => {
    expect(isReviewRunning(undefined)).toBe(false);
    expect(isReviewRunning({ kind: 'none', reason: 'Detached HEAD' })).toBe(false);
  });
});

describe('finishedReviews', () => {
  test.each(['REVIEWED', 'REQUESTED_CHANGES'])('reports a review that finished as %s', (state) => {
    expect(finishedReviews(found(mr('REVIEW_STARTED')), found(mr(state)))).toEqual([mr(state)]);
  });

  test.each(['APPROVED', 'UNREVIEWED', 'UNAPPROVED', 'REVIEW_STARTED', undefined])(
    'ignores a review that ended as %s',
    (state) => {
      expect(finishedReviews(found(mr('REVIEW_STARTED')), found(mr(state)))).toEqual([]);
    },
  );

  test('ignores a review that was already finished on the first load', () => {
    expect(finishedReviews(undefined, found(mr('REVIEWED')))).toEqual([]);
    expect(finishedReviews(found(mr('REVIEWED')), found(mr('REVIEWED')))).toEqual([]);
  });

  test('matches MRs by URL', () => {
    expect(finishedReviews(found(mr('REVIEW_STARTED', '1')), found(mr('REVIEWED', '2')))).toEqual(
      [],
    );
  });
});

describe('reviewMessage', () => {
  test('names the reviewer, the MR, and its final state', () => {
    const message = reviewMessage([mr('REQUESTED_CHANGES')]);
    expect(message).toStartWith('GitLab Duo finished reviewing !4281');
    expect(message).toContain("GitLab Duo's new comments and discussion threads on the MR");
    expect(reviewTitle([mr('REVIEWED')])).toBe('GitLab Duo finished reviewing !4281');
    expect(message).toContain('!4281 (https://gitlab.com/group/project/-/merge_requests/4281)');
    expect(message).toContain('"requested changes"');
  });

  test('lists every review that finished together, with its URL and state', () => {
    const requests = [mr('REVIEWED', '1'), mr('REQUESTED_CHANGES', '2')];
    expect(reviewTitle(requests)).toBe('GitLab Duo finished reviewing 2 MRs');
    expect(reviewMessage(requests)).toBe(
      [
        'GitLab Duo finished reviewing 2 MRs:',
        '- !1 (https://gitlab.com/group/project/-/merge_requests/1) with the state "reviewed"',
        '- !2 (https://gitlab.com/group/project/-/merge_requests/2) with the state "requested changes"',
        "For each one, fetch the reviewer's new comments and discussion threads, then work through its feedback.",
      ].join('\n'),
    );
    expect(reviewToast(requests)).toEqual({
      title: 'GitLab Duo finished reviewing 2 MRs',
      message: '!1: reviewed, !2: requested changes. Sent to the agent.',
    });
    expect(reviewToast([mr('REVIEWED')]).message).toBe('Reviewed. Sent to the agent.');
  });
});

describe('reviewOutcome', () => {
  test.each([
    ['REVIEWED', 'Reviewed'],
    ['REQUESTED_CHANGES', 'Requested changes'],
  ])('formats %s', (state, outcome) => {
    expect(reviewOutcome(mr(state))).toBe(outcome);
  });
});

describe('createAutomatedReviewWatcher', () => {
  interface Options {
    fail?: boolean;
    targets?: (url: string) => boolean;
    now?: () => number;
    pending?: PendingDeliveries;
  }

  function harness({
    fail = false,
    targets = () => true,
    now = () => 1_000,
    pending,
  }: Options = {}) {
    const sent: Array<[string, string[]]> = [];
    // Stored deliveries, by notification key.
    const stored = new Map<string, PendingDelivery>(Object.entries(pending ?? {}));
    const errors: string[] = [];
    const state = { fail };
    const watcher = createAutomatedReviewWatcher({
      isTarget: (_sessionID, url) => targets(url),
      async send(sessionID, requests) {
        if (state.fail) throw new Error('server busy');
        sent.push([
          sessionID,
          requests.map((request) => `${request.iid} ${automatedReview(request)?.label}`),
        ]);
      },
      onSendError: (error) => errors.push((error as Error).message),
      read: async (sessionID) =>
        Object.fromEntries([...stored].filter(([, delivery]) => delivery.sessionID === sessionID)),
      write: (sessionID, url, delivery) => {
        const key = notificationKey(sessionID, { url });
        if (delivery) stored.set(key, delivery);
        else stored.delete(key);
      },
      now,
    });
    return { watcher, sent, stored, errors, state };
  }

  test('notifies about a review that finished with feedback', async () => {
    const { watcher, sent } = harness();
    await watcher.observe('ses_1', found(mr('REVIEW_STARTED')), found(mr('REQUESTED_CHANGES')));
    expect(sent).toEqual([['ses_1', ['4281 requested changes']]]);
    // The same feedback without a new transition sends nothing.
    await watcher.observe('ses_1', found(mr('REQUESTED_CHANGES')), found(mr('REQUESTED_CHANGES')));
    expect(sent).toHaveLength(1);
  });

  test('sends reviews of several targets that finished in one poll together', async () => {
    const { watcher, sent } = harness();
    const before = found(
      mr('REVIEW_STARTED', '1'),
      mr('REVIEW_STARTED', '2'),
      mr('REVIEW_STARTED', '3'),
    );
    const after = found(
      mr('REVIEWED', '1'),
      mr('REVIEW_STARTED', '2'),
      mr('REQUESTED_CHANGES', '3'),
    );
    await watcher.observe('ses_1', before, after);
    expect(sent).toEqual([['ses_1', ['1 reviewed', '3 requested changes']]]);
    await watcher.observe('ses_1', after, found(mr('REVIEWED', '1'), mr('REVIEWED', '2')));
    expect(sent.at(-1)).toEqual(['ses_1', ['2 reviewed']]);
  });

  test('skips PRs/MRs that are no longer targets', async () => {
    const { watcher, sent } = harness({ targets: (url) => !url.endsWith('/2') });
    await watcher.observe(
      'ses_1',
      found(mr('REVIEW_STARTED', '1'), mr('REVIEW_STARTED', '2')),
      found(mr('REVIEWED', '1'), mr('REVIEWED', '2')),
    );
    expect(sent).toEqual([['ses_1', ['1 reviewed']]]);
  });

  test('ignores approvals and running reviews', async () => {
    const { watcher, sent } = harness();
    await watcher.observe('ses_1', found(mr('REVIEW_STARTED')), found(mr('APPROVED')));
    await watcher.observe('ses_1', undefined, found(mr('REVIEW_STARTED')));
    expect(sent).toEqual([]);
  });

  test('retries a failed send while the review still has feedback', async () => {
    let clock = 1_000;
    const { watcher, sent, errors, stored, state } = harness({ fail: true, now: () => clock });
    await watcher.observe('ses_1', found(mr('REVIEW_STARTED')), found(mr('REVIEWED')));
    expect(errors).toEqual(['server busy']);
    expect(watcher.hasPending('ses_1')).toBe(true);
    expect(stored.get(notificationKey('ses_1', mr()))).toMatchObject({
      retryAt: 1_000 + RETRY_DELAY,
    });

    state.fail = false;
    clock += RETRY_DELAY - 1;
    await watcher.observe('ses_1', found(mr('REVIEWED')), found(mr('REVIEWED')));
    expect(sent).toEqual([]);
    clock += 1;
    await watcher.observe('ses_1', found(mr('REVIEWED')), found(mr('REVIEWED')));
    expect(sent).toEqual([['ses_1', ['4281 reviewed']]]);
    expect(watcher.hasPending('ses_1')).toBe(false);
    expect(stored.size).toBe(0);
  });

  test('drops a pending send once a new review starts or the PR/MR stops being a target', async () => {
    const key = notificationKey('ses_1', mr());
    const pending: PendingDeliveries = {
      [key]: { sessionID: 'ses_1', url: mr().url, since: 1_000, retryAt: 0 },
    };
    const restarted = harness({ pending });
    await restarted.watcher.observe('ses_1', found(mr('REVIEWED')), found(mr('REVIEW_STARTED')));
    expect(restarted.watcher.hasPending('ses_1')).toBe(false);
    expect(restarted.sent).toEqual([]);

    const removed = harness({ pending, targets: () => false });
    await removed.watcher.observe('ses_1', found(mr('REVIEWED')), found(mr('REVIEWED')));
    expect(removed.watcher.hasPending('ses_1')).toBe(false);
    expect(removed.sent).toEqual([]);
  });

  test('ignores reviews of merged or closed PRs/MRs, and drops their pending sends', async () => {
    const { watcher, sent } = harness();
    await watcher.observe(
      'ses_1',
      found(mr('REVIEW_STARTED')),
      found(mr('REVIEWED', '4281', 'merged')),
    );
    expect(sent).toEqual([]);

    const key = notificationKey('ses_1', mr());
    const closed = harness({
      pending: { [key]: { sessionID: 'ses_1', url: mr().url, since: 1_000, retryAt: 0 } },
    });
    await closed.watcher.observe('ses_1', undefined, found(mr('REVIEWED', '4281', 'closed')));
    expect(closed.sent).toEqual([]);
    expect(closed.stored.size).toBe(0);
  });

  test("reads a session's stored deliveries once, so a removal still queued isn't undone", async () => {
    let reads = 0;
    const watcher = createAutomatedReviewWatcher({
      isTarget: () => true,
      send: async () => {},
      read: async () => {
        reads++;
        return {};
      },
      now: () => 1_000,
    });
    await watcher.observe('ses_1', undefined, found(mr('REVIEWED')));
    await watcher.observe('ses_1', undefined, found(mr('REVIEWED')));
    expect(reads).toBe(1);
    // A session that moved away is read again if it comes back.
    watcher.forget('ses_1');
    await watcher.observe('ses_1', undefined, found(mr('REVIEWED')));
    expect(reads).toBe(2);
  });

  test('sends a delivery that was pending before a restart', async () => {
    const key = notificationKey('ses_1', mr());
    const { watcher, sent } = harness({
      pending: { [key]: { sessionID: 'ses_1', url: mr().url, since: 1_000, retryAt: 0 } },
    });
    await watcher.observe('ses_1', undefined, found(mr('REQUESTED_CHANGES')));
    expect(sent).toEqual([['ses_1', ['4281 requested changes']]]);
  });
});

describe('automated review capability', () => {
  test('maps GitLab Duo states', () => {
    expect(automatedReview(mr('REVIEW_STARTED'))).toEqual({
      name: 'GitLab Duo',
      state: 'running',
      label: 'review started',
    });
    expect(automatedReview(mr('REQUESTED_CHANGES'))?.state).toBe('feedback');
    expect(automatedReview(mr('APPROVED'))?.state).toBe('settled');
    expect(automatedReview(mr())).toBeUndefined();
  });

  test('ignores forges without the capability', () => {
    const pull = {
      forge: 'github',
      iid: '1',
      url: 'https://github.com/o/r/pull/1',
    } as GitHubPullRequest;
    expect(automatedReview(pull)).toBeUndefined();
    expect(isReviewRunning(found(pull))).toBe(false);
    expect(finishedReviews(found(pull), found(pull))).toEqual([]);
  });
});
