import type { Plugin } from '@opencode/plugin';
import { describe, expect, test } from 'bun:test';
import {
  APPROVAL_RETENTION,
  approvalDetails,
  approvalTitle,
  createApprovalWatcher,
  observeApprovals,
  unchangedApproval,
  type ApprovalEvent,
  type ApprovalRecord,
} from './approval-watch';
import { settledFeedback } from './feedback-cleanup';
import type { GitLabMergeRequest, ReviewerApproval, ReviewRequest } from './forge';
import { statusOptions } from './options';
import { createReviewMonitoring } from './review-monitoring';

const mr = (iid: string, overrides: Partial<GitLabMergeRequest> = {}): ReviewRequest =>
  ({
    forge: 'gitlab',
    iid,
    title: `MR ${iid}`,
    url: `https://gitlab.com/g/p/-/merge_requests/${iid}`,
    state: 'opened',
    draft: false,
    conflicts: false,
    conflictsKnown: true,
    approved: false,
    awaitingReviewers: [],
    reviewersComplete: true,
    targetProject: 'g/p',
    targetBranch: 'main',
    sourceProject: 'g/p',
    sourceBranch: `branch-${iid}`,
    authorID: 'author-1',
    unresolvedThreads: 0,
    threadsComplete: true,
    approvers: [],
    ...overrides,
  }) as ReviewRequest;

const duo: ReviewerApproval = {
  id: 'duo-id',
  username: 'GitLabDuo',
  bot: true,
  automated: true,
};
const alice: ReviewerApproval = { id: 'alice-id', username: 'alice' };
const secBot: ReviewerApproval = {
  id: 'sec-id',
  username: 'duo-security-review-gitlab-org',
  bot: true,
};
const reference = (request: ReviewRequest) => `!${request.iid}`;

function run(
  lookups: ReviewRequest[][],
  watches: (request: ReviewRequest, approver: ReviewerApproval) => boolean = () => true,
  delivery: () => 'inbox' | 'passive' | 'summary' = () => 'inbox',
) {
  let records = new Map<string, ApprovalRecord>();
  let at = 0;
  for (const requests of lookups) {
    const next = observeApprovals('one', requests, records, reference, ++at, watches, delivery);
    records = new Map([...records, ...next.map((record) => [record.url, record] as const)]);
  }
  return records;
}

const pendingIDs = (records: Map<string, ApprovalRecord>) =>
  [...records.values()].flatMap((record) => record.pending.map((event) => event.id));

describe('approvalTitle and approvalDetails', () => {
  test('uses the automated reviewer display name and @username for others', () => {
    const request = mr('45');
    expect(approvalTitle(request, duo, '!45')).toBe('GitLab Duo approved !45');
    expect(approvalTitle(request, alice, '!45')).toBe('@alice approved !45');
    expect(approvalTitle(request, secBot, '!45')).toBe(
      '@duo-security-review-gitlab-org approved !45',
    );
  });

  test('summarizes readiness facts from forge metadata', () => {
    const details = approvalDetails(
      mr('45', {
        draft: true,
        conflicts: true,
        unresolvedThreads: 2,
        awaitingReviewers: ['bob'],
        pipeline: { status: 'RUNNING', label: 'running' },
      }),
    );
    expect(details).toEqual([
      'The MR is still a draft.',
      'The MR has merge conflicts.',
      '2 unresolved threads remain.',
      'Still awaiting review from @bob.',
      'The pipeline is still running.',
    ]);
    expect(
      approvalDetails(
        mr('45', {
          unresolvedThreads: 1,
          pipeline: {
            id: 'p1',
            status: 'FAILED',
            label: 'failed',
            failedJobs: [{ name: 'rspec' }],
          },
        }),
      ),
    ).toEqual(['1 unresolved thread remains.', 'The pipeline has failed jobs.']);
    expect(
      approvalDetails(
        mr('45', {
          conflicts: true,
          conflictsKnown: false,
        }),
      ),
    ).toEqual(['The MR mergeability is still being checked.']);
  });
});

