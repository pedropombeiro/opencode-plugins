import { describe, expect, test } from 'bun:test';
import type {
  Forge,
  GitHubIssueSnapshot,
  GitLabIssueSnapshot,
  GitLabMergeRequest,
  IssueSnapshot,
  ReviewRef,
  ReviewRequest,
} from './forge';
import { traits, type ForgeCatalog } from './forges';
import { linkedMetadata } from './linked-session';
import { presenceKey } from './linked-session';
import {
  allRequestsMerged,
  cleanupCandidates,
  cleanupReadyOf,
  cleanupSessions,
  createCleanupWatch,
  formatCleanupFailures,
  formatCleanupProgress,
  formatCleanupSubtitle,
  listProjectSessions,
  pruneForeignInboxSession,
  resolveLookupCleanupReady,
  splitCleanupTargets,
  worktreeLabel,
  type CleanupProgressEvent,
  type CleanupWatchRecord,
  type ListedSession,
} from './session-cleanup';
import type { Target } from './target';

const mrUrl = (iid: string, project = 'group/app') =>
  `https://gitlab.com/${project}/-/merge_requests/${iid}`;
const prUrl = (iid: string, project = 'acme/app') => `https://github.com/${project}/pull/${iid}`;
const glIssueUrl = (iid: string, project = 'group/app') =>
  `https://gitlab.com/${project}/-/issues/${iid}`;
const ghIssueUrl = (iid: string, project = 'acme/app') =>
  `https://github.com/${project}/issues/${iid}`;

const makeMr = (
  iid: string,
  state: 'opened' | 'merged' | 'closed' = 'merged',
  project = 'group/app',
): GitLabMergeRequest => ({
  forge: 'gitlab',
  iid,
  title: `MR ${iid}`,
  url: mrUrl(iid, project),
  state,
  draft: false,
  conflicts: false,
  conflictsKnown: true,
  approved: true,
  hasApprovals: true,
  approvalRequirementsSatisfied: true,
  awaitingReviewers: [],
  reviewersComplete: true,
  targetProject: project,
  targetBranch: 'main',
  headSha: 'abc',
  pipeline: { status: 'SUCCESS', label: 'passed' },
  unresolvedThreads: 0,
  threadsComplete: true,
});

const makeGlIssue = (open: boolean): GitLabIssueSnapshot => ({
  forge: 'gitlab',
  open,
  assignees: ['pedro'],
  labels: [],
});

const makeGhIssue = (iid: string, open: boolean, project = 'acme/app'): GitHubIssueSnapshot => ({
  forge: 'github',
  open,
  url: ghIssueUrl(iid, project),
});

function createFakeCatalog(options: {
  mrs?: Map<string, ReviewRequest | Error>;
  issues?: Map<string, IssueSnapshot | Error>;
}) {
  const mrCalls: string[] = [];
  const issueCalls: string[] = [];

  const adapter = (kind: 'gitlab' | 'github'): Forge => ({
    traits: traits(kind),
    findByBranch: async () => [],
    findNumberByBranch: async () => undefined,
    findByNumber: async (projects, iid) => {
      const key = `${projects[0]?.path}#${iid}`;
      mrCalls.push(key);
      const entry = options.mrs?.get(key);
      if (entry instanceof Error) throw entry;
      return entry;
    },
    sourceBranch: async () => undefined,
    issue: async (ref: ReviewRef) => {
      const key = `${kind}:${ref.project}#${ref.iid}`;
      issueCalls.push(key);
      const entry = options.issues?.get(key);
      if (entry instanceof Error) throw entry;
      return entry;
    },
  });

  const forges: ForgeCatalog = {
    kinds: ['gitlab', 'github'],
    kind: (host) => {
      if (host === 'gitlab.com') return 'gitlab';
      return host === 'github.com' ? 'github' : undefined;
    },
    forHost: (host) => {
      if (host === 'gitlab.com') return adapter('gitlab');
      return host === 'github.com' ? adapter('github') : undefined;
    },
    projects: async () => [],
    repository: async () => ({ kind: 'none', reason: 'not used' }),
  };

  return { forges, mrCalls, issueCalls };
}

