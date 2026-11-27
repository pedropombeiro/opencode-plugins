import { describe, expect, test } from 'bun:test';
import type { GitLabIssueSnapshot, IssueSnapshot } from './forge';
import {
  child,
  harness,
  projectA,
  settle,
  StatusForge,
  textOf,
  watchedFeedback,
  watchedTargets,
} from './server-harness';
import { deferred } from './testing';

describe('PR/MR status lifecycle', () => {
  test('announces a target that starts to conflict, once, and clears it once the conflict ends', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const { app } = await watchedTargets([projectA], { status: forge });
    expect((await app.feedback()).items).toEqual([]);
    forge.set('group/a', '1', { conflicts: true });
    await app.refresh();
    await settle();
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toMatchObject([
      { kind: 'conflict', url: projectA, title: '!1 can no longer merge: it conflicts with main' },
    ]);
    // The inbox mode, the default, posts nothing to the session.
    expect(app.passive).toEqual([]);
    forge.set('group/a', '1', { conflicts: false });
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toEqual([]);
    await app.cleanup();
  });

  test('keeps GitLab changes requested independently of merge blockers and approval rules', async () => {
    const { GitLabForge } = await import('./adapters/gitlab/adapter');
    let mergeStatus = 'MERGEABLE';
    let incomplete = false;
    const reviewers = new Map([['alice', 'UNREVIEWED']]);
    const pageInfo = { hasNextPage: false, endCursor: null };
    const forge = new GitLabForge(async () => ({
      p0: {
        mergeRequest: {
          iid: '1',
          title: 'An MR',
          webUrl: projectA,
          state: 'opened',
          draft: false,
          conflicts: false,
          approved: true,
          approvalsRequired: 0,
          detailedMergeStatus: mergeStatus,
          targetProject: { fullPath: 'group/a' },
          targetBranch: 'main',
          reviewers: {
            nodes: [...reviewers].map(([username, reviewState]) => ({
              id: username,
              username,
              type: 'HUMAN',
              bot: false,
              mergeRequestInteraction: { reviewState, approved: reviewState === 'APPROVED' },
            })),
            pageInfo: { ...pageInfo, hasNextPage: incomplete },
          },
          approvedBy: { nodes: [], pageInfo },
          discussions: { nodes: [], pageInfo },
        },
      },
    }));
    const { app } = await watchedTargets([projectA], { status: forge });
    const refresh = async () => {
      await app.refresh();
      await settle();
      return (await app.feedback()).items.filter((item) => item.kind === 'changes-requested');
    };
    reviewers.set('alice', 'REQUESTED_CHANGES');
    mergeStatus = 'REQUESTED_CHANGES';
    const original = await refresh();
    expect(original).toMatchObject([
      { kind: 'changes-requested', url: projectA, title: '!1: a reviewer requested changes' },
    ]);
    for (mergeStatus of ['MERGE_REQUEST_BLOCKED', 'CI_STILL_RUNNING', 'REQUESTED_CHANGES']) {
      expect(await refresh()).toEqual(original);
    }
    incomplete = true;
    reviewers.set('bob', 'REQUESTED_CHANGES');
    expect(await refresh()).toEqual(original);
    incomplete = false;
    reviewers.set('alice', 'UNREVIEWED');
    expect(await refresh()).toEqual(original);
    expect(app.passive).toEqual([]);
    reviewers.set('bob', 'APPROVED');
    mergeStatus = 'MERGEABLE';
    incomplete = true;
    expect(await refresh()).toEqual(original);
    incomplete = false;
    expect(await refresh()).toEqual([]);
    reviewers.set('alice', 'REQUESTED_CHANGES');
    const next = await refresh();
    expect(next).toHaveLength(1);
    expect(next[0].id).not.toBe(original[0].id);
    await app.cleanup();
  });

  test('matches GitHub re-review requests to the requester without reannouncing an old review', async () => {
    const { GitHubForge } = await import('./adapters/github/adapter');
    const url = 'https://github.com/group/a/pull/1';
    const account = (login: string) => ({ __typename: 'User', id: `user:${login}`, login });
    const team = { requestedReviewer: { __typename: 'Team', name: 'alice' } };
    let pending = [{ requestedReviewer: account('bob') }, team];
    let reviewID: string | undefined;
    let incomplete = false;
    const pageInfo = { hasNextPage: false, endCursor: null };
    const forge = new GitHubForge(async () => ({
      repository: {
        pullRequest: {
          number: 1,
          title: 'A PR',
          url,
          state: 'OPEN',
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: reviewID ? 'CHANGES_REQUESTED' : 'REVIEW_REQUIRED',
          baseRepository: { nameWithOwner: 'group/a' },
          baseRefName: 'main',
          reviewRequests: { nodes: pending, pageInfo },
          latestOpinionatedReviews: {
            nodes: reviewID
              ? [{ id: reviewID, state: 'CHANGES_REQUESTED', author: account('alice') }]
              : [],
            pageInfo: { ...pageInfo, hasNextPage: incomplete },
          },
          reviewThreads: { nodes: [], pageInfo },
          commits: { nodes: [] },
        },
      },
    }));
    const { app } = await watchedTargets([url], { status: forge });
    const refresh = async () => {
      await app.refresh();
      await settle();
      return (await app.feedback()).items;
    };
    reviewID = 'first';
    const original = await refresh();
    expect(original).toMatchObject([{ kind: 'changes-requested', url }]);
    pending = [team];
    expect(await refresh()).toEqual(original);
    incomplete = true;
    pending = [{ requestedReviewer: account('alice') }, team];
    expect(await refresh()).toEqual(original);
    incomplete = false;
    pending = [{ requestedReviewer: account('alice') }];
    expect(await refresh()).toEqual([]);
    pending = [];
    expect(await refresh()).toEqual([]);
    reviewID = 'second';
    const next = await refresh();
    expect(next).toMatchObject([{ kind: 'changes-requested', url }]);
    expect(next[0].id).not.toBe(original[0].id);
    await app.cleanup();
  });

  test('announces what its issue has wrong, once, and again when a new problem appears', async () => {
    const issueUrl = 'https://gitlab.com/group/a/-/issues/9';
    const complete: GitLabIssueSnapshot = {
      forge: 'gitlab',
      open: true,
      status: 'In review',
      assignees: ['me'],
      labels: ['group::dh', 'bug::ux'],
      milestone: '19.7',
      availableStatuses: ['In dev', 'In review'],
      hasActiveMilestones: true,
    };
    const forge = new StatusForge();
    forge.set('group/a', '1');
    forge.issues.set('group/a#9', { ...complete, status: 'In dev', milestone: undefined });
    const app = await harness({ status: forge });
    await app.set({ target: projectA, issue_url: issueUrl });
    await app.watch(['one'], 'one');
    await settle();
    const [item] = (await app.feedback()).items;
    expect(item).toMatchObject({
      kind: 'issue-outdated',
      url: projectA,
      title: 'Issue #9 may be outdated after !1',
      links: [issueUrl, projectA],
    });
    expect(item.details?.join('\n')).toContain('the status is "In dev", expected "In review"');
    expect(item.details?.join('\n')).toContain('no milestone');
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toHaveLength(1);
    forge.issues.set('group/a#9', { ...complete, status: 'In dev', assignees: [] });
    forge.set('group/a', '1', { draft: true });
    await app.refresh();
    await settle();
    expect((await app.feedback()).items.map((entry) => entry.details?.[0])).toEqual([
      expect.stringContaining('no assignee'),
      expect.stringContaining('expected "In review"'),
    ]);
    await app.cleanup();
  });

  test('reads no issue when issue watching is off', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    forge.issues.set('group/a#9', { forge: 'gitlab', open: true, assignees: [], labels: [] });
    const app = await harness({ status: forge, pluginOptions: { watch: { issues: false } } });
    await app.set({ target: projectA, issue_url: 'https://gitlab.com/group/a/-/issues/9' });
    await app.watch(['one'], 'one');
    await settle();
    expect(forge.issueReads).toEqual([]);
    expect((await app.feedback()).items).toEqual([]);
    await app.cleanup();
  });

  const issueUrl = 'https://gitlab.com/group/a/-/issues/9';
  const completeIssue: GitLabIssueSnapshot = {
    forge: 'gitlab',
    open: true,
    status: 'In review',
    assignees: ['me'],
    labels: ['group::dh', 'bug::ux'],
    milestone: '19.7',
    availableStatuses: ['In dev', 'In review'],
    hasActiveMilestones: true,
  };
  const issueUpdates = async (app: Awaited<ReturnType<typeof harness>>) =>
    (await app.feedback()).items.filter((item) => item.kind === 'issue-outdated');

  test.each([
    [projectA, child],
    [child, projectA],
  ])(
    'announces the last tracked merge once and retains the warning after refresh (%s, %s)',
    async (first, second) => {
      const forge = new StatusForge();
      forge.set('group/a', '1');
      forge.set('group/a', '2');
      forge.issues.set('group/a#9', { ...completeIssue, milestone: undefined });
      const app = await harness({ status: forge });
      try {
        await app.set({ targets: [first, second], issue_url: issueUrl });
        await app.watch(['one'], 'one');
        await settle();
        const initial = await issueUpdates(app);
        expect(initial).toHaveLength(1);
        await app.acknowledgeFeedback(initial[0].id);
        forge.set('group/a', '1', { state: 'merged' });
        await app.refresh();
        await settle();
        expect(await issueUpdates(app)).toEqual([]);
        forge.set('group/a', '2', { state: 'merged' });
        await app.refresh();
        await settle();
        const updates = await issueUpdates(app);
        expect(updates).toHaveLength(1);
        expect(updates[0]).toMatchObject({ url: child, links: [issueUrl, child] });
        expect(updates[0].details?.[0]).toContain('all MRs this session tracks');
        await app.refresh();
        await settle();
        expect(await issueUpdates(app)).toEqual(updates);
      } finally {
        await app.cleanup();
      }
    },
  );

  test('announces a new issue after a failed first read on an existing MR record', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const app = await harness({ status: forge });
    try {
      await app.set({ target: projectA });
      await app.watch(['one'], 'one');
      await settle();
      await app.set({ target: projectA, issue_url: issueUrl });
      await app.refresh();
      await settle();
      expect(forge.issueReads).toContain('9');
      expect(await issueUpdates(app)).toEqual([]);
      const incomplete = { ...completeIssue, milestone: undefined };
      forge.issues.set('group/a#9', incomplete);
      await app.refresh();
      await settle();
      expect((await issueUpdates(app)).map((item) => item.links[0])).toEqual([issueUrl]);

      const otherUrl = issueUrl.replace('/9', '/10');
      forge.issues.set('group/a#10', incomplete);
      await app.set({ target: projectA, issue_url: otherUrl });
      await app.refresh();
      await settle();
      expect((await issueUpdates(app)).map((item) => item.links[0])).toContain(otherUrl);

      forge.issues.set('group/a#10', completeIssue);
      forge.set('group/a', '1', { draft: true });
      await app.refresh();
      await settle();
      forge.issues.set('group/a#10', incomplete);
      forge.set('group/a', '1', { draft: false });
      await app.refresh();
      await settle();
      expect((await issueUpdates(app)).filter((item) => item.links[0] === otherUrl)).toHaveLength(
        2,
      );
    } finally {
      await app.cleanup();
    }
  });

  test('retries a failed final-merge issue read after reload without another status refresh', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    forge.issues.set('group/a#9', completeIssue);
    const storage = new Map<string, unknown>();
    const app = await harness({ status: forge, storage });
    const issue = forge.issue.bind(forge);
    try {
      await app.set({ target: projectA, issue_url: issueUrl });
      await app.watch(['one'], 'one');
      await settle();
      forge.issue = async () => {
        throw new Error('Issue lookup unavailable');
      };
      forge.set('group/a', '1', { state: 'merged' });
      await app.refresh();
      await settle();
      expect((await app.feedback()).items.map((item) => item.kind)).toEqual(['merged']);
    } finally {
      await app.cleanup();
    }
    forge.issue = issue;
    const reloaded = await harness({ status: forge, storage });
    try {
      await settle();
      expect((await issueUpdates(reloaded))[0]?.details?.[0]).toContain(
        'all MRs this session tracks',
      );
    } finally {
      await reloaded.cleanup();
    }
  });

  test.each(['closed', 'unresolved', 'merged'])(
    'does not announce an all-merged issue for an unconfirmed group (%s)',
    async (state) => {
      const forge = new StatusForge();
      forge.set('group/a', '1', { state: state === 'merged' ? 'merged' : 'opened' });
      if (state !== 'unresolved') forge.set('group/a', '2', { state });
      forge.issues.set('group/a#9', completeIssue);
      const app = await harness({ status: forge });
      try {
        await app.set({ targets: [projectA, child], issue_url: issueUrl });
        await app.watch(['one'], 'one');
        await settle();
        forge.set('group/a', '1', { state: 'merged' });
        await app.refresh();
        await settle();
        expect(await issueUpdates(app)).toEqual([]);
      } finally {
        await app.cleanup();
      }
    },
  );

  const ghPr41 = 'https://github.com/acme/app/pull/41';
  const ghPr42 = 'https://github.com/acme/app/pull/42';
  const ghPr43 = 'https://github.com/acme/app/pull/43';
  const ghIssueUrl = 'https://github.com/acme/platform/issues/9';
  const ghOpenIssue = (url = ghIssueUrl): IssueSnapshot => ({ forge: 'github', open: true, url });
  const ghClosedIssue = (url = ghIssueUrl): IssueSnapshot => ({
    forge: 'github',
    open: false,
    url,
  });

  test.each([
    [ghPr41, ghPr42],
    [ghPr42, ghPr41],
  ])(
    'checks a GitHub issue only on the final tracked PR merge and retains the warning (%s, %s)',
    async (first, second) => {
      const forge = new StatusForge('github');
      forge.setPR('acme/app', '41');
      forge.setPR('acme/app', '42');
      forge.issues.set('acme/platform#9', ghOpenIssue());
      const app = await harness({ status: forge });
      try {
        await app.set({ targets: [first, second], issue_url: ghIssueUrl });
        await app.watch(['one'], 'one');
        await settle();
        expect(forge.lookups.length).toBeGreaterThan(0);
        expect(forge.issueReadTargets).toEqual([]);

        forge.setPR('acme/app', '41', { draft: true, title: 'WIP' });
        await app.refresh();
        await settle();
        expect(forge.issueReadTargets).toEqual([]);

        forge.setPR('acme/app', '41', { state: 'merged' });
        await app.refresh();
        await settle();
        expect(forge.issueReadTargets).toEqual([]);
        expect((await app.feedback()).items.map((item) => item.kind)).toEqual(['merged']);

        forge.setPR('acme/app', '42', { state: 'merged' });
        await app.refresh();
        await settle();
        expect(forge.issueReadTargets).toEqual(['acme/platform#9']);
        const updates = await issueUpdates(app);
        expect(updates).toHaveLength(1);
        expect(updates[0]).toMatchObject({
          kind: 'issue-outdated',
          url: ghPr42,
          title: 'Issue acme/platform#9 may be outdated after #42',
          links: [ghIssueUrl, ghPr42],
          details: [
            'All PRs this session tracks for acme/platform#9 have merged, but the issue is still open.',
            'Tell the user what you would change in the issue, and wait for their approval before editing it.',
          ],
        });
        expect((await app.feedback()).items.filter((item) => item.kind === 'merged')).toHaveLength(
          2,
        );

        await app.refresh();
        await settle();
        expect(forge.issueReadTargets).toEqual(['acme/platform#9']);
        expect((await issueUpdates(app)).map((item) => item.id)).toEqual([updates[0].id]);

        forge.setPR('acme/app', '43');
        await app.set({ targets: [ghPr43], operation: 'add', issue_url: ghIssueUrl });
        await app.refresh();
        await settle();
        expect(forge.issueReadTargets).toEqual(['acme/platform#9']);
        expect((await issueUpdates(app)).map((item) => item.id)).toEqual([updates[0].id]);

        forge.setPR('acme/app', '43', { state: 'merged' });
        await app.refresh();
        await settle();
        expect(forge.issueReadTargets).toEqual(['acme/platform#9', 'acme/platform#9']);
        const followUp = await issueUpdates(app);
        expect(followUp).toHaveLength(2);
        expect(followUp.find((item) => item.id !== updates[0].id)).toMatchObject({
          kind: 'issue-outdated',
          url: ghPr43,
          title: 'Issue acme/platform#9 may be outdated after #43',
          links: [ghIssueUrl, ghPr43],
        });
      } finally {
        await app.cleanup();
      }
    },
  );

  test('stays silent when a GitHub issue is closed, already merged, or the last open PR is dropped', async () => {
    const closedForge = new StatusForge('github');
    closedForge.setPR('acme/app', '41');
    closedForge.setPR('acme/app', '42');
    closedForge.issues.set('acme/platform#9', ghClosedIssue());
    const closedApp = await harness({ status: closedForge });
    try {
      await closedApp.set({ targets: [ghPr41, ghPr42], issue_url: ghIssueUrl });
      await closedApp.watch(['one'], 'one');
      await settle();
      closedForge.setPR('acme/app', '41', { state: 'merged' });
      await closedApp.refresh();
      await settle();
      closedForge.setPR('acme/app', '42', { state: 'merged' });
      await closedApp.refresh();
      await settle();
      expect(closedForge.issueReadTargets).toEqual(['acme/platform#9']);
      expect(await issueUpdates(closedApp)).toEqual([]);
      expect(
        (await closedApp.feedback()).items.filter((item) => item.kind === 'merged'),
      ).toHaveLength(2);
    } finally {
      await closedApp.cleanup();
    }

    const discoveredForge = new StatusForge('github');
    discoveredForge.setPR('acme/app', '41', { state: 'merged' });
    discoveredForge.setPR('acme/app', '42', { state: 'merged' });
    discoveredForge.issues.set('acme/platform#9', ghOpenIssue());
    const discoveredApp = await harness({ status: discoveredForge });
    try {
      await discoveredApp.set({ targets: [ghPr41, ghPr42], issue_url: ghIssueUrl });
      await discoveredApp.watch(['one'], 'one');
      await settle();
      expect(discoveredForge.issueReadTargets).toEqual([]);
      expect(await issueUpdates(discoveredApp)).toEqual([]);
    } finally {
      await discoveredApp.cleanup();
    }

    const droppedForge = new StatusForge('github');
    droppedForge.setPR('acme/app', '41');
    droppedForge.setPR('acme/app', '42');
    droppedForge.issues.set('acme/platform#9', ghOpenIssue());
    const droppedApp = await harness({ status: droppedForge });
    try {
      await droppedApp.set({ targets: [ghPr41, ghPr42], issue_url: ghIssueUrl });
      await droppedApp.watch(['one'], 'one');
      await settle();
      droppedForge.setPR('acme/app', '41', { state: 'merged' });
      await droppedApp.refresh();
      await settle();
      await droppedApp.set({ targets: [ghPr42], operation: 'remove' });
      await droppedApp.refresh();
      await settle();
      expect(droppedForge.issueReadTargets).toEqual([]);
      expect(await issueUpdates(droppedApp)).toEqual([]);
    } finally {
      await droppedApp.cleanup();
    }
  });

  test('does not read a GitHub issue when a sibling closed unmerged or had a failed lookup, and handles recovery', async () => {
    const closedSibling = new StatusForge('github');
    closedSibling.setPR('acme/app', '41');
    closedSibling.setPR('acme/app', '42', { state: 'closed' });
    closedSibling.issues.set('acme/platform#9', ghOpenIssue());
    const closedApp = await harness({ status: closedSibling });
    try {
      await closedApp.set({ targets: [ghPr41, ghPr42], issue_url: ghIssueUrl });
      await closedApp.watch(['one'], 'one');
      await settle();
      closedSibling.setPR('acme/app', '41', { state: 'merged' });
      await closedApp.refresh();
      await settle();
      expect(closedSibling.issueReadTargets).toEqual([]);
      expect(await issueUpdates(closedApp)).toEqual([]);
    } finally {
      await closedApp.cleanup();
    }

    for (const recoveredState of ['opened', 'merged'] as const) {
      const forge = new StatusForge('github');
      forge.setPR('acme/app', '41');
      forge.setPR('acme/app', '42', { state: 'merged' });
      forge.issues.set('acme/platform#9', ghOpenIssue());
      const app = await harness({ status: forge });
      try {
        await app.set({ targets: [ghPr41, ghPr42], issue_url: ghIssueUrl });
        await app.watch(['one'], 'one');
        await settle();
        forge.failingLookups.add('acme/app!42');
        forge.setPR('acme/app', '41', { state: 'merged' });
        await app.refresh();
        await settle();
        expect(forge.issueReadTargets).toEqual([]);
        expect(await issueUpdates(app)).toEqual([]);

        forge.failingLookups.delete('acme/app!42');
        forge.setPR('acme/app', '42', { state: recoveredState });
        await app.refresh();
        await settle();
        if (recoveredState === 'opened') {
          expect(forge.issueReadTargets).toEqual([]);
          expect(await issueUpdates(app)).toEqual([]);

          await app.set({ targets: [ghPr42], operation: 'remove' });
          await app.refresh();
          await settle();
          expect(forge.issueReadTargets).toEqual([]);
          expect(await issueUpdates(app)).toEqual([]);
        } else {
          expect(forge.issueReadTargets).toEqual(['acme/platform#9']);
          expect(await issueUpdates(app)).toMatchObject([
            { url: ghPr41, links: [ghIssueUrl, ghPr41] },
          ]);
        }
      } finally {
        await app.cleanup();
      }
    }

    const partialForge = new StatusForge('github');
    partialForge.setPR('acme/app', '41');
    partialForge.setPR('acme/app', '42', { state: 'closed' });
    partialForge.setPR('acme/app', '43', { state: 'merged' });
    partialForge.issues.set('acme/platform#9', ghOpenIssue());
    const partialApp = await harness({ status: partialForge });
    try {
      await partialApp.set({ targets: [ghPr41, ghPr42, ghPr43], issue_url: ghIssueUrl });
      await partialApp.watch(['one'], 'one');
      await settle();
      partialForge.failingLookups.add('acme/app!42');
      partialForge.failingLookups.add('acme/app!43');
      partialForge.setPR('acme/app', '41', { state: 'merged' });
      await partialApp.refresh();
      await settle();
      expect(partialForge.issueReadTargets).toEqual([]);
      expect(await issueUpdates(partialApp)).toEqual([]);

      partialForge.failingLookups.delete('acme/app!42');
      await partialApp.refresh();
      await settle();
      expect(partialForge.issueReadTargets).toEqual([]);
      expect(await issueUpdates(partialApp)).toEqual([]);

      await partialApp.set({ targets: [ghPr42, ghPr43], operation: 'remove' });
      await partialApp.refresh();
      await settle();
      expect(partialForge.issueReadTargets).toEqual([]);
      expect(await issueUpdates(partialApp)).toEqual([]);
    } finally {
      await partialApp.cleanup();
    }

    const retryPartialForge = new StatusForge('github');
    retryPartialForge.setPR('acme/app', '41');
    retryPartialForge.setPR('acme/app', '42', { state: 'closed' });
    retryPartialForge.setPR('acme/app', '43', { state: 'merged' });
    retryPartialForge.issues.set('acme/platform#9', ghOpenIssue());
    const retryPartialStorage = new Map<string, unknown>();
    const retryPartialFirst = await harness({
      status: retryPartialForge,
      storage: retryPartialStorage,
    });
    try {
      await retryPartialFirst.set({ targets: [ghPr41, ghPr42, ghPr43], issue_url: ghIssueUrl });
      await retryPartialFirst.watch(['one'], 'one');
      await settle();
      retryPartialForge.failingLookups.add('acme/app!42');
      retryPartialForge.failingLookups.add('acme/app!43');
      retryPartialForge.setPR('acme/app', '41', { state: 'merged' });
      await retryPartialFirst.refresh();
      await settle();
    } finally {
      await retryPartialFirst.cleanup();
    }
    retryPartialForge.failingLookups.delete('acme/app!42');
    const retryPartialSecond = await harness({
      status: retryPartialForge,
      storage: retryPartialStorage,
    });
    try {
      await settle();
      expect(retryPartialForge.issueReadTargets).toEqual([]);
      expect(await issueUpdates(retryPartialSecond)).toEqual([]);

      await retryPartialSecond.set({ targets: [ghPr42, ghPr43], operation: 'remove' });
      await retryPartialSecond.watch(['one'], 'one');
      await settle();
      expect(retryPartialForge.issueReadTargets).toEqual([]);
      expect(await issueUpdates(retryPartialSecond)).toEqual([]);
    } finally {
      await retryPartialSecond.cleanup();
    }
  });

  test('resolves explicit cross-repo GitHub issues over branch inference, handles inferred same-number issues, and skips unassociated PRs', async () => {
    const forge = new StatusForge('github');
    forge.setPR('acme/app', '41');
    forge.issues.set('acme/platform#9', ghOpenIssue());
    forge.issues.set('acme/app#9', ghOpenIssue('https://github.com/acme/app/issues/9'));
    const explicitApp = await harness({
      status: forge,
      sourceBranches: new Map([['41', '9-branch-issue']]),
    });
    try {
      await explicitApp.set({ target: ghPr41, issue_url: ghIssueUrl });
      await explicitApp.watch(['one'], 'one');
      await settle();
      forge.setPR('acme/app', '41', { state: 'merged' });
      await explicitApp.refresh();
      await settle();
      expect(forge.issueReadTargets).toEqual(['acme/platform#9']);
      expect(await issueUpdates(explicitApp)).toMatchObject([
        {
          title: 'Issue acme/platform#9 may be outdated after #41',
          links: [ghIssueUrl, ghPr41],
        },
      ]);
    } finally {
      await explicitApp.cleanup();
    }

    const inferredForge = new StatusForge('github');
    const pr9 = 'https://github.com/acme/app/pull/9';
    const appIssue9 = 'https://github.com/acme/app/issues/9';
    inferredForge.setPR('acme/app', '9');
    inferredForge.issues.set('acme/app#9', ghOpenIssue(appIssue9));
    const inferredApp = await harness({
      status: inferredForge,
      sourceBranches: new Map([['9', '9-fix-bug']]),
    });
    try {
      await inferredApp.set({ target: pr9 });
      await inferredApp.watch(['one'], 'one');
      await settle();
      expect(inferredForge.issueReadTargets).toEqual([]);
      inferredForge.setPR('acme/app', '9', { state: 'merged' });
      await inferredApp.refresh();
      await settle();
      expect(inferredForge.issueReadTargets).toEqual(['acme/app#9']);
      expect(await issueUpdates(inferredApp)).toMatchObject([
        {
          title: 'Issue acme/app#9 may be outdated after #9',
          links: [appIssue9, pr9],
        },
      ]);
    } finally {
      await inferredApp.cleanup();
    }

    const unassociatedForge = new StatusForge('github');
    unassociatedForge.setPR('acme/app', '41');
    const unassociatedApp = await harness({ status: unassociatedForge });
    try {
      await unassociatedApp.set({ target: ghPr41 });
      await unassociatedApp.watch(['one'], 'one');
      await settle();
      unassociatedForge.setPR('acme/app', '41', { state: 'merged' });
      await unassociatedApp.refresh();
      await settle();
      expect(unassociatedForge.issueReadTargets).toEqual([]);
      expect(await issueUpdates(unassociatedApp)).toEqual([]);
    } finally {
      await unassociatedApp.cleanup();
    }
  });

  test('retries a failed GitHub final-merge issue read after reload, and cancels stale retries on removal or reassignment', async () => {
    const forge = new StatusForge('github');
    forge.setPR('acme/app', '41');
    forge.issues.set('acme/platform#9', ghOpenIssue());
    const storage = new Map<string, unknown>();
    const issue = forge.issue.bind(forge);
    const app = await harness({ status: forge, storage });
    try {
      await app.set({ target: ghPr41, issue_url: ghIssueUrl });
      await app.watch(['one'], 'one');
      await settle();
      forge.issue = async () => {
        throw new Error('GitHub issue lookup unavailable');
      };
      forge.setPR('acme/app', '41', { state: 'merged' });
      await app.refresh();
      await settle();
      expect((await app.feedback()).items.map((item) => item.kind)).toEqual(['merged']);
    } finally {
      await app.cleanup();
    }
    forge.issue = issue;
    const reloaded = await harness({ status: forge, storage });
    try {
      await settle();
      expect(forge.issueReadTargets).toEqual(['acme/platform#9']);
      expect(await issueUpdates(reloaded)).toMatchObject([
        {
          url: ghPr41,
          title: 'Issue acme/platform#9 may be outdated after #41',
          links: [ghIssueUrl, ghPr41],
        },
      ]);
      expect(
        (await reloaded.feedback()).items.filter((item) => item.kind === 'merged'),
      ).toHaveLength(1);
    } finally {
      await reloaded.cleanup();
    }

    for (const action of ['remove', 'reassign'] as const) {
      const staleForge = new StatusForge('github');
      staleForge.setPR('acme/app', '41');
      staleForge.issues.set('acme/platform#9', ghOpenIssue());
      const staleStorage = new Map<string, unknown>();
      const readIssue = staleForge.issue.bind(staleForge);
      const firstRun = await harness({ status: staleForge, storage: staleStorage });
      try {
        await firstRun.set({ target: ghPr41, issue_url: ghIssueUrl });
        await firstRun.watch(['one'], 'one');
        await settle();
        staleForge.issue = async () => {
          throw new Error('GitHub issue lookup unavailable');
        };
        staleForge.setPR('acme/app', '41', { state: 'merged' });
        await firstRun.refresh();
        await settle();
        if (action === 'remove') await firstRun.set({ target: 'none' });
        else
          await firstRun.set({
            target: ghPr41,
            issue_url: 'https://github.com/acme/platform/issues/10',
          });
      } finally {
        await firstRun.cleanup();
      }
      staleForge.issue = readIssue;
      const retryRun = await harness({ status: staleForge, storage: staleStorage });
      try {
        await settle();
        expect(staleForge.issueReadTargets).toEqual([]);
        expect(await issueUpdates(retryRun)).toEqual([]);
      } finally {
        await retryRun.cleanup();
      }
    }
  });

  test('respects watch.issues, watch.lifecycle, and delivery.lifecycle for GitHub issues', async () => {
    const noIssuesForge = new StatusForge('github');
    noIssuesForge.setPR('acme/app', '41');
    noIssuesForge.issues.set('acme/platform#9', ghOpenIssue());
    const noIssuesApp = await harness({
      status: noIssuesForge,
      pluginOptions: { watch: { issues: false } },
    });
    try {
      await noIssuesApp.set({ target: ghPr41, issue_url: ghIssueUrl });
      await noIssuesApp.watch(['one'], 'one');
      await settle();
      noIssuesForge.setPR('acme/app', '41', { state: 'merged' });
      await noIssuesApp.refresh();
      await settle();
      expect(noIssuesForge.issueReadTargets).toEqual([]);
      expect((await noIssuesApp.feedback()).items.map((item) => item.kind)).toEqual(['merged']);
    } finally {
      await noIssuesApp.cleanup();
    }

    const noLifecycleForge = new StatusForge('github');
    noLifecycleForge.setPR('acme/app', '41');
    noLifecycleForge.issues.set('acme/platform#9', ghOpenIssue());
    const noLifecycleApp = await harness({
      status: noLifecycleForge,
      pluginOptions: { watch: { lifecycle: false } },
    });
    try {
      await noLifecycleApp.set({ target: ghPr41, issue_url: ghIssueUrl });
      await noLifecycleApp.watch(['one'], 'one');
      await settle();
      noLifecycleForge.setPR('acme/app', '41', { state: 'merged' });
      await noLifecycleApp.refresh();
      await settle();
      expect(noLifecycleForge.issueReadTargets).toEqual([]);
      expect((await noLifecycleApp.feedback()).items).toEqual([]);
    } finally {
      await noLifecycleApp.cleanup();
    }

    const summaryForge = new StatusForge('github');
    summaryForge.setPR('acme/app', '41');
    summaryForge.issues.set('acme/platform#9', ghOpenIssue());
    const summaryApp = await harness({
      status: summaryForge,
      pluginOptions: { delivery: { lifecycle: 'summary' } },
    });
    try {
      await summaryApp.set({ target: ghPr41, issue_url: ghIssueUrl });
      await summaryApp.watch(['one'], 'one');
      await settle();
      summaryForge.setPR('acme/app', '41', { state: 'merged' });
      await summaryApp.refresh();
      await settle();
      expect(summaryApp.synthetic).toHaveLength(2);
      const mergeSummary = await summaryApp.request();
      expect(mergeSummary.tools).toEqual({});
      expect(textOf(mergeSummary)).toContain(`<mr-event kind="merged" link="${ghPr41}">`);
      const issueSummary = await summaryApp.request();
      expect(issueSummary.tools).toEqual({});
      expect(textOf(issueSummary)).toContain(`<mr-event kind="issue-outdated" link="${ghPr41}">`);
      expect(textOf(issueSummary)).toContain(
        '<mr-detail>All PRs this session tracks for acme/platform#9 have merged, but the issue is still open.</mr-detail>',
      );
    } finally {
      await summaryApp.cleanup();
    }
  });

  test('announces a failed job before its pipeline finishes, and clears it once a new pipeline runs', async () => {
    const running = (id: string, failed: string[]) => ({
      pipeline: {
        id,
        status: 'RUNNING',
        label: 'running',
        failedJobs: failed.map((name) => ({
          id: `job-${name}`,
          name,
          url: `https://gitlab.com/group/a/-/jobs/${name}`,
          stage: 'test',
        })),
        failedJobsComplete: true,
      },
    });
    const forge = new StatusForge();
    forge.set('group/a', '1', running('p1', []));
    const { app } = await watchedTargets([projectA], {
      status: forge,
      pluginOptions: { delivery: { lifecycle: 'summary' } },
    });
    expect((await app.feedback()).items).toEqual([]);
    forge.set('group/a', '1', running('p1', ['rspec']));
    await app.refresh();
    await settle();
    const [item] = (await app.feedback()).items;
    expect(item).toMatchObject({
      kind: 'ci-failed',
      pipeline: 'p1',
      title: '!1: job rspec failed in its pipeline, which is still running',
      links: ['https://gitlab.com/group/a/-/jobs/rspec', projectA],
      details: ['rspec failed in stage test.', 'Other jobs are still running.'],
    });
    // The summary sees only the forge's facts, without tools.
    const summary = await app.request();
    expect(summary.tools).toEqual({});
    expect(textOf(summary)).toContain(`<mr-event kind="ci-failed" link="${projectA}">`);
    expect(textOf(summary)).toContain('<mr-detail>rspec failed in stage test.</mr-detail>');
    // Another job fails in the same pipeline: its update replaces the first,
    // lists both, and reaches the session again.
    forge.set('group/a', '1', running('p1', ['rspec', 'lint']));
    await app.refresh();
    await settle();
    const updates = (await app.feedback()).items;
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      title: '!1: job lint failed in its pipeline, which is still running',
      links: [
        'https://gitlab.com/group/a/-/jobs/lint',
        'https://gitlab.com/group/a/-/jobs/rspec',
        projectA,
      ],
      details: [
        'lint failed in stage test.',
        'rspec failed earlier in stage test.',
        'Other jobs are still running.',
      ],
    });
    expect(updates[0].id).not.toBe(item.id);
    expect(app.synthetic).toHaveLength(2);
    // A new pipeline, such as after a push, replaces the failed one.
    forge.set('group/a', '1', running('p2', []));
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toEqual([]);
    await app.cleanup();
  });

  test("reports a failure past the jobs it reads once the pipeline's status shows it", async () => {
    // Only jobs allowed to fail were read, and more failed.
    const unread = (status: string) => ({
      pipeline: {
        id: 'p1',
        status,
        label: status.toLowerCase(),
        failedJobs: [],
        failedJobsComplete: false,
      },
    });
    const forge = new StatusForge();
    forge.set('group/a', '1', unread('RUNNING'));
    const { app } = await watchedTargets([projectA], { status: forge });
    forge.set('group/a', '1', unread('FAILED'));
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toMatchObject([
      {
        kind: 'ci-failed',
        title: '!1: its pipeline failed',
        details: [
          'A job that is not allowed to fail failed the pipeline, but it is not among the failed jobs Forgekeeper reads.',
        ],
      },
    ]);
    await app.cleanup();
  });

  test('summarizes a lifecycle event from forge facts in a tool-free turn', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const { app } = await watchedTargets([projectA], {
      status: forge,
      pluginOptions: { delivery: { lifecycle: 'summary' } },
    });
    forge.set('group/a', '1', { conflicts: true });
    await app.refresh();
    await settle();
    expect(app.synthetic).toHaveLength(1);
    expect(app.passive[0].text).toContain('!1 can no longer merge');
    expect(app.passive[0].text).toContain(
      'Forgekeeper summarizes this merge request change without tools.',
    );
    const summary = await app.request();
    expect(summary.tools).toEqual({});
    expect(summary.system[0].text).toContain('change to one of their merge requests');
    expect(summary.messages).toHaveLength(1);
    expect(textOf(summary)).toContain(`<mr-event kind="conflict" link="${projectA}">`);
    expect(await app.toolCall()).toContain('Tools are disabled');
    await app.cleanup();

    const passiveForge = new StatusForge();
    passiveForge.set('group/a', '1');
    const { app: passiveApp } = await watchedTargets([projectA], {
      status: passiveForge,
      pluginOptions: { delivery: { lifecycle: 'passive' } },
    });
    passiveForge.set('group/a', '1', { conflicts: true });
    await passiveApp.refresh();
    await settle();
    expect(passiveApp.passive[0].text).toContain('Merge request update only. No action requested.');
    await passiveApp.cleanup();
  });

  test('summarizes a lifecycle event recorded in inbox mode when asked to', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const { app } = await watchedTargets([projectA], { status: forge });
    forge.set('group/a', '1', { state: 'merged' });
    await app.refresh();
    await settle();
    expect(app.passive).toEqual([]);
    const [item] = (await app.feedback()).items;
    await app.summarizeFeedback(item.id);
    expect(app.synthetic).toHaveLength(1);
    const summary = await app.request();
    expect(summary.tools).toEqual({});
    expect(textOf(summary)).toContain(`<mr-event kind="merged" link="${projectA}">`);
    await app.cleanup();
  });

  test('records no lifecycle events while monitoring is paused', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const { app } = await watchedTargets([projectA], { status: forge });
    await app.pauseFeedback(true);
    forge.set('group/a', '1', { conflicts: true });
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toEqual([]);
    await app.cleanup();
  });

  test('proposes retargeting a dependent target once its parent merges, when enabled', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    forge.set('group/a', '2', { targetBranch: 'branch-1' });
    const { app } = await watchedTargets([projectA, child], {
      status: forge,
      pluginOptions: {
        lifecycleExecution: { parentMerged: { mode: 'prepare', actions: ['retarget'] } },
      },
    });
    forge.set('group/a', '1', { state: 'merged' });
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toMatchObject([
      {
        kind: 'merged',
        title: '!1 merged into main',
        details: ['Proposed: retarget !2 from branch-1 to main.'],
      },
    ]);
    await app.cleanup();
  });

  test('leaves out targets that the session drops while it reads their dependents', async () => {
    for (const dropped of [projectA, child]) {
      const forge = new StatusForge();
      forge.set('group/a', '1');
      forge.set('group/a', '2', { targetBranch: 'branch-1' });
      const { app } = await watchedTargets([projectA, child], {
        status: forge,
        pluginOptions: {
          lifecycleExecution: { parentMerged: { mode: 'prepare', actions: ['retarget'] } },
        },
      });
      // The proposal's read of the dependent, after the lookup's own.
      const reading = deferred();
      const release = deferred();
      const lookup = forge.findByNumber.bind(forge);
      let reads = 0;
      forge.findByNumber = async (projects, number) => {
        if (number === '2' && ++reads === 2) {
          reading.resolve();
          await release.promise;
        }
        return lookup(projects, number);
      };
      forge.set('group/a', '1', { state: 'merged' });
      void app.refresh();
      await reading.promise;
      await app.set({ targets: [dropped], operation: 'remove' });
      release.resolve();
      await settle();
      const items = (await app.feedback()).items;
      if (dropped === projectA) expect(items).toEqual([]);
      else {
        expect(items).toMatchObject([{ kind: 'merged', url: projectA }]);
        expect(items[0].details).toBeUndefined();
      }
      await app.cleanup();
    }
  });

  test('only describes the dependents by default', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1');
    forge.set('group/a', '2', { targetBranch: 'branch-1' });
    const { app } = await watchedTargets([projectA, child], { status: forge });
    forge.set('group/a', '1', { state: 'merged' });
    await app.refresh();
    await settle();
    expect((await app.feedback()).items).toMatchObject([
      { kind: 'merged', details: ['!2 builds on !1: it targets branch-1.'] },
    ]);
    await app.cleanup();
  });

  test('does not propose retargets when enabled only after the merge', async () => {
    const forge = new StatusForge();
    forge.set('group/a', '1', { state: 'merged' });
    forge.set('group/a', '2', { targetBranch: 'branch-1' });
    const record = (iid: string, overrides: Record<string, unknown>) => ({
      sessionID: 'one',
      url: `https://gitlab.com/group/a/-/merge_requests/${iid}`,
      reference: `!${iid}`,
      state: 'opened',
      cycles: 0,
      targetProject: 'group/a',
      targetBranch: 'main',
      sourceProject: 'group/a',
      sourceBranch: `branch-${iid}`,
      pending: [],
      at: 0,
      ...overrides,
    });
    const key = (url: string) => `status/lifecycle/one/${encodeURIComponent(url)}`;
    const id = JSON.stringify(['one', projectA, 'merged']);
    const storage = new Map<string, unknown>([
      ['sessions/one', { targets: [{ url: projectA }, { url: child }] }],
      [
        key(projectA),
        record('1', {
          state: 'merged',
          pending: [{ kind: 'merged', id, detectedAt: 5, policy: { mode: 'notify', actions: [] } }],
        }),
      ],
      [key(child), record('2', { targetBranch: 'branch-1', parent: projectA })],
    ]);
    // Preparing was enabled after the merge, which nothing polls anymore.
    const app = await harness({ storage, status: forge, pluginOptions: preparing });
    await settle();
    expect((await app.feedback()).items).toMatchObject([
      { id, kind: 'merged', at: 5, details: ['!2 builds on !1: it targets branch-1.'] },
    ]);
    expect((storage.get(key(projectA)) as { pending: unknown[] }).pending).toEqual([]);
    await app.cleanup();
  });

  // Storage after the parent of a stack merged, with the merge waiting for
  // delivery, as a reload finds it. `targets` are the session's targets now.
  // The records are recent, so housekeeping keeps them.
  const mergedStack = (
    targets: string[],
    event: Record<string, unknown> = { policy: { mode: 'prepare', actions: ['retarget'] } },
    storage = new Map<string, unknown>(),
  ) => {
    const record = (iid: string, overrides: Record<string, unknown>) => ({
      sessionID: 'one',
      url: `https://gitlab.com/group/a/-/merge_requests/${iid}`,
      reference: `!${iid}`,
      state: 'opened',
      cycles: 0,
      targetProject: 'group/a',
      targetBranch: 'main',
      sourceProject: 'group/a',
      sourceBranch: `branch-${iid}`,
      pending: [],
      at: Date.now(),
      ...overrides,
    });
    const id = JSON.stringify(['one', projectA, 'merged']);
    storage.set('sessions/one', { targets: targets.map((url) => ({ url })) });
    storage.set(
      lifecycleRecord(projectA),
      record('1', { state: 'merged', pending: [{ kind: 'merged', id, detectedAt: 5, ...event }] }),
    );
    storage.set(
      lifecycleRecord(child),
      record('2', { targetBranch: 'branch-1', parent: projectA }),
    );
    const forge = new StatusForge();
    forge.set('group/a', '1', { state: 'merged' });
    forge.set('group/a', '2', { targetBranch: 'branch-1' });
    return { storage, forge, id };
  };
  const lifecycleRecord = (url: string) => `status/lifecycle/one/${encodeURIComponent(url)}`;
  const preparing = {
    lifecycleExecution: { parentMerged: { mode: 'prepare', actions: ['retarget'] } },
  };

  test('stops proposing retargets for a pending merge when proposals are disabled', async () => {
    const { storage, forge } = mergedStack([projectA, child]);
    const app = await harness({
      storage,
      status: forge,
      pluginOptions: { lifecycleExecution: { parentMerged: { mode: 'notify' } } },
    });
    await settle();
    expect((await app.feedback()).items).toMatchObject([
      { kind: 'merged', details: ['!2 builds on !1: it targets branch-1.'] },
    ]);
    await app.cleanup();
  });

  test('proposes nothing for a dependent the session no longer targets', async () => {
    // The child's record outlives its removal from the targets.
    const { storage, forge } = mergedStack([projectA]);
    const app = await harness({ storage, status: forge, pluginOptions: preparing });
    await settle();
    expect(storage.has(lifecycleRecord(child))).toBe(true);
    const [item] = (await app.feedback()).items;
    expect(item).toMatchObject({ kind: 'merged' });
    expect(item.details).toBeUndefined();
    await app.cleanup();
  });

  test('reads the dependent again, so one GitLab already retargeted gets no proposal', async () => {
    // GitLab retargets dependents itself when the merge deletes the branch.
    const { storage, forge } = mergedStack([projectA, child]);
    forge.set('group/a', '2', { targetBranch: 'main' });
    const app = await harness({ storage, status: forge, pluginOptions: preparing });
    await settle();
    expect((await app.feedback()).items).toMatchObject([
      { kind: 'merged', details: ['!2 already targets main.'] },
    ]);
    await app.cleanup();
  });

  test('never changes a dependent on the forge, since applying is no mode', async () => {
    const { storage, forge } = mergedStack([projectA, child], {
      policy: { mode: 'apply', actions: ['retarget'] },
    });
    const app = await harness({
      storage,
      status: forge,
      pluginOptions: {
        lifecycleExecution: { parentMerged: { mode: 'apply', actions: ['retarget'] } },
      },
    });
    await settle();
    expect(forge.requests.get('group/a!2')?.targetBranch).toBe('branch-1');
    expect((await app.feedback()).items).toMatchObject([
      { kind: 'merged', details: ['!2 builds on !1: it targets branch-1.'] },
    ]);
    expect(app.notices()).toContainEqual(
      expect.objectContaining({
        variant: 'error',
        message: expect.stringContaining(
          'lifecycleExecution.parentMerged mode must be one of "notify", "prepare"; using "notify"',
        ),
      }),
    );
    await app.cleanup();
  });

  test('delivers a lifecycle event in the mode it was detected in', async () => {
    // Detected in inbox mode, then summaries were turned on.
    const { storage, forge } = mergedStack([projectA], {});
    const app = await harness({
      storage,
      status: forge,
      pluginOptions: { delivery: { lifecycle: 'summary' } },
    });
    await settle();
    const [item] = (await app.feedback()).items;
    expect(item).toMatchObject({ kind: 'merged' });
    expect(item.delivery).toBeUndefined();
    expect(app.passive).toEqual([]);
    await app.cleanup();
  });

  test("stops one kind of update's automatic delivery without the other's", async () => {
    const storage = new Map<string, unknown>([
      ['sessions/one', { targets: [{ url: projectA }] }],
      [
        'feedback-inbox/%2Frepo',
        {
          paused: false,
          items: [
            {
              id: 'review',
              sessionID: 'one',
              url: projectA,
              title: 'New review feedback on !1',
              links: [`${projectA}#note_7`],
              commentIDs: ['7'],
              delivery: 'summary',
              at: 0,
            },
          ],
        },
      ],
    ]);
    const forge = new StatusForge();
    forge.set('group/a', '1');
    const off = await harness({
      storage,
      status: forge,
      pluginOptions: { delivery: { reviews: 'inbox', lifecycle: 'summary' } },
    });
    await settle();
    expect(off.passive).toEqual([]);
    // It waits, undelivered, rather than counting as delivered.
    expect((await off.feedback()).items[0].notifiedAt).toBeUndefined();
    await off.cleanup();

    const on = await harness({
      storage,
      status: forge,
      pluginOptions: { delivery: { reviews: 'summary' } },
    });
    await settle();
    expect(on.synthetic).toHaveLength(1);
    await on.cleanup();
  });

  test('warns about invalid proposal options and leaves proposals disabled', async () => {
    const app = await harness({
      status: new StatusForge(),
      pluginOptions: {
        lifecycleExecution: { parentMerged: { mode: 'prepare', actions: ['push'] } },
      },
    });
    await settle();
    expect(app.notices()).toContainEqual(
      expect.objectContaining({
        variant: 'error',
        message: expect.stringContaining(
          'lifecycleExecution.parentMerged actions has ["push"], but supports only "retarget"; using "notify"',
        ),
      }),
    );
    await app.cleanup();
  });

  test('warns about ignored options even with status off', async () => {
    const app = await harness({
      status: new StatusForge(),
      pluginOptions: { status: false, delivery: { reviews: 'invalid' } },
    });
    await settle();
    expect(app.notices()).toContainEqual(
      expect.objectContaining({
        variant: 'error',
        message: expect.stringContaining('delivery.reviews must be one of'),
      }),
    );
    await app.cleanup();
  });

  test('keeps updates across a reload until a finished lookup shows them stale', async () => {
    const { app, reader } = await watchedFeedback();
    await app.refresh();
    await settle();
    await app.cleanup();
    const forge = new StatusForge();
    forge.set('group/a', '1');
    forge.gated = true;
    const reloaded = await harness({
      storage: app.storage,
      status: forge,
      feedback: reader.read,
      now: reader.now,
    });
    await reloaded.watch(['one'], 'one');
    await settle();
    // The lookup is still running, so the targets aren't known yet.
    expect((await reloaded.feedback()).items).toHaveLength(1);
    forge.open();
    await settle();
    expect((await reloaded.feedback()).items).toHaveLength(1);
    await reloaded.cleanup();
  });

  test('queues a passive session message that starts no turn in passive mode', async () => {
    const { app } = await watchedFeedback({ pluginOptions: { delivery: { reviews: 'passive' } } });
    await app.refresh();
    await settle();
    expect(app.syntheticStarted()).toBe(0);
    expect(app.passive).toMatchObject([{ sessionID: 'one', resume: false, delivery: 'queue' }]);
    expect(app.passive[0].text).toContain(`${projectA}#note_7`);
    await app.cleanup();
  });
});