describe('observeApprovals', () => {
  test('records the first lookup as a baseline without emitting events', () => {
    const records = run([[mr('1', { approvers: [duo, alice] })]]);
    expect(pendingIDs(records)).toEqual([]);
    expect(records.get(mr('1').url)?.approvers).toEqual(['id:alice-id', 'id:duo-id']);
    expect(records.get(mr('1').url)?.generation).toBeTruthy();
  });

  test('detects new approvals and increments cycle across unapprove and re-approve', () => {
    const records = run([
      [mr('1', { duoReviewState: 'REVIEW_STARTED', approvers: [] })],
      [mr('1', { duoReviewState: 'APPROVED', approvers: [duo], draft: true })],
      [mr('1', { duoReviewState: 'APPROVED', approvers: [duo], draft: true })],
    ]);
    const record = records.get(mr('1').url)!;
    const gen = record.generation!;
    expect(record.pending).toHaveLength(1);
    expect(record.pending[0]).toMatchObject({
      id: JSON.stringify(['one', mr('1').url, 'approval', gen, 'id:duo-id', 1]),
      title: 'GitLab Duo approved !1',
      details: ['The MR is still a draft.'],
    });

    let map = new Map<string, ApprovalRecord>([[record.url, { ...record, pending: [] }]]);
    const unapproved = observeApprovals(
      'one',
      [mr('1', { duoReviewState: 'REVIEW_STARTED', approvers: [] })],
      map,
      reference,
      4,
    );
    map = new Map([[unapproved[0].url, unapproved[0]]]);
    expect(unapproved[0].approvers).toEqual([]);
    expect(unapproved[0].pending).toEqual([]);

    const reapproved = observeApprovals(
      'one',
      [mr('1', { duoReviewState: 'APPROVED', approvers: [duo] })],
      map,
      reference,
      5,
    );
    expect(reapproved[0].pending.map((event) => event.id)).toEqual([
      JSON.stringify(['one', mr('1').url, 'approval', gen, 'id:duo-id', 2]),
    ]);
  });

  test('drops pending events when the reviewer unapproves or the MR closes', () => {
    const unapproved = run([
      [mr('1')],
      [mr('1', { approvers: [duo] })],
      [mr('1', { approvers: [] })],
    ]);
    expect(pendingIDs(unapproved)).toEqual([]);

    const closed = run([
      [mr('1')],
      [mr('1', { approvers: [duo] })],
      [mr('1', { state: 'merged', approvers: [duo] })],
    ]);
    expect(pendingIDs(closed)).toEqual([]);
  });

  test('ignores author self-approvals and filters by watches callback', () => {
    const selfApprover: ReviewerApproval = { id: 'author-1', username: 'me' };
    const records = run(
      [[mr('1')], [mr('1', { approvers: [selfApprover, duo, alice, secBot] })]],
      (_request, approver) => !!approver.automated || !!approver.bot,
      () => 'summary',
    );
    const pending = records.get(mr('1').url)!.pending;
    expect(pending.map((event) => event.approver.username)).toEqual([
      'GitLabDuo',
      'duo-security-review-gitlab-org',
    ]);
    expect(pending.every((event) => event.delivery === 'summary')).toBe(true);
  });

  test('waits for complete reviewer list before recording baseline or transitions', () => {
    const first = run([[mr('1', { reviewersComplete: false, approvers: [] })]]);
    expect(first.size).toBe(0);

    const preserved = run([
      [mr('1', { approvers: [alice] })],
      [mr('1', { reviewersComplete: false, approvers: [] })],
      [mr('1', { reviewersComplete: true, approvers: [alice] })],
    ]);
    expect(pendingIDs(preserved)).toEqual([]);
  });

  test('detects same-poll re-approval when reviewID changes without firing on unchanged tokens', () => {
    const first = { ...duo, reviewID: '2026-11-24T07:00:00Z' };
    const second = { ...duo, reviewID: '2026-11-24T07:10:00Z' };
    const unchanged = run([[mr('1', { approvers: [first] })], [mr('1', { approvers: [first] })]]);
    expect(pendingIDs(unchanged)).toEqual([]);

    const reapproved = run([[mr('1', { approvers: [first] })], [mr('1', { approvers: [second] })]]);
    const gen = reapproved.get(mr('1').url)!.generation!;
    expect(pendingIDs(reapproved)).toEqual([
      JSON.stringify(['one', mr('1').url, 'approval', gen, 'id:duo-id', 1]),
    ]);
    expect(reapproved.get(mr('1').url)?.tokens).toEqual({ 'id:duo-id': '2026-11-24T07:10:00Z' });

    // Upgrading from a stored record without `tokens` does not re-fire an existing approval.
    const legacy: ApprovalRecord = {
      sessionID: 'one',
      url: mr('1').url,
      reference: '!1',
      state: 'opened',
      approvers: ['gitlabduo'],
      cycles: {},
      pending: [],
      at: 1,
    };
    const upgraded = observeApprovals(
      'one',
      [mr('1', { approvers: [first] })],
      new Map([[legacy.url, legacy]]),
      reference,
      2,
    );
    expect(upgraded[0].pending).toEqual([]);
    expect(upgraded[0].tokens).toEqual({ 'id:duo-id': '2026-11-24T07:00:00Z' });
  });

  test('retains last seen review token across pending re-review so unchanged R1 does not re-fire while R2 does', () => {
    const r1: ReviewerApproval = {
      id: 'B_COPILOT',
      username: 'copilot-pull-request-reviewer[bot]',
      bot: true,
      automated: true,
      reviewID: 'R1',
    };
    const r2: ReviewerApproval = { ...r1, reviewID: 'R2' };
    // Baseline -> approved R1 -> pending re-review (suppressed) -> COMMENTED/canceled with R1 reappearing.
    const sameReview = run([
      [mr('1', { approvers: [r1] })],
      [mr('1', { approvers: [] })],
      [mr('1', { approvers: [r1] })],
    ]);
    expect(pendingIDs(sameReview)).toEqual([]);

    // Same sequence ending in a genuinely new approval R2 emits one event.
    const newReview = run([
      [mr('1', { approvers: [r1] })],
      [mr('1', { approvers: [] })],
      [mr('1', { approvers: [r2] })],
    ]);
    expect(pendingIDs(newReview)).toHaveLength(1);
    expect(newReview.get(mr('1').url)?.pending[0]?.approver.reviewID).toBe('R2');
  });

  test('keys transitions by immutable account ID across reviewer renames and username reuse', () => {
    const original: ReviewerApproval = { id: 'U_1', username: 'alice', reviewID: 'R1' };
    const renamedSameToken: ReviewerApproval = {
      id: 'U_1',
      username: 'alice-renamed',
      reviewID: 'R1',
    };
    const renamedNewToken: ReviewerApproval = {
      id: 'U_1',
      username: 'alice-renamed',
      reviewID: 'R2',
    };
    // Same account ID with a new login and same token -> zero new deliveries.
    const afterRename = run([
      [mr('1', { approvers: [original] })],
      [mr('1', { approvers: [renamedSameToken] })],
    ]);
    expect(pendingIDs(afterRename)).toEqual([]);

    // Genuinely new token after rename -> one delivery.
    const afterNewToken = run([
      [mr('1', { approvers: [original] })],
      [mr('1', { approvers: [renamedSameToken] })],
      [mr('1', { approvers: [renamedNewToken] })],
    ]);
    expect(pendingIDs(afterNewToken)).toHaveLength(1);

    // Different account ID acquiring the old username (tokenless) -> one new delivery.
    const tokenlessOriginal: ReviewerApproval = { id: 'U_1', username: 'alice' };
    const tokenlessDifferentID: ReviewerApproval = { id: 'U_2', username: 'alice' };
    const reused = run([
      [mr('1', { approvers: [tokenlessOriginal] })],
      [mr('1', { approvers: [tokenlessDifferentID] })],
    ]);
    expect(pendingIDs(reused)).toHaveLength(1);
    expect(reused.get(mr('1').url)?.pending[0]?.approver.id).toBe('U_2');
  });

  test('compares records ignoring write time', () => {
    const [a] = observeApprovals(
      'one',
      [mr('1')],
      new Map(),
      reference,
      1,
      undefined,
      undefined,
      () => 'gen-1',
    );
    const [b] = observeApprovals(
      'one',
      [mr('1')],
      new Map(),
      reference,
      2,
      undefined,
      undefined,
      () => 'gen-1',
    );
    expect(unchangedApproval(a, b)).toBe(true);
    expect(unchangedApproval(a, { ...b, approvers: ['id:alice-id'] })).toBe(false);
    expect(unchangedApproval(undefined, b)).toBe(false);
  });
});