describe('session-cleanup helpers', () => {
  test('allRequestsMerged and cleanupReadyOf evaluate snapshots', () => {
    expect(allRequestsMerged({ loading: true })).toBe(false);
    expect(allRequestsMerged({ loading: false, lookup: { kind: 'none', reason: 'none' } })).toBe(
      false,
    );
    expect(
      allRequestsMerged({
        loading: false,
        lookup: { kind: 'found', explicitTarget: true, requests: [makeMr('1', 'opened')] },
      }),
    ).toBe(false);
    expect(
      allRequestsMerged({
        loading: false,
        lookup: {
          kind: 'found',
          explicitTarget: true,
          requests: [makeMr('1', 'merged')],
          failed: [{ url: mrUrl('2'), reason: 'failed' }],
        },
      }),
    ).toBe(false);

    const singleMerged = {
      loading: false,
      lookup: { kind: 'found' as const, explicitTarget: true, requests: [makeMr('1', 'merged')] },
    };
    expect(allRequestsMerged(singleMerged)).toBe(true);
    expect(cleanupReadyOf(singleMerged)).toEqual({
      kind: 'merged-requests',
      reason: 'MR merged',
    });

    const multiMerged = {
      loading: false,
      lookup: {
        kind: 'found' as const,
        explicitTarget: true,
        requests: [makeMr('1', 'merged'), makeMr('2', 'merged')],
      },
    };
    expect(cleanupReadyOf(multiMerged)).toEqual({
      kind: 'merged-requests',
      reason: 'All MRs merged',
    });

    const prMerged = {
      loading: false,
      lookup: {
        kind: 'found' as const,
        explicitTarget: true,
        requests: [{ ...makeMr('7', 'merged'), forge: 'github' as const, url: prUrl('7') }],
      },
    };
    expect(cleanupReadyOf(prMerged)).toEqual({
      kind: 'merged-requests',
      reason: 'PR merged',
    });

    const mixedMerged = {
      loading: false,
      lookup: {
        kind: 'found' as const,
        explicitTarget: true,
        requests: [
          makeMr('1', 'merged'),
          { ...makeMr('7', 'merged'), forge: 'github' as const, url: prUrl('7') },
        ],
      },
    };
    expect(cleanupReadyOf(mixedMerged)).toEqual({
      kind: 'merged-requests',
      reason: 'All PRs/MRs merged',
    });

    const closedIssueSnapshot = {
      loading: false,
      lookup: {
        kind: 'none' as const,
        reason: 'not a PR/MR',
        cleanupReady: { kind: 'closed-issues' as const, reason: 'Tracked issue closed' },
      },
    };
    expect(cleanupReadyOf(closedIssueSnapshot)).toEqual({
      kind: 'closed-issues',
      reason: 'Tracked issue closed',
    });
  });

  test('splitCleanupTargets separates PR/MRs and issues and deduplicates', () => {
    const split = splitCleanupTargets([
      { url: mrUrl('1') },
      { url: mrUrl('1') },
      { url: glIssueUrl('10') },
      { url: ghIssueUrl('20') },
    ]);
    expect(split.unknown).toBe(0);
    expect(split.mergeRequests).toHaveLength(1);
    expect(split.issues).toHaveLength(2);
  });

  test('formatCleanupSubtitle and worktreeLabel keep rows concise', () => {
    expect(worktreeLabel('/Users/dev/repo-wt/')).toBe('repo-wt');
    expect(
      formatCleanupSubtitle({
        sessionID: 's1',
        title: '[!1] Fix',
        directory: '/repo',
        reason: 'merged-requests',
        targets: [
          { kind: 'merge-request', url: mrUrl('1'), reference: '!1', project: 'group/app' },
        ],
        pendingFeedback: 0,
      }),
    ).toBe('!1 merged');
    expect(
      formatCleanupSubtitle({
        sessionID: 's2',
        title: '[#10] Issue',
        directory: '/repo',
        reason: 'closed-issues',
        targets: [{ kind: 'issue', url: glIssueUrl('10'), reference: '#10', project: 'group/app' }],
        pendingFeedback: 2,
      }),
    ).toBe('#10 closed · 2 review updates');
  });

  test('listProjectSessions paginates across pages', async () => {
    const calls: unknown[] = [];
    const sessions = await listProjectSessions({
      projectID: 'proj-1',
      directory: '/repo',
      list: async (input) => {
        calls.push(input);
        if (!input.cursor) {
          return {
            data: [
              { id: 's1', projectID: 'proj-1', time: {}, location: { directory: '/repo' } },
              { id: 'other', projectID: 'proj-2', time: {}, location: { directory: '/other' } },
            ],
            cursor: { next: 'page-2' },
          };
        }
        return {
          data: [{ id: 's2', projectID: 'proj-1', time: {}, location: { directory: '/repo-wt' } }],
          cursor: { next: null },
        };
      },
    });
    expect(sessions.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(calls).toEqual([
      { project: 'proj-1', parentID: null, archived: false, limit: 200 },
      { cursor: 'page-2', limit: 200 },
    ]);

    // Stops pagination when AbortSignal triggers after the first page:
    const abortController = new AbortController();
    const abortedCalls: unknown[] = [];
    const partial = await listProjectSessions({
      projectID: 'proj-1',
      directory: '/repo',
      signal: abortController.signal,
      list: async (input) => {
        abortedCalls.push(input);
        abortController.abort();
        return {
          data: [{ id: 's1', projectID: 'proj-1', time: {}, location: { directory: '/repo' } }],
          cursor: { next: 'page-2' },
        };
      },
    });
    expect(partial.map((s) => s.id)).toEqual(['s1']);
    expect(abortedCalls).toHaveLength(1);
  });
});

describe('cleanupCandidates & cleanupSessions', () => {
  test('finds idle sessions with all PRs/MRs merged or all issue-only targets closed across worktrees', async () => {
    const mrs = new Map<string, ReviewRequest | Error>([
      ['group/app#1', makeMr('1', 'merged')],
      ['group/app#2', makeMr('2', 'merged')],
      ['group/app#3', makeMr('3', 'opened')],
      ['group/app#4', new Error('network error')],
    ]);
    const issues = new Map<string, IssueSnapshot | Error>([
      ['gitlab:group/app#10', makeGlIssue(false)],
      ['github:acme/app#20', makeGhIssue('20', false)],
      ['gitlab:group/app#11', makeGlIssue(true)],
    ]);
    const { forges, mrCalls, issueCalls } = createFakeCatalog({ mrs, issues });

    const sessions: ListedSession[] = [
      {
        id: 'merged-with-open-issue',
        title: '[#11, !1, !2] Feature A',
        projectID: 'proj',
        time: { updated: 200 },
        location: { directory: '/repo' },
      },
      {
        id: 'merged-other-worktree',
        title: '[!1] Shared MR in worktree',
        projectID: 'proj',
        time: { updated: 300 },
        location: { directory: '/repo-wt' },
      },
      {
        id: 'closed-issues-only',
        title: '[#10, #20] Triage',
        projectID: 'proj',
        time: { updated: 100 },
        location: { directory: '/repo' },
      },
      {
        id: 'open-issue-only',
        title: '[#11] Open issue',
        projectID: 'proj',
        time: { updated: 90 },
        location: { directory: '/repo' },
      },
      {
        id: 'partially-open-mr',
        title: '[!1, !3] Partial',
        projectID: 'proj',
        time: { updated: 80 },
        location: { directory: '/repo' },
      },
      {
        id: 'busy-merged',
        title: '[!1] Busy',
        projectID: 'proj',
        time: { busy: 50, idle: 40, updated: 70 },
        location: { directory: '/repo' },
      },
      {
        id: 'child-merged',
        title: '[!1] Child',
        parentID: 'merged-with-open-issue',
        projectID: 'proj',
        time: { updated: 60 },
        location: { directory: '/repo' },
      },
      {
        id: 'linked-merged',
        title: '[!1] Linked',
        projectID: 'proj',
        metadata: linkedMetadata('merged-with-open-issue', 'batch', 'linked-merged'),
        time: { updated: 50 },
        location: { directory: '/repo' },
      },
      {
        id: 'archived-merged',
        title: '[!1] Archived',
        projectID: 'proj',
        time: { archived: 10, updated: 40 },
        location: { directory: '/repo' },
      },
      {
        id: 'error-mr',
        title: '[!4] Failing lookup',
        projectID: 'proj',
        time: { updated: 30 },
        location: { directory: '/repo' },
      },
      {
        id: 'untargeted',
        title: 'General chat',
        projectID: 'proj',
        time: { updated: 20 },
        location: { directory: '/repo' },
      },
    ];

    const targetsBySession = new Map<string, Target[]>([
      [
        'merged-with-open-issue',
        [{ url: mrUrl('1'), issueUrl: glIssueUrl('11') }, { url: mrUrl('2') }],
      ],
      ['merged-other-worktree', [{ url: mrUrl('1') }]],
      ['closed-issues-only', [{ url: glIssueUrl('10') }, { url: ghIssueUrl('20') }]],
      ['open-issue-only', [{ url: glIssueUrl('11') }]],
      ['partially-open-mr', [{ url: mrUrl('1') }, { url: mrUrl('3') }]],
      ['busy-merged', [{ url: mrUrl('1') }]],
      ['child-merged', [{ url: mrUrl('1') }]],
      ['linked-merged', [{ url: mrUrl('1') }]],
      ['archived-merged', [{ url: mrUrl('1') }]],
      ['error-mr', [{ url: mrUrl('4') }]],
      ['untargeted', []],
    ]);
    // Also add an explicit open issue on merged-with-open-issue to verify PR/MR precedence:
    targetsBySession.get('merged-with-open-issue')!.push({ url: glIssueUrl('11') });

    const scan = await cleanupCandidates({
      projectID: 'proj',
      directory: '/repo',
      forges,
      listSessions: async () => sessions,
      storedTargets: async (id) => targetsBySession.get(id) ?? [],
      pendingFeedbackCount: async (dir, id) =>
        id === 'merged-other-worktree' && dir === '/repo-wt' ? 2 : 0,
    });

    expect(scan.enabled).toBe(true);
    expect(scan.skippedErrors).toBe(1);
    expect(scan.candidates.map((c) => c.sessionID)).toEqual([
      'merged-other-worktree',
      'merged-with-open-issue',
      'closed-issues-only',
    ]);
    expect(scan.candidates[0]).toMatchObject({
      sessionID: 'merged-other-worktree',
      directory: '/repo-wt',
      reason: 'merged-requests',
      pendingFeedback: 2,
      targets: [{ kind: 'merge-request', reference: '!1' }],
    });
    expect(scan.candidates[1]).toMatchObject({
      sessionID: 'merged-with-open-issue',
      reason: 'merged-requests',
      targets: [
        { kind: 'merge-request', reference: '!1' },
        { kind: 'merge-request', reference: '!2' },
      ],
    });
    expect(scan.candidates[2]).toMatchObject({
      sessionID: 'closed-issues-only',
      reason: 'closed-issues',
      targets: [
        { kind: 'issue', reference: 'group/app#10' },
        { kind: 'issue', reference: 'acme/app#20' },
      ],
    });
    // `!1` was referenced by 3 active sessions, but looked up only once.
    expect(mrCalls.filter((key) => key === 'group/app#1')).toHaveLength(1);
    expect(issueCalls.filter((key) => key === 'gitlab:group/app#10')).toHaveLength(1);
  });

  test('cleanupSessions re-verifies eligibility before archiving and handles failures per session', async () => {
    const mrs = new Map<string, ReviewRequest | Error>([
      ['group/app#1', makeMr('1', 'merged')],
      ['group/app#2', makeMr('2', 'opened')],
    ]);
    const issues = new Map<string, IssueSnapshot | Error>([
      ['gitlab:group/app#10', makeGlIssue(false)],
    ]);
    const { forges } = createFakeCatalog({ mrs, issues });

    const sessionMap = new Map<string, ListedSession>([
      [
        'eligible-mr',
        { id: 'eligible-mr', projectID: 'proj', time: {}, location: { directory: '/repo' } },
      ],
      [
        'eligible-issue',
        { id: 'eligible-issue', projectID: 'proj', time: {}, location: { directory: '/repo-wt' } },
      ],
      [
        'already-archived',
        {
          id: 'already-archived',
          projectID: 'proj',
          time: { archived: 1 },
          location: { directory: '/repo' },
        },
      ],
      [
        'became-busy',
        {
          id: 'became-busy',
          projectID: 'proj',
          time: { busy: 10, idle: 5 },
          location: { directory: '/repo' },
        },
      ],
      [
        'unmerged-mr',
        { id: 'unmerged-mr', projectID: 'proj', time: {}, location: { directory: '/repo' } },
      ],
      [
        'archive-throws',
        { id: 'archive-throws', projectID: 'proj', time: {}, location: { directory: '/repo' } },
      ],
      [
        'other-project',
        {
          id: 'other-project',
          projectID: 'proj-other',
          time: {},
          location: { directory: '/other' },
        },
      ],
    ]);

    const targets = new Map<string, Target[]>([
      ['eligible-mr', [{ url: mrUrl('1') }]],
      ['eligible-issue', [{ url: glIssueUrl('10') }]],
      ['became-busy', [{ url: mrUrl('1') }]],
      ['unmerged-mr', [{ url: mrUrl('2') }]],
      ['archive-throws', [{ url: mrUrl('1') }]],
      ['other-project', [{ url: mrUrl('1') }]],
    ]);

    const cleaned: Array<{ id: string; dir: string }> = [];
    const result = await cleanupSessions(
      [
        'eligible-mr',
        'eligible-issue',
        'already-archived',
        'missing',
        'became-busy',
        'unmerged-mr',
        'archive-throws',
        'other-project',
      ],
      {
        projectID: 'proj',
        directory: '/repo',
        forges,
        getSession: async (id) => sessionMap.get(id),
        archiveSession: async (id) => {
          if (id === 'archive-throws') throw new Error('disk full');
          sessionMap.get(id)!.time.archived = 100;
        },
        storedTargets: async (id) => targets.get(id) ?? [],
        onSessionCleaned: async (id, dir) => {
          cleaned.push({ id, dir });
        },
      },
    );

    expect(result.archived).toEqual(['eligible-mr', 'eligible-issue']);
    expect(result.alreadyArchived).toEqual(['already-archived', 'missing']);
    expect(result.failed).toEqual([
      { sessionID: 'became-busy', reason: 'Session is currently running' },
      { sessionID: 'other-project', reason: 'Session belongs to another project' },
      { sessionID: 'unmerged-mr', reason: 'Not all MRs are merged' },
      { sessionID: 'archive-throws', reason: 'disk full' },
    ]);
    expect(cleaned).toEqual([
      { id: 'eligible-mr', dir: '/repo' },
      { id: 'eligible-issue', dir: '/repo-wt' },
    ]);
  });

  test('createCleanupWatch notifies only on false -> true transition and resets on change', async () => {
    const store = new Map<string, CleanupWatchRecord>();
    const notices: Array<{ sessionID: string; reason: string }> = [];
    let clock = 1_000;
    const watch = createCleanupWatch({
      read: async (id) => store.get(id),
      write: async (record) => void store.set(record.sessionID, record),
      remove: async (id) => void store.delete(id),
      scan: async () => [...store.entries()].map(([key, value]) => ({ key, value })),
      hasTargets: async (id) => id !== 'dropped',
      onReady: (sessionID, ready) => notices.push({ sessionID, reason: ready.reason }),
      now: () => clock,
    });

    // Baseline when already merged on startup does not notify:
    await watch.observe('already', 'k1', true, {
      kind: 'merged-requests',
      reason: 'PR/MR merged',
    });
    expect(notices).toEqual([]);

    // Baseline when open, then transition to merged notifies once:
    await watch.observe('s1', 'k1', true, undefined);
    expect(notices).toEqual([]);
    await watch.observe('s1', 'k1', true, {
      kind: 'merged-requests',
      reason: 'PR/MR merged',
    });
    expect(notices).toEqual([{ sessionID: 's1', reason: 'PR/MR merged' }]);

    // Repeated observation while still merged does not notify again:
    await watch.observe('s1', 'k1', true, {
      kind: 'merged-requests',
      reason: 'PR/MR merged',
    });
    expect(notices).toHaveLength(1);

    // Incomplete lookup does not reset `ready`:
    await watch.observe('s1', 'k1', false, undefined);
    await watch.observe('s1', 'k1', true, {
      kind: 'merged-requests',
      reason: 'PR/MR merged',
    });
    expect(notices).toHaveLength(1);

    // Returning to not-ready (e.g. reopened) then ready again notifies:
    await watch.observe('s1', 'k1', true, undefined);
    await watch.observe('s1', 'k1', true, {
      kind: 'merged-requests',
      reason: 'PR/MR merged',
    });
    expect(notices).toHaveLength(2);

    // Prune removes stale records whose sessions no longer have targets:
    await watch.observe('dropped', 'k1', true, undefined);
    clock += 31 * 24 * 60 * 60_000;
    await watch.prune();
    expect(store.has('dropped')).toBe(false);
    expect(store.has('s1')).toBe(true);
  });

  test('resolveLookupCleanupReady attaches cleanupReady for merged MRs and closed issues', async () => {
    const mergedLookup = await resolveLookupCleanupReady(
      {
        kind: 'found',
        explicitTarget: true,
        requests: [makeMr('1', 'merged')],
      },
      [{ url: mrUrl('1') }],
      async () => undefined,
    );
    expect(mergedLookup.lookup.cleanupReady).toEqual({
      kind: 'merged-requests',
      reason: 'MR merged',
    });

    const closedIssueLookup = await resolveLookupCleanupReady(
      { kind: 'none', reason: 'The session target is not a PR/MR' },
      [{ url: glIssueUrl('10') }],
      async () => makeGlIssue(false),
    );
    expect(closedIssueLookup.lookup.cleanupReady).toEqual({
      kind: 'closed-issues',
      reason: 'Tracked issue closed',
    });
  });

  test('pruneForeignInboxSession prunes only when foreign instance is not active', async () => {
    const storage = new Map<string, unknown>();
    const inboxKey = `feedback-inbox/${encodeURIComponent('/repo-wt')}`;
    storage.set(inboxKey, {
      paused: false,
      items: [
        { id: 'i1', sessionID: 's1', url: mrUrl('1'), title: 't', links: [], at: 1 },
        { id: 'i2', sessionID: 's2', url: mrUrl('2'), title: 't2', links: [], at: 2 },
      ],
    });
    storage.set(presenceKey('/repo-wt'), { at: 1_000, instance: 'inst', rules: [] });
    const changed: string[] = [];

    // Active foreign instance -> untouched
    await pruneForeignInboxSession({
      storage: {
        get: async (k) => storage.get(k),
        set: async (k, v) => void storage.set(k, v),
      },
      directory: '/repo-wt',
      sessionID: 's1',
      now: () => 1_000,
      changed: (dir) => changed.push(dir),
    });
    expect((storage.get(inboxKey) as { items: unknown[] }).items).toHaveLength(2);
    expect(changed).toEqual([]);

    // Expired foreign instance -> pruned (including bulk Set of sessionIDs)
    storage.set(inboxKey, {
      paused: false,
      items: [
        { id: 'i1', sessionID: 's1', url: mrUrl('1'), title: 't', links: [], at: 1 },
        { id: 'i2', sessionID: 's2', url: mrUrl('2'), title: 't2', links: [], at: 2 },
        { id: 'i3', sessionID: 's3', url: mrUrl('3'), title: 't3', links: [], at: 3 },
      ],
    });
    await pruneForeignInboxSession({
      storage: {
        get: async (k) => storage.get(k),
        set: async (k, v) => void storage.set(k, v),
      },
      directory: '/repo-wt',
      sessionIDs: new Set(['s1', 's3']),
      now: () => 500_000,
      changed: (dir) => changed.push(dir),
    });
    expect((storage.get(inboxKey) as { items: Array<{ sessionID: string }> }).items).toEqual([
      expect.objectContaining({ sessionID: 's2' }),
    ]);
    expect(changed).toEqual(['/repo-wt']);
  });

  test('batches forge state lookups, resolves storedTargetsMap in memory, and reports progress', async () => {
    const mrBatches: Array<{ project: string; numbers: readonly string[] }> = [];
    const issueBatches: Array<{ project: string; numbers: readonly string[] }> = [];
    const fallbackLookups: string[] = [];

    const adapter = (kind: 'gitlab' | 'github'): Forge => ({
      traits: traits(kind),
      findByBranch: async () => [],
      findNumberByBranch: async () => undefined,
      findByNumber: async () => {
        throw new Error('findByNumber should not be called when requestStates is available');
      },
      sourceBranch: async () => undefined,
      requestStates: async (project, numbers) => {
        mrBatches.push({ project: project.path, numbers });
        const map = new Map();
        for (const iid of numbers) {
          map.set(iid, {
            iid,
            title: `MR ${iid}`,
            url: mrUrl(iid, project.path),
            state: 'merged',
            targetProject: project.path,
          });
        }
        return map;
      },
      issueStates: async (project, numbers) => {
        issueBatches.push({ project: project.path, numbers });
        const map = new Map();
        for (const iid of numbers) {
          map.set(iid, { iid, open: false });
        }
        return map;
      },
    });

    const forges: ForgeCatalog = {
      kinds: ['gitlab', 'github'],
      kind: (host) => {
        if (host === 'gitlab.com') return 'gitlab';
        return host === 'github.com' ? 'github' : undefined;
      },
      forHost: (host) => {
        if (host === 'gitlab.com') return adapter('gitlab');
        return host === 'github.com' ? adapter('github') : undefined;
      },
      projects: async () => [],
      repository: async () => ({ kind: 'none', reason: 'not used' }),
    };

    const sessions: ListedSession[] = [
      ...Array.from({ length: 100 }, (_, i) => ({
        id: `untargeted-${i}`,
        projectID: 'proj',
        time: { updated: 10 },
        location: { directory: '/repo' },
      })),
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `mr-session-${i}`,
        title: `Session ${i}`,
        projectID: 'proj',
        time: { updated: 100 + i },
        location: { directory: '/repo' },
      })),
      {
        id: 'forked-mr-session',
        title: 'Forked session',
        projectID: 'proj',
        fork: { sessionID: 'mr-session-0' },
        time: { updated: 200 },
        location: { directory: '/repo' },
      },
      {
        id: 'issue-session',
        title: 'Issue session',
        projectID: 'proj',
        time: { updated: 300 },
        location: { directory: '/repo' },
      },
    ];

    const targetMap = new Map<string, readonly Target[]>(
      Array.from({ length: 30 }, (_, i) => [`mr-session-${i}`, [{ url: mrUrl(String(i + 1)) }]]),
    );
    targetMap.set('issue-session', [
      { url: glIssueUrl('10') },
      { url: ghIssueUrl('20', 'acme/app') },
    ]);

    const progressEvents: CleanupProgressEvent[] = [];
    const scan = await cleanupCandidates({
      projectID: 'proj',
      directory: '/repo',
      forges,
      listSessions: async () => sessions,
      storedTargets: async (id) => {
        fallbackLookups.push(id);
        return [];
      },
      storedTargetsMap: async () => targetMap,
      pendingFeedbackCount: async () => 0,
      onProgress: (event) => progressEvents.push(event),
    });

    // 30 MR sessions + 1 forked MR session + 1 issue session = 32 eligible candidates
    expect(scan.candidates).toHaveLength(32);
    // 100 untargeted sessions and 1 in-memory fork were resolved without calling storedTargets(id)
    expect(fallbackLookups).toEqual([]);
    // 30 MRs in the same project are chunked into 2 batches (25 + 5), not 30 individual calls
    expect(mrBatches).toHaveLength(2);
    expect(mrBatches[0]?.numbers).toHaveLength(25);
    expect(mrBatches[1]?.numbers).toHaveLength(5);
    // 1 GitLab issue batch + 1 GitHub issue batch
    expect(issueBatches).toHaveLength(2);
    expect(progressEvents.some((e) => e.phase === 'targets' && e.total === 32)).toBe(true);
    expect(formatCleanupProgress(undefined, 'scan', 'github')).toBe(
      'Checking sessions for merged PRs and closed issues…',
    );
    expect(formatCleanupProgress(undefined, 'cleanup')).toBe('Verifying and archiving sessions…');
    expect(formatCleanupProgress({ phase: 'sessions', checked: 5, total: 0 })).toBe(
      'Scanning project sessions… (5 found)',
    );
    expect(formatCleanupProgress({ phase: 'targets', checked: 25, total: 32 }, 'scan')).toContain(
      '(25/32)',
    );
    expect(formatCleanupProgress({ phase: 'verifying', checked: 1, total: 2 }, 'cleanup')).toBe(
      'Verifying target status before archiving… (1/2)',
    );
    expect(formatCleanupProgress({ phase: 'archiving', checked: 1, total: 2 }, 'cleanup')).toBe(
      'Archiving sessions… (1/2)',
    );

    // Fork cycles, explicit empty overrides, and mid-scan AbortSignal are handled cleanly:
    const cycleSessions: ListedSession[] = [
      {
        id: 'cycle-a',
        projectID: 'proj',
        fork: { sessionID: 'cycle-b' },
        time: { updated: 1 },
        location: { directory: '/repo' },
      },
      {
        id: 'cycle-b',
        projectID: 'proj',
        fork: { sessionID: 'cycle-a' },
        time: { updated: 2 },
        location: { directory: '/repo' },
      },
      {
        id: 'detached-fork',
        projectID: 'proj',
        fork: { sessionID: 'mr-session-0' },
        time: { updated: 3 },
        location: { directory: '/repo' },
      },
      {
        id: 'hop-1',
        projectID: 'proj',
        fork: { sessionID: 'mr-session-0' },
        time: { updated: 4 },
        location: { directory: '/repo' },
      },
      {
        id: 'hop-2',
        projectID: 'proj',
        fork: { sessionID: 'hop-1' },
        time: { updated: 5 },
        location: { directory: '/repo' },
      },
      {
        id: 'fork-from-archived',
        projectID: 'proj',
        fork: { sessionID: 'archived-parent' },
        time: { updated: 6 },
        location: { directory: '/repo' },
      },
      sessions.find((s) => s.id === 'mr-session-0')!,
    ];
    const cycleMap = new Map(targetMap);
    cycleMap.set('detached-fork', []);
    const archivedFallbackCalls: string[] = [];
    const cycleScan = await cleanupCandidates({
      projectID: 'proj',
      directory: '/repo',
      forges,
      listSessions: async () => cycleSessions,
      storedTargets: async (id) => {
        archivedFallbackCalls.push(id);
        return id === 'fork-from-archived' ? [{ url: mrUrl('1') }] : [];
      },
      storedTargetsMap: async () => cycleMap,
      pendingFeedbackCount: async () => 0,
    });
    expect(cycleScan.candidates.map((c) => c.sessionID).sort()).toEqual([
      'fork-from-archived',
      'hop-1',
      'hop-2',
      'mr-session-0',
    ]);
    expect(archivedFallbackCalls).toEqual(['fork-from-archived']);

    const abortController = new AbortController();
    abortController.abort();
    const abortedScan = await cleanupCandidates({
      projectID: 'proj',
      directory: '/repo',
      forges,
      signal: abortController.signal,
      listSessions: async () => sessions,
      storedTargets: async () => [],
      storedTargetsMap: async () => targetMap,
      pendingFeedbackCount: async () => 0,
    });
    expect(abortedScan.candidates).toEqual([]);
  });

  test('supports client-side archive fallback and deduplicates repeated failure reasons', async () => {
    expect(
      formatCleanupFailures([
        { sessionID: 's1', reason: 'OpenCode did not archive the session.' },
        { sessionID: 's2', reason: 'OpenCode did not archive the session.' },
        { sessionID: 's3', reason: 'Session is currently running' },
      ]),
    ).toBe('OpenCode did not archive the session. (2 sessions); Session is currently running');

    const { forges } = createFakeCatalog({
      mrs: new Map([['group/app#1', makeMr('1', 'merged')]]),
    });
    const sessions = new Map<string, ListedSession>([
      [
        's1',
        {
          id: 's1',
          projectID: 'proj',
          time: { updated: 10 },
          location: { directory: '/repo' },
        },
      ],
      [
        's2',
        {
          id: 's2',
          projectID: 'proj',
          time: { updated: 20 },
          location: { directory: '/repo-wt' },
        },
      ],
    ]);
    const cleaned: Array<{ id: string; directory: string }> = [];

    // Without allowClientArchive, an unsupported server archive fails with a helpful message:
    const unsupportedFailure = await cleanupSessions(['s1'], {
      projectID: 'proj',
      directory: '/repo',
      forges,
      getSession: async (id) => sessions.get(id),
      archiveSession: async () => 'unsupported',
      storedTargets: async () => [{ url: mrUrl('1') }],
      onSessionCleaned: async (id, directory) => void cleaned.push({ id, directory }),
    });
    expect(unsupportedFailure).toEqual({
      archived: [],
      alreadyArchived: [],
      failed: [
        {
          sessionID: 's1',
          reason:
            'OpenCode did not archive the session from the server plugin (use /forge-cleanup in the TUI or Desktop app).',
        },
      ],
    });
    expect(cleaned).toEqual([]);

    // With allowClientArchive, verified eligible sessions return needsClientArchive:
    const delegated = await cleanupSessions(['s1', 's2'], {
      projectID: 'proj',
      directory: '/repo',
      forges,
      allowClientArchive: true,
      getSession: async (id) => sessions.get(id),
      archiveSession: async () => 'unsupported',
      storedTargets: async () => [{ url: mrUrl('1') }],
      onSessionCleaned: async (id, directory) => void cleaned.push({ id, directory }),
    });
    expect(delegated).toEqual({
      archived: [],
      alreadyArchived: [],
      failed: [],
      needsClientArchive: ['s1', 's2'],
    });
    expect(cleaned).toEqual([]);

    // Client archives s1 via HTTP API, while s2 remains unarchived:
    sessions.set('s1', {
      ...sessions.get('s1')!,
      time: { updated: 10, archived: 100 },
    });

    const finalized = await cleanupSessions(['s1', 's2', 'missing'], {
      projectID: 'proj',
      directory: '/repo',
      forges,
      finalizeArchived: true,
      getSession: async (id) => sessions.get(id),
      archiveSession: async () => 'unsupported',
      storedTargets: async () => [{ url: mrUrl('1') }],
      onSessionCleaned: async (id, directory) => void cleaned.push({ id, directory }),
    });
    expect(finalized).toEqual({
      archived: ['s1'],
      alreadyArchived: [],
      failed: [
        { sessionID: 's2', reason: 'OpenCode did not archive the session.' },
        { sessionID: 'missing', reason: 'Session was not found' },
      ],
    });
    expect(cleaned).toEqual([{ id: 's1', directory: '/repo' }]);

    sessions.set('subagent', {
      id: 'subagent',
      parentID: 's1',
      projectID: 'proj',
      time: { updated: 30 },
      location: { directory: '/repo' },
    });
    sessions.set('untargeted', {
      id: 'untargeted',
      projectID: 'proj',
      time: { updated: 40 },
      location: { directory: '/repo' },
    });
    sessions.set('mixed-issues-with-unknown', {
      id: 'mixed-issues-with-unknown',
      projectID: 'proj',
      time: { updated: 50 },
      location: { directory: '/repo' },
    });
    const rejected = await cleanupSessions(
      ['subagent', 'untargeted', 'mixed-issues-with-unknown'],
      {
        projectID: 'proj',
        directory: '/repo',
        forges,
        defaultForge: 'github',
        getSession: async (id) => sessions.get(id),
        archiveSession: async () => 'archived',
        storedTargets: async (id) =>
          id === 'mixed-issues-with-unknown'
            ? [
                { url: glIssueUrl('10') },
                { url: ghIssueUrl('20') },
                { url: 'https://example.com/1' },
              ]
            : [],
        onSessionCleaned: async () => {},
      },
    );
    expect(rejected.failed).toEqual([
      { sessionID: 'subagent', reason: 'Only root sessions can be cleaned up' },
      { sessionID: 'untargeted', reason: 'Session has no tracked PR or issue targets' },
      {
        sessionID: 'mixed-issues-with-unknown',
        reason: 'Session has no tracked PR/MR or issue targets',
      },
    ]);
  });
});