describe('createApprovalWatcher', () => {
  function harness(deliver: (record: ApprovalRecord, event: ApprovalEvent) => Promise<void>) {
    const stored = new Map<string, ApprovalRecord>();
    const writes: ApprovalRecord[] = [];
    const watcher = createApprovalWatcher({
      records: async (sessionID) =>
        [...stored.values()].filter((record) => record.sessionID === sessionID),
      write: async (record) => {
        writes.push(structuredClone(record));
        stored.set(record.url, structuredClone(record));
      },
      waiting: async () => [...stored.values()].filter((record) => record.pending.length),
      deliver,
      reference,
      now: () => 1,
    });
    return { watcher, stored, writes };
  }

  test('stores events before delivery, skips unchanged writes, and retries failed deliveries', async () => {
    let fail = true;
    const delivered: string[] = [];
    const app = harness(async (_record, event) => {
      if (fail) throw new Error('paused');
      delivered.push(event.id);
    });
    await app.watcher.observe('one', [mr('1')]);
    expect(app.writes).toHaveLength(1);
    await app.watcher.observe('one', [mr('1')]);
    expect(app.writes).toHaveLength(1);

    await expect(app.watcher.observe('one', [mr('1', { approvers: [duo] })])).rejects.toThrow(
      'paused',
    );
    expect(app.stored.get(mr('1').url)?.pending).toHaveLength(1);
    expect(delivered).toEqual([]);

    fail = false;
    await app.watcher.retry();
    const gen = app.stored.get(mr('1').url)!.generation!;
    expect(delivered).toEqual([
      JSON.stringify(['one', mr('1').url, 'approval', gen, 'id:duo-id', 1]),
    ]);
    expect(app.stored.get(mr('1').url)?.pending).toEqual([]);
  });

  test('reconciles a revocation observed during retry into the baseline so tokenless reapproval still fires', async () => {
    const stored = new Map<string, ApprovalRecord>();
    let live: ReviewRequest = mr('1', { approvers: [] });
    let fail = true;
    const delivered: string[] = [];
    const watcher = createApprovalWatcher({
      records: async (sessionID) =>
        [...stored.values()].filter((record) => record.sessionID === sessionID),
      write: async (record) => void stored.set(record.url, structuredClone(record)),
      waiting: async () => [...stored.values()].filter((record) => record.pending.length),
      deliver: async (_record, event, fresh) => {
        if (fail) throw new Error('storage busy');
        const current = fresh ?? live;
        if (!current.approvers?.some((approver) => approver.id === event.approver.id)) {
          return { reconcile: current };
        }
        delivered.push(event.id);
      },
      reference,
      now: () => 1,
    });
    // Baseline -> Duo approves (tokenless) -> delivery fails.
    await watcher.observe('one', [mr('1', { approvers: [] })]);
    await expect(watcher.observe('one', [mr('1', { approvers: [duo] })])).rejects.toThrow(
      'storage busy',
    );
    expect(delivered).toEqual([]);

    // Retry observes Duo revoked -> reconciles baseline so `id:duo-id` is removed.
    fail = false;
    live = mr('1', { approvers: [] });
    await watcher.retry();
    expect(delivered).toEqual([]);
    expect(stored.get(mr('1').url)?.approvers).toEqual([]);

    // Duo reapproves before the next poll -> cycle 2 delivers!
    live = mr('1', { approvers: [duo] });
    await watcher.observe('one', [live]);
    expect(delivered).toHaveLength(1);
    expect(stored.get(mr('1').url)?.cycles['id:duo-id']).toBe(2);
  });

  test('retire removes target baseline and pending events so re-adding baselines silently with a new generation', async () => {
    const stored = new Map<string, ApprovalRecord>();
    const delivered: string[] = [];
    const retiredReceipts: string[] = [];
    const watcher = createApprovalWatcher({
      records: async (sessionID) =>
        [...stored.values()].filter((record) => record.sessionID === sessionID),
      write: async (record) => void stored.set(record.url, structuredClone(record)),
      remove: async (record) => void stored.delete(record.url),
      retired: async (ids) => void retiredReceipts.push(...ids),
      waiting: async () => [...stored.values()].filter((record) => record.pending.length),
      deliver: async (_record, event) => void delivered.push(event.id),
      reference,
      now: () => 1,
    });
    await watcher.observe('one', [mr('1', { approvers: [] })]);
    const firstGen = stored.get(mr('1').url)!.generation!;
    await watcher.observe('one', [mr('1', { approvers: [duo] })]);
    expect(delivered).toHaveLength(1);
    expect(retiredReceipts).toEqual(delivered);

    // Explicit target removal retires baseline; approval made while unwatched does not fire on re-add.
    await watcher.retire('one', () => false);
    expect(stored.size).toBe(0);

    await watcher.observe('one', [mr('1', { approvers: [alice] })]);
    expect(delivered).toHaveLength(1);
    const secondGen = stored.get(mr('1').url)!.generation!;
    expect(secondGen).not.toBe(firstGen);

    // Next new approval from Duo uses the new generation and delivers cleanly.
    await watcher.observe('one', [mr('1', { approvers: [alice, duo] })]);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).not.toBe(delivered[0]);
  });

  test('serializes concurrent observations per session', async () => {
    const delivered: string[] = [];
    const app = harness(async (_record, event) => {
      delivered.push(event.id);
    });
    await app.watcher.observe('one', [mr('1')]);
    await Promise.all([
      app.watcher.observe('one', [mr('1', { approvers: [duo] })]),
      app.watcher.observe('one', [mr('1', { approvers: [duo] })]),
      app.watcher.retry(),
    ]);
    expect(delivered).toHaveLength(1);
  });
});

describe('settledFeedback for approvals', () => {
  const item = {
    url: mr('1').url,
    kind: 'approval' as const,
    reviewers: ['GitLabDuo'],
  };

  test('clears when the reviewer no longer approves or the MR is no longer open', () => {
    expect(
      settledFeedback(item, { kind: 'found', requests: [mr('1', { approvers: [duo] })] }),
    ).toBe(false);
    expect(settledFeedback(item, { kind: 'found', requests: [mr('1', { approvers: [] })] })).toBe(
      true,
    );
    expect(
      settledFeedback(item, {
        kind: 'found',
        requests: [mr('1', { state: 'merged', approvers: [duo] })],
      }),
    ).toBe(true);
    expect(
      settledFeedback(item, {
        kind: 'found',
        requests: [mr('1', { reviewersComplete: false, approvers: [] })],
      }),
    ).toBe(false);
  });
});

describe('approval record pruning', () => {
  test('preserves expired approval baselines when storedTargets fails or still targets the MR', async () => {
    const urlA = mr('1').url;
    const urlB = mr('2').url;
    const urlC = mr('3').url;
    const store = new Map<string, unknown>([
      [
        `status/approvals/s1/${encodeURIComponent(urlA)}`,
        {
          sessionID: 's1',
          url: urlA,
          reference: '!1',
          state: 'opened',
          approvers: ['gitlabduo'],
          cycles: {},
          pending: [],
          at: 0,
        } satisfies ApprovalRecord,
      ],
      [
        `status/approvals/s2/${encodeURIComponent(urlB)}`,
        {
          sessionID: 's2',
          url: urlB,
          reference: '!2',
          state: 'opened',
          approvers: ['gitlabduo'],
          cycles: {},
          pending: [],
          at: 0,
        } satisfies ApprovalRecord,
      ],
      [
        `status/approvals/s3/${encodeURIComponent(urlC)}`,
        {
          sessionID: 's3',
          url: urlC,
          reference: '!3',
          state: 'opened',
          approvers: ['gitlabduo'],
          cycles: {},
          pending: [],
          at: 0,
        } satisfies ApprovalRecord,
      ],
    ]);
    const storage = {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async () => ({ entries: [] }),
    } as unknown as Plugin.Context['storage'];
    const monitoring = createReviewMonitoring(
      storage,
      statusOptions({ inbox: true }),
      {
        current: async () => [],
        isTarget: () => true,
        storedTargets: async (sessionID) => {
          if (sessionID === 's1') throw new Error('storage busy');
          if (sessionID === 's2') return [{ kind: 'merge-request', url: urlB }];
          return [];
        },
        fetch: async () => undefined,
        reviewRequests: async () => undefined,
        interval: () => 60_000,
        accepted: () => {},
        scan: async (prefix) =>
          [...store.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, value })),
        write: () => {},
        record: async () => {},
        notice: () => {},
        error: () => {},
      },
      () => APPROVAL_RETENTION + 1,
    );

    await monitoring.prune();
    expect(store.has(`status/approvals/s1/${encodeURIComponent(urlA)}`)).toBe(true);
    expect(store.has(`status/approvals/s2/${encodeURIComponent(urlB)}`)).toBe(true);
    expect(store.has(`status/approvals/s3/${encodeURIComponent(urlC)}`)).toBe(false);
  });

  test('retires pending approval records for confirmed deleted sessions while keeping foreign and transient failures', async () => {
    const urlA = mr('1').url;
    const urlB = mr('2').url;
    const pendingRecord = (sessionID: string, url: string): ApprovalRecord => ({
      sessionID,
      url,
      reference: '!1',
      state: 'opened',
      approvers: ['gitlabduo'],
      cycles: { gitlabduo: 1 },
      pending: [
        {
          id: JSON.stringify([sessionID, url, 'approval', 'gitlabduo', 1]),
          cycle: 1,
          detectedAt: 1,
          approver: duo,
          title: 'GitLab Duo approved !1',
        },
      ],
      at: 1,
    });
    const store = new Map<string, unknown>([
      [`status/approvals/deleted/${encodeURIComponent(urlA)}`, pendingRecord('deleted', urlA)],
      [`status/approvals/foreign/${encodeURIComponent(urlB)}`, pendingRecord('foreign', urlB)],
    ]);
    const storage = {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async () => ({ entries: [] }),
    } as unknown as Plugin.Context['storage'];
    const monitoring = createReviewMonitoring(storage, statusOptions({ inbox: true }), {
      current: async () => [],
      isTarget: () => true,
      sessionOwnership: async () => ({ here: [], deleted: ['deleted'] }),
      fetch: async () => undefined,
      reviewRequests: async () => undefined,
      interval: () => 60_000,
      accepted: () => {},
      scan: async (prefix) =>
        [...store.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      write: () => {},
      record: async () => true,
      notice: () => {},
      error: () => {},
    });

    await monitoring.approvals?.retry();
    expect(store.has(`status/approvals/deleted/${encodeURIComponent(urlA)}`)).toBe(false);
    expect(store.has(`status/approvals/foreign/${encodeURIComponent(urlB)}`)).toBe(true);
  });

  test('does not resurrect an approval if the target is removed while viewerID resolves', async () => {
    const urlA = mr('1').url;
    const store = new Map<string, unknown>();
    const storage = {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async () => ({ entries: [] }),
    } as unknown as Plugin.Context['storage'];
    let targeted = true;
    let viewerStarted!: () => void;
    const viewerCalled = new Promise<void>((resolve) => (viewerStarted = resolve));
    let releaseViewer!: () => void;
    const recorded: unknown[] = [];
    const notices: unknown[] = [];
    const monitoring = createReviewMonitoring(storage, statusOptions({ inbox: true }), {
      current: async () => [],
      isTarget: () => targeted,
      targets: async () => (targeted ? [{ kind: 'merge-request', url: urlA }] : undefined),
      viewerID: () => {
        viewerStarted();
        return new Promise<string | undefined>((resolve) => {
          releaseViewer = () => resolve('viewer-id');
        });
      },
      fetch: async () => undefined,
      reviewRequests: async () => undefined,
      interval: () => 60_000,
      accepted: () => {},
      scan: async (prefix) =>
        [...store.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      write: () => {},
      record: async (item) => {
        recorded.push(item);
        return true;
      },
      notice: (value) => void notices.push(value),
      error: () => {},
    });

    await monitoring.approvals?.observe('one', [mr('1', { approvers: [] })]);
    const pending = monitoring.approvals?.observe('one', [mr('1', { approvers: [alice] })]);
    await viewerCalled;
    targeted = false;
    releaseViewer();
    await pending;
    expect(recorded).toEqual([]);
    expect(notices).toEqual([]);
  });

  test('settledFeedback clears approval items when approvalToken is replaced and defers when approvalsComplete is false', () => {
    const item = {
      url: mr('1').url,
      kind: 'approval' as const,
      reviewers: ['GitLabDuo'],
      approverKind: 'automated' as const,
      approverID: 'duo-id',
      approvalToken: '2026-11-24T07:00:00Z',
    };
    expect(
      settledFeedback(item, {
        kind: 'found',
        requests: [mr('1', { approvers: [{ ...duo, reviewID: '2026-11-24T07:00:00Z' }] })],
      }),
    ).toBe(false);
    expect(
      settledFeedback(item, {
        kind: 'found',
        requests: [mr('1', { approvers: [{ ...duo, reviewID: '2026-11-24T08:00:00Z' }] })],
      }),
    ).toBe(true);
    expect(
      settledFeedback(item, {
        kind: 'found',
        requests: [mr('1', { approvalsComplete: false, approvers: [] })],
      }),
    ).toBe(false);
  });
});
