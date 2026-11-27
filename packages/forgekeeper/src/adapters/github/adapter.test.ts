import { expect, test } from 'bun:test';
import { ForgeError } from '../../forge';
import { checks, ghGraphQL, GitHubForge, type GraphQL } from './adapter';
import { classifyTargets } from '../../target';
import { detailsMessage, responsiveFooterSegments } from '../../format';

const pull = (number = 1) => ({
  number,
  title: 'A PR',
  url: `https://github.com/owner/repo/pull/${number}`,
  state: 'OPEN',
  isDraft: false,
  mergeable: 'UNKNOWN',
  reviewDecision: 'CHANGES_REQUESTED',
  headRefOid: 'abc',
  headRefName: 'feature',
  headRepository: { nameWithOwner: 'fork/repo' },
  baseRepository: { nameWithOwner: 'owner/repo' },
  baseRefName: 'main',
  updatedAt: '2026-10-09',
  reviewThreads: { nodes: [{ isResolved: false }], pageInfo: { hasNextPage: false } },
  reviewRequests: {
    nodes: [{ requestedReviewer: { login: 'human' } }],
    pageInfo: { hasNextPage: false },
  },
  latestOpinionatedReviews: { nodes: [], pageInfo: { hasNextPage: false } },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              nodes: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    ],
  },
});

const projects = [{ host: 'github.com', path: 'owner/repo' }];
const byNumber = (graphql: GraphQL) => new GitHubForge(graphql).findByNumber(projects, '1');

test('normalizes GitHub status without inventing approval requirements', async () => {
  const pr = await byNumber(async () => ({ repository: { pullRequest: pull() } }));
  expect(pr).toMatchObject({
    forge: 'github',
    state: 'opened',
    conflicts: false,
    conflictsKnown: false,
    reviewDecision: 'CHANGES_REQUESTED',
    awaitingReviewers: ['human'],
    unresolvedThreads: 1,
  });
  expect(pr).not.toHaveProperty('approvalRequirementsSatisfied');
  const snapshot = { loading: false, lookup: { kind: 'found' as const, requests: [pr!] } };
  expect(detailsMessage(snapshot)).toContain('Conflicts: unknown');
  expect(detailsMessage(snapshot)).toContain('Review decision: changes requested');
  expect(responsiveFooterSegments(snapshot, 100).map((segment) => segment.text)).toContain('#1');
  expect(responsiveFooterSegments(snapshot, 100).map((segment) => segment.text)).toContain(
    'changes requested',
  );
  for (let width = 0; width < 100; width++)
    expect(
      Bun.stringWidth(
        responsiveFooterSegments(snapshot, width)
          .map((segment) => segment.text)
          .join(' · '),
      ),
    ).toBeLessThanOrEqual(width);
});

test('returns undefined when no project has the PR', async () => {
  expect(await byNumber(async () => ({ repository: { pullRequest: null } }))).toBeUndefined();
  expect(await new GitHubForge(async () => ({})).findByNumber([], '1')).toBeUndefined();
});

test("treats a number that isn't a PR as missing, as gh reports it", async () => {
  // Captured from `gh api graphql` for a number without a PR; gh exits 1.
  const stdout = JSON.stringify({
    data: { repository: { pullRequest: null } },
    errors: [
      {
        type: 'NOT_FOUND',
        path: ['repository', 'pullRequest'],
        message: 'Could not resolve to a PullRequest with the number of 42.',
      },
    ],
  });
  const gh = ghGraphQL(
    async () => ({
      code: 1,
      stdout,
      stderr: 'gh: Could not resolve to a PullRequest with the number of 42.',
    }),
    '/repo',
  );
  expect(await byNumber(gh)).toBeUndefined();

  const mixed = JSON.stringify({
    data: { repository: null },
    errors: [
      { type: 'NOT_FOUND', message: 'missing' },
      { type: 'FORBIDDEN', message: 'Resource not accessible' },
    ],
  });
  await expect(
    ghGraphQL(async () => ({ code: 1, stdout: mixed, stderr: '' }), '/repo')(
      'github.com',
      'query',
      {},
    ),
  ).rejects.toMatchObject({ message: 'Resource not accessible' });
  await expect(
    ghGraphQL(async () => ({ code: 1, stdout: '{}', stderr: 'gh: HTTP 502' }), '/repo')(
      'github.com',
      'query',
      {},
    ),
  ).rejects.toMatchObject({ kind: 'request' });
});

test('check rollup prioritizes failures and never marks partial checks green', () => {
  expect(
    checks(
      [
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'StatusContext', state: 'PENDING' },
      ],
      true,
      'url',
    ),
  ).toMatchObject({ status: 'FAILED', label: '1 check failed, 1 check pending' });
  expect(
    checks([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' }], true, 'url')
      .status,
  ).toBe('SUCCESS');
  expect(checks([], false, 'url').status).toBe('PENDING');
  expect(
    checks(
      [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEW_UNKNOWN_VALUE' }],
      true,
      'url',
    ).status,
  ).toBe('PENDING');
});

test('check rollup names the failed checks of a commit while others still run', () => {
  const rollup = checks(
    [
      {
        __typename: 'CheckRun',
        id: 'CR_1',
        name: 'test',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: 'https://github.com/o/r/actions/runs/1',
      },
      { __typename: 'StatusContext', id: 'SC_1', context: 'ci/legacy', state: 'ERROR' },
      { __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS' },
    ],
    true,
    'url',
    'abc123',
  );
  expect(rollup).toMatchObject({
    status: 'FAILED',
    id: 'abc123',
    running: true,
    failedJobsComplete: true,
    failedJobs: [
      { id: 'CR_1', name: 'test', url: 'https://github.com/o/r/actions/runs/1' },
      { id: 'SC_1', name: 'ci/legacy' },
    ],
  });
  // Without the commit, the checks aren't one identified run.
  expect(checks([], true, 'url').id).toBeUndefined();
});

test('check rollup separates cancellations and stale checks from failures', () => {
  for (const conclusion of [
    'FAILURE',
    'ERROR',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
  ]) {
    expect(
      checks(
        [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion }],
        true,
        'url',
        'sha',
      ),
    ).toMatchObject({ status: 'FAILED', failedJobs: [{ name: 'test' }] });
  }
  const cancelled = Array.from({ length: 9 }, (_, index) => ({
    __typename: 'CheckRun',
    name: `cancelled-${index}`,
    status: 'COMPLETED',
    conclusion: 'CANCELLED',
  }));
  expect(checks(cancelled, true, 'url', 'sha')).toMatchObject({
    status: 'CANCELLED',
    label: '9 checks cancelled',
    failedJobs: [],
  });
  expect(
    checks(
      [
        ...cancelled,
        { __typename: 'CheckRun', name: 'aggregate', status: 'COMPLETED', conclusion: 'FAILURE' },
      ],
      true,
      'url',
      'sha',
    ),
  ).toMatchObject({
    status: 'FAILED',
    label: '1 check failed, 9 checks cancelled',
    failedJobs: [{ name: 'aggregate' }],
  });
  expect(
    checks([...cancelled, { __typename: 'CheckRun', status: 'QUEUED' }], true, 'url', 'sha'),
  ).toMatchObject({
    status: 'PENDING',
    label: '9 checks cancelled, 1 check pending',
    failedJobs: [],
  });
  expect(checks(cancelled, false, 'url').status).toBe('PENDING');
  expect(
    checks([{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'STALE' }], true, 'url'),
  ).toMatchObject({ status: 'CANCELLED', label: '1 check stale' });
});

test('check rollup selects newer attempts without merging different workflows or apps', () => {
  const attempt = (
    id: string,
    conclusion: string,
    createdAt: string,
    workflow = 'workflow',
    app = 'actions',
  ) => ({
    __typename: 'CheckRun',
    id,
    name: 'test',
    status: 'COMPLETED',
    conclusion,
    startedAt: createdAt,
    checkSuite: { createdAt, app: { id: app }, workflowRun: { workflow: { id: workflow } } },
  });
  const old = attempt('old', 'FAILURE', '2026-11-14T10:00:00Z');
  const passed = attempt('new', 'SUCCESS', '2026-11-14T11:00:00Z');
  for (const nodes of [
    [old, passed],
    [passed, old],
  ]) {
    expect(checks(nodes, true, 'url', 'sha')).toMatchObject({
      status: 'SUCCESS',
      label: '1 check passed',
      failedJobs: [],
    });
    expect(checks(nodes, false, 'url').status).toBe('PENDING');
  }
  expect(
    checks([passed, old, attempt('other', 'FAILURE', old.startedAt, 'other')], true, 'url', 'sha'),
  ).toMatchObject({ status: 'FAILED', failedJobs: [{ id: 'other' }] });
  expect(
    checks(
      [passed, attempt('other', 'FAILURE', old.startedAt, 'workflow', 'other')],
      true,
      'url',
      'sha',
    ),
  ).toMatchObject({ status: 'FAILED', failedJobs: [{ id: 'other' }] });
  expect(
    checks(
      [old, { ...passed, status: 'QUEUED', conclusion: '', startedAt: null }],
      true,
      'url',
      'sha',
    ),
  ).toMatchObject({ status: 'PENDING', failedJobs: [] });
  expect(
    checks(
      [
        old,
        {
          ...passed,
          startedAt: 'invalid',
          checkSuite: { ...passed.checkSuite, createdAt: 'invalid' },
        },
      ],
      true,
      'url',
      'sha',
    ).status,
  ).toBe('FAILED');
  expect(
    checks(
      [
        { ...old, checkSuite: null },
        { ...passed, checkSuite: null },
      ],
      true,
      'url',
      'sha',
    ).status,
  ).toBe('FAILED');
});

test('newer workflows supersede old jobs even when the old job started later', () => {
  const old = {
    __typename: 'CheckRun',
    name: 'aggregate',
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    startedAt: '2026-11-14T23:48:00Z',
    checkSuite: {
      createdAt: '2026-11-14T23:45:38Z',
      app: { id: 'actions' },
      workflowRun: { workflow: { id: 'ci' } },
    },
  };
  const replacement = {
    ...old,
    conclusion: 'SUCCESS',
    startedAt: '2026-11-14T23:46:38Z',
    checkSuite: { ...old.checkSuite, createdAt: '2026-11-14T23:45:41Z' },
  };
  expect(checks([replacement, old], true, 'url', 'sha')).toMatchObject({
    status: 'SUCCESS',
    failedJobs: [],
  });
  expect(
    checks([old, { ...replacement, checkSuite: old.checkSuite }], true, 'url', 'sha'),
  ).toMatchObject({ status: 'FAILED' });
});

test('keeps distinct same-name jobs and ambiguous retries within one workflow suite', () => {
  const failed = {
    __typename: 'CheckRun',
    id: 'linux',
    name: 'test',
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    startedAt: '2026-11-14T10:01:00Z',
    checkSuite: {
      createdAt: '2026-11-14T10:00:00Z',
      app: { id: 'actions' },
      workflowRun: { workflow: { id: 'ci' } },
    },
  };
  const passed = {
    ...failed,
    id: 'macos',
    conclusion: 'SUCCESS',
    startedAt: '2026-11-14T10:02:00Z',
  };
  for (const nodes of [
    [failed, passed],
    [passed, failed],
  ]) {
    expect(checks(nodes, true, 'url', 'sha')).toMatchObject({
      status: 'FAILED',
      failedJobs: [{ id: 'linux' }],
    });
  }
  expect(
    checks(
      [failed, { ...passed, id: 'retry', status: 'QUEUED', conclusion: '', startedAt: null }],
      true,
      'url',
      'sha',
    ),
  ).toMatchObject({
    status: 'FAILED',
    running: true,
    failedJobs: [{ id: 'linux' }],
  });
  expect(
    checks(
      [
        { ...failed, checkSuite: { ...failed.checkSuite, workflowRun: null } },
        {
          ...passed,
          checkSuite: {
            ...passed.checkSuite,
            createdAt: '2026-11-14T11:00:00Z',
            workflowRun: null,
          },
        },
      ],
      true,
      'url',
      'sha',
    ),
  ).toMatchObject({
    status: 'FAILED',
    failedJobs: [{ id: 'linux' }],
  });
});

test('deduplicates old failures after reading later check pages', async () => {
  const first = pull();
  const contexts = first.commits.nodes[0].commit.statusCheckRollup.contexts;
  const check = {
    __typename: 'CheckRun',
    name: 'aggregate',
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    startedAt: '2026-11-14T23:45:47Z',
    checkSuite: {
      createdAt: '2026-11-14T23:45:38Z',
      app: { id: 'actions' },
      workflowRun: { workflow: { id: 'ci' } },
    },
  };
  Object.assign(contexts, { nodes: [check], pageInfo: { hasNextPage: true, endCursor: 'next' } });
  const pr = await byNumber(async (_host, query, variables) => {
    expect(query).toContain(
      'startedAt checkSuite { createdAt app { id } workflowRun { workflow { id } } }',
    );
    if (!variables.after) return { repository: { pullRequest: first } };
    return {
      repository: {
        object: {
          statusCheckRollup: {
            contexts: {
              nodes: [
                {
                  ...check,
                  conclusion: 'SUCCESS',
                  startedAt: '2026-11-14T23:46:38Z',
                  checkSuite: { ...check.checkSuite, createdAt: '2026-11-14T23:45:41Z' },
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    };
  });
  expect(pr?.pipeline).toMatchObject({
    status: 'SUCCESS',
    label: '1 check passed',
    failedJobs: [],
  });
});

test('normalizes active GitHub approvers and excludes pending re-reviews', async () => {
  const pr = await byNumber(async () => ({
    repository: {
      pullRequest: {
        ...pull(),
        reviewRequests: {
          nodes: [
            { requestedReviewer: { __typename: 'User', id: 'U_BOB', login: 'bob' } },
            { requestedReviewer: { __typename: 'Bot', id: 'B_PENDING', login: 'pending-bot' } },
          ],
          pageInfo: { hasNextPage: false },
        },
        latestReviews: {
          nodes: [
            {
              id: 'R_ALICE_COMMENT',
              state: 'COMMENTED',
              author: { __typename: 'User', id: 'U_ALICE', login: 'alice' },
            },
            {
              id: 'R_MANNEQUIN',
              state: 'COMMENTED',
              author: { __typename: 'Mannequin', id: 'M_1', login: 'ghost' },
            },
          ],
        },
        latestOpinionatedReviews: {
          nodes: [
            {
              id: 'R_ALICE',
              state: 'APPROVED',
              author: { __typename: 'User', id: 'U_ALICE', login: 'alice' },
            },
            {
              id: 'R_BOB',
              state: 'APPROVED',
              author: { __typename: 'User', id: 'U_BOB', login: 'bob' },
            },
            {
              id: 'R_CAROL',
              state: 'CHANGES_REQUESTED',
              author: { __typename: 'User', id: 'U_CAROL', login: 'carol' },
            },
            {
              id: 'R_SEC',
              state: 'APPROVED',
              author: { __typename: 'Bot', id: 'B_SEC', login: 'sec' },
            },
            {
              id: 'R_PENDING',
              state: 'APPROVED',
              author: { __typename: 'Bot', id: 'B_PENDING', login: 'pending-bot' },
            },
            {
              id: 'R_1',
              state: 'APPROVED',
              author: {
                __typename: 'Bot',
                id: 'B_COPILOT',
                login: 'copilot-pull-request-reviewer',
              },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
        copilotReviews: {
          nodes: [
            {
              id: 'R_1',
              state: 'APPROVED',
              comments: { totalCount: 0 },
              author: {
                __typename: 'Bot',
                id: 'B_COPILOT',
                login: 'copilot-pull-request-reviewer',
              },
            },
          ],
        },
      },
    },
  }));
  expect(pr?.approvers).toEqual([
    { id: 'U_ALICE', username: 'alice', reviewID: 'R_ALICE' },
    { id: 'B_SEC', username: 'sec[bot]', bot: true, reviewID: 'R_SEC' },
    {
      id: 'B_COPILOT',
      username: 'copilot-pull-request-reviewer[bot]',
      bot: true,
      automated: true,
      reviewID: 'R_1',
    },
  ]);
  expect(pr?.reviewerIDs).toEqual(['U_BOB', 'U_ALICE', 'U_CAROL']);
  expect(pr?.approvalsComplete).toBe(true);
});

test('never classifies a human User as Copilot or Bot and matches pending requests by ID first', async () => {
  const pr = await byNumber(async () => ({
    repository: {
      pullRequest: {
        ...pull(),
        reviewRequests: {
          nodes: [{ requestedReviewer: { __typename: 'User', id: 'U_SEC', login: 'sec' } }],
          pageInfo: { hasNextPage: false },
        },
        latestOpinionatedReviews: {
          nodes: [
            {
              id: 'R_HUMAN_COPILOT',
              state: 'APPROVED',
              author: {
                __typename: 'User',
                id: 'U_COPILOT',
                login: 'copilot-pull-request-reviewer',
              },
            },
            {
              id: 'R_BOT_SEC',
              state: 'APPROVED',
              author: { __typename: 'Bot', id: 'B_SEC', login: 'sec' },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
        copilotReviews: {
          nodes: [
            {
              id: 'R_HUMAN_COPILOT',
              state: 'APPROVED',
              comments: { totalCount: 0 },
              author: {
                __typename: 'User',
                id: 'U_COPILOT',
                login: 'copilot-pull-request-reviewer',
              },
            },
          ],
        },
      },
    },
  }));
  // Human User keeps bare login and has neither bot nor automated flags.
  // Bot `sec[bot]` is NOT suppressed by pending human User `sec` with distinct ID.
  expect(pr?.approvers).toEqual([
    { id: 'U_COPILOT', username: 'copilot-pull-request-reviewer', reviewID: 'R_HUMAN_COPILOT' },
    { id: 'B_SEC', username: 'sec[bot]', bot: true, reviewID: 'R_BOT_SEC' },
  ]);
});

test('paginates latestOpinionatedReviews and marks truncated pages incomplete', async () => {
  const pr = await byNumber(async (_host, query, variables) => {
    if (query.includes('latestOpinionatedReviews(first:100,after:$after)')) {
      expect(variables.after).toBe('rev-1');
      return {
        repository: {
          pullRequest: {
            latestOpinionatedReviews: {
              nodes: [
                {
                  id: 'R_BOB',
                  state: 'APPROVED',
                  author: { __typename: 'User', id: 'U_BOB', login: 'bob' },
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      };
    }
    return {
      repository: {
        pullRequest: {
          ...pull(),
          latestOpinionatedReviews: {
            nodes: [
              {
                id: 'R_ALICE',
                state: 'APPROVED',
                author: { __typename: 'User', id: 'U_ALICE', login: 'alice' },
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: 'rev-1' },
          },
        },
      },
    };
  });
  expect(pr?.approvalsComplete).toBe(true);
  expect(pr?.approvers?.map((entry) => entry.username)).toEqual(['alice', 'bob']);

  const truncated = await byNumber(async () => ({
    repository: {
      pullRequest: {
        ...pull(),
        latestOpinionatedReviews: {
          nodes: [],
          pageInfo: { hasNextPage: true },
        },
      },
    },
  }));
  expect(truncated?.approvalsComplete).toBe(false);

  // Null first connection is never treated as a complete empty list.
  const missing = await byNumber(async () => ({
    repository: {
      pullRequest: {
        ...pull(),
        latestOpinionatedReviews: null,
      },
    },
  }));
  expect(missing?.approvalsComplete).toBe(false);
});

test('markReady runs markPullRequestReadyForReview for a draft GitHub PR', async () => {
  const queries: string[] = [];
  const forge = new GitHubForge(async (_host, query) => {
    queries.push(query);
    if (query.includes('markPullRequestReadyForReview')) {
      return {
        markPullRequestReadyForReview: { pullRequest: { id: 'PR_1', isDraft: false } },
      };
    }
    return {
      repository: { pullRequest: { id: 'PR_1', isDraft: true, state: 'OPEN' } },
    };
  });
  await forge.markReady({ forge: 'github', host: 'github.com', project: 'o/r', iid: '7' });
  expect(queries).toHaveLength(2);
  expect(queries[1]).toContain('markPullRequestReadyForReview');
});

test('check rollup distinguishes passed, skipped, and neutral checks', () => {
  const passed = [
    { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'StatusContext', state: 'SUCCESS' },
  ];
  expect(checks(passed, true, 'url')).toEqual({
    status: 'SUCCESS',
    label: '2 checks passed',
    url: 'url',
  });
  expect(
    checks(
      [
        ...passed,
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
        { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'NEUTRAL' },
      ],
      true,
      'url',
    ),
  ).toMatchObject({
    status: 'SUCCESS',
    label: '2 checks passed, 1 check skipped, 1 check neutral',
  });
});

test('filters same-named branches from other forks and deduplicates remotes', async () => {
  const forge = new GitHubForge(async () => ({
    repository: {
      pullRequests: {
        nodes: [pull(), { ...pull(2), headRepository: { nameWithOwner: 'other/repo' } }],
        pageInfo: { hasNextPage: false },
      },
    },
  }));
  const pr = await forge.findByBranch({
    head: 'abc',
    branch: 'feature',
    sourceBranch: 'feature',
    source: { host: 'github.com', path: 'fork/repo' },
    targets: [
      { host: 'github.com', path: 'owner/repo' },
      { host: 'github.com', path: 'fork/repo' },
    ],
  });
  expect(pr.map((item) => item.iid)).toEqual(['1']);
});

test('finds the newest PR number from the source fork without reading status', async () => {
  const queries: string[] = [];
  const forge = new GitHubForge(async (_host, query, variables) => {
    queries.push(query);
    const nodes =
      variables.repo === 'repo' && variables.owner === 'owner'
        ? [
            {
              number: 3,
              updatedAt: '2026-10-09T00:00:00Z',
              headRepository: { nameWithOwner: 'other/repo' },
            },
            {
              number: 1,
              updatedAt: '2026-10-01T00:00:00Z',
              headRepository: { nameWithOwner: 'Fork/Repo' },
            },
          ]
        : [
            {
              number: 2,
              updatedAt: '2026-10-05T00:00:00Z',
              headRepository: { nameWithOwner: 'fork/repo' },
            },
          ];
    return { repository: { pullRequests: { nodes } } };
  });
  const number = await forge.findNumberByBranch({
    head: 'abc',
    branch: 'feature',
    sourceBranch: 'feature',
    source: { host: 'github.com', path: 'fork/repo' },
    targets: [
      { host: 'github.com', path: 'owner/repo' },
      { host: 'github.com', path: 'fork/repo' },
    ],
  });
  expect(number).toBe('2');
  expect(queries.every((query) => !query.includes('reviewThreads'))).toBe(true);
});

test("reads a PR's source branch and treats a missing PR as unknown", async () => {
  const ref = { forge: 'github' as const, host: 'github.com', project: 'owner/repo', iid: '7' };
  let seen: Record<string, string | number> = {};
  const forge = new GitHubForge(async (_host, _query, variables) => {
    seen = variables;
    return { repository: { pullRequest: { headRefName: '34-fix' } } };
  });
  expect(await forge.sourceBranch(ref)).toBe('34-fix');
  expect(seen).toEqual({ owner: 'owner', repo: 'repo', number: 7 });
  expect(
    await new GitHubForge(async () => ({ repository: { pullRequest: null } })).sourceBranch(ref),
  ).toBeUndefined();
});

test('reads a GitHub issue state and canonical URL, handles missing objects, and propagates errors', async () => {
  const ref = {
    forge: 'github' as const,
    host: 'ghe.example.com',
    project: 'acme/platform',
    iid: '9',
  };
  let seen: { host: string; query: string; variables: Record<string, string | number> } | undefined;
  const openForge = new GitHubForge(async (host, query, variables) => {
    seen = { host, query, variables };
    return {
      repository: {
        issue: { state: 'OPEN', url: 'https://ghe.example.com/acme/platform/issues/9' },
      },
    };
  });
  expect(await openForge.issue(ref)).toEqual({
    forge: 'github',
    open: true,
    url: 'https://ghe.example.com/acme/platform/issues/9',
  });
  expect(seen?.host).toBe('ghe.example.com');
  expect(seen?.variables).toEqual({ owner: 'acme', repo: 'platform', number: 9 });
  expect(seen?.query).toContain('issue(number:$number) { state url }');
  expect(seen?.query).not.toContain('issueOrPullRequest');

  const closedForge = new GitHubForge(async () => ({
    repository: {
      issue: { state: 'CLOSED', url: 'https://ghe.example.com/acme/platform/issues/9' },
    },
  }));
  expect(await closedForge.issue(ref)).toEqual({
    forge: 'github',
    open: false,
    url: 'https://ghe.example.com/acme/platform/issues/9',
  });

  expect(await new GitHubForge(async () => ({ repository: null })).issue(ref)).toBeUndefined();
  expect(
    await new GitHubForge(async () => ({ repository: { issue: null } })).issue(ref),
  ).toBeUndefined();
  expect(
    await new GitHubForge(async () => ({
      repository: {
        issue: { state: 'UNKNOWN', url: 'https://ghe.example.com/acme/platform/issues/9' },
      },
    })).issue(ref),
  ).toBeUndefined();
  await expect(
    new GitHubForge(async () => {
      throw new Error('rate limit');
    }).issue(ref),
  ).rejects.toThrow('rate limit');
});

test('uses typed integer GraphQL variables and classifies missing gh', async () => {
  const args: string[][] = [];
  const gh = ghGraphQL(async (_file, input) => {
    args.push(input);
    return {
      code: 0,
      stdout: JSON.stringify({ data: { repository: { pullRequest: pull() } } }),
      stderr: '',
    };
  }, '/repo');
  await byNumber(gh);
  expect(args[0]).toContain('number=1');
  expect(args[0][args[0].indexOf('number=1') - 1]).toBe('-F');
  await expect(
    ghGraphQL(async () => ({ code: -1, stdout: '', stderr: 'spawn gh ENOENT' }), '/repo')(
      'github.com',
      'query',
      {},
    ),
  ).rejects.toMatchObject({ kind: 'missing-gh' });
});

test('classifies PR targets separately from issues', () => {
  expect(classifyTargets({ url: 'https://github.com/owner/repo/pull/42' })).toMatchObject([
    { kind: 'merge-request', ref: { forge: 'github', iid: '42' } },
  ]);
  expect(classifyTargets({ url: 'https://github.com/owner/repo/issues/42' })).toMatchObject([
    { kind: 'other' },
  ]);
});

test('loads subsequent unresolved-thread pages', async () => {
  const first = pull();
  first.reviewThreads.pageInfo = {
    hasNextPage: true,
    endCursor: 'next',
  } as typeof first.reviewThreads.pageInfo;
  const pr = await byNumber(async (_host, query) =>
    query.includes('$after')
      ? {
          repository: {
            pullRequest: {
              reviewThreads: { nodes: [{ isResolved: false }], pageInfo: { hasNextPage: false } },
            },
          },
        }
      : { repository: { pullRequest: first } },
  );
  expect(pr?.unresolvedThreads).toBe(2);
  expect(pr?.threadsComplete).toBe(true);
});

test('loads check pages and distinguishes authentication from rate limits', async () => {
  const first = pull();
  const contexts = first.commits.nodes[0].commit.statusCheckRollup.contexts;
  contexts.nodes = [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  contexts.pageInfo = { hasNextPage: true, endCursor: 'checks' } as typeof contexts.pageInfo;
  const pr = await byNumber(async (_host, query) =>
    query.includes('$oid')
      ? {
          repository: {
            object: {
              statusCheckRollup: {
                contexts: {
                  nodes: [{ __typename: 'StatusContext', state: 'PENDING' }],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        }
      : { repository: { pullRequest: first } },
  );
  expect(pr?.pipeline).toMatchObject({ status: 'PENDING', label: '1 check pending' });
  for (const [message, kind] of [
    ['API rate limit exceeded', 'rate-limit'],
    ['401 authentication failed', 'auth'],
  ]) {
    const gh = ghGraphQL(
      async () => ({ code: 1, stdout: JSON.stringify({ errors: [{ message }] }), stderr: '' }),
      '/repo',
    );
    await expect(gh('github.com', 'query', {})).rejects.toMatchObject({ kind });
  }
});

const copilot = { __typename: 'Bot', login: 'copilot-pull-request-reviewer' };
const copilotReviewOf = (requested: boolean, review?: { id: string; comments: number }) => {
  const node = pull();
  node.reviewRequests.nodes = [
    { requestedReviewer: { login: 'human' } },
    ...(requested ? [{ requestedReviewer: copilot }] : []),
  ];
  return {
    ...node,
    copilotReviews: {
      nodes: review ? [{ id: review.id, comments: { totalCount: review.comments } }] : [],
    },
  };
};

test("reads Copilot's review from the pending reviewers and its newest review", async () => {
  const read = async (node: ReturnType<typeof copilotReviewOf>) =>
    (await byNumber(async () => ({ repository: { pullRequest: node } })))?.copilotReview;
  expect(await read(copilotReviewOf(false))).toBeUndefined();
  expect(await read(copilotReviewOf(true))).toEqual({
    requested: true,
    reviewID: undefined,
    comments: 0,
  });
  expect(await read(copilotReviewOf(false, { id: 'R_1', comments: 2 }))).toEqual({
    requested: false,
    reviewID: 'R_1',
    comments: 2,
  });
  expect(await read(copilotReviewOf(true, { id: 'R_1', comments: 2 }))).toEqual({
    requested: true,
    reviewID: 'R_1',
    comments: 2,
  });
});

test('never lists a bot reviewer as awaiting review', async () => {
  const pr = await byNumber(async () => ({
    repository: { pullRequest: copilotReviewOf(true) },
  }));
  expect(pr?.awaitingReviewers).toEqual(['human']);
});

test('finds Copilot on a later page of pending reviewers', async () => {
  const node = pull();
  const first = {
    ...node,
    reviewRequests: {
      nodes: node.reviewRequests.nodes,
      pageInfo: { hasNextPage: true, endCursor: 'reviewers' },
    },
  };
  const pr = await byNumber(async (_host, text) => ({
    repository: {
      pullRequest: text.includes('reviewRequests(first:100,after:')
        ? {
            reviewRequests: {
              nodes: [{ requestedReviewer: copilot }],
              pageInfo: { hasNextPage: false },
            },
          }
        : first,
    },
  }));
  expect(pr?.copilotReview?.requested).toBe(true);
  expect(pr?.awaitingReviewers).toEqual(['human']);
  expect(pr?.reviewersComplete).toBe(true);
});

test('copes with a response that has no Copilot reviews', async () => {
  const pr = await byNumber(async () => ({ repository: { pullRequest: pull() } }));
  expect(pr?.copilotReview).toBeUndefined();
});

test("asks for Copilot's newest submitted review by its author login", async () => {
  const queries: string[] = [];
  await byNumber(async (_host, query) => {
    queries.push(query);
    return { repository: { pullRequest: pull() } };
  });
  expect(queries[0]).toContain('author:"copilot-pull-request-reviewer[bot]"');
  expect(queries[0]).toContain('reviews(last:1');
});

test("lists requested reviewers' and past reviewers' account IDs once each", async () => {
  const pr = await byNumber(async () => ({
    repository: {
      pullRequest: {
        ...pull(),
        reviewRequests: {
          nodes: [
            { requestedReviewer: { __typename: 'User', login: 'human', id: 'U_1' } },
            { requestedReviewer: { __typename: 'Team', name: 'team' } },
          ],
          pageInfo: { hasNextPage: false },
        },
        latestReviews: { nodes: [{ author: { id: 'U_2' } }, { author: { id: 'U_1' } }, null] },
      },
    },
  }));
  expect(pr?.reviewerIDs).toEqual(['U_1', 'U_2']);
});

test('markReady runs beforeMutate after lookup and aborts before sending the mutation', async () => {
  let releaseLookup!: () => void;
  let lookupStarted!: () => void;
  const started = new Promise<void>((resolve) => (lookupStarted = resolve));
  const mutations: string[] = [];
  const transport: GraphQL = async (_host, queryText) => {
    if (queryText.includes('markPullRequestReadyForReview')) {
      mutations.push(queryText);
      return { markPullRequestReadyForReview: { pullRequest: { id: 'PR_1', isDraft: false } } };
    }
    lookupStarted();
    await new Promise<void>((resolve) => (releaseLookup = resolve));
    return { repository: { pullRequest: { id: 'PR_1', isDraft: true, state: 'OPEN' } } };
  };
  let cancelled = false;
  const pending = new GitHubForge(transport).markReady(
    { forge: 'github', host: 'github.com', project: 'owner/repo', iid: '1' },
    {
      beforeMutate: () => {
        if (cancelled) throw new Error('Approval follow-up was cancelled.');
      },
    },
  );
  await started;
  cancelled = true;
  releaseLookup();
  await expect(pending).rejects.toThrow('cancelled');
  expect(mutations).toEqual([]);
});

test('requestStates and issueStates batch GitHub PR and issue numbers', async () => {
  const seenVariables: Array<Record<string, string | number>> = [];
  const forge = new GitHubForge(async (_host, queryText, variables) => {
    seenVariables.push(variables);
    if (queryText.includes('pullRequest')) {
      return {
        repository: {
          pr0: {
            number: 1,
            title: 'PR 1',
            url: 'https://github.com/owner/repo/pull/1',
            state: 'MERGED',
            baseRepository: { nameWithOwner: 'owner/repo' },
          },
          pr1: null,
          pr2: { number: 3, title: 'Missing state', url: 'https://github.com/owner/repo/pull/3' },
        },
      };
    }
    return {
      repository: {
        // Issue #10 was transferred to another repo with number 11 and closed; must NOT overwrite #11!
        i0: { number: 11, state: 'CLOSED', url: 'https://github.com/owner/other/issues/11' },
        i1: { number: 11, state: 'OPEN', url: 'https://github.com/owner/repo/issues/11' },
      },
    };
  });
  const prs = await forge.requestStates({ host: 'github.com', path: 'owner/repo' }, [
    '1',
    '2',
    '3',
  ]);
  expect(prs.get('1')).toEqual({
    iid: '1',
    title: 'PR 1',
    url: 'https://github.com/owner/repo/pull/1',
    state: 'merged',
    targetProject: 'owner/repo',
  });
  expect(prs.has('2')).toBe(false);
  expect(prs.has('3')).toBe(false);

  const issues = await forge.issueStates({ host: 'github.com', path: 'owner/repo' }, ['10', '11']);
  expect(issues.has('10')).toBe(false);
  expect(issues.get('11')).toEqual({ iid: '11', open: true });
  expect(seenVariables[0]).toEqual({ owner: 'owner', repo: 'repo', n0: 1, n1: 2, n2: 3 });
  expect(seenVariables[1]).toEqual({ owner: 'owner', repo: 'repo', n0: 10, n1: 11 });

  // Splits chunks on request errors and preserves valid siblings when a single leaf fails,
  // while auth/rate-limit errors reject without splitting:
  const splitVars: Array<Record<string, string | number>> = [];
  const splitForge = new GitHubForge(async (_host, _query, variables) => {
    splitVars.push(variables);
    if ('n1' in variables) throw new ForgeError('request', 'Forbidden on one item');
    if (variables.n0 === 2) throw new ForgeError('request', 'Forbidden on PR 2');
    const num = Number(variables.n0);
    return {
      repository: {
        pr0: {
          number: num,
          title: `PR ${num}`,
          url: `https://github.com/owner/repo/pull/${num}`,
          state: 'MERGED',
          baseRepository: { nameWithOwner: 'owner/repo' },
        },
      },
    };
  });
  const splitPrs = await splitForge.requestStates({ host: 'github.com', path: 'owner/repo' }, [
    '1',
    '2',
    '3',
  ]);
  expect(splitPrs.get('1')?.state).toBe('merged');
  expect(splitPrs.has('2')).toBe(false);
  expect(splitPrs.get('3')?.state).toBe('merged');

  for (const kind of ['auth', 'rate-limit'] as const) {
    let attempts = 0;
    const failForge = new GitHubForge(async () => {
      attempts++;
      throw new ForgeError(kind, `${kind} failed`);
    });
    await expect(
      failForge.issueStates({ host: 'github.com', path: 'owner/repo' }, ['1', '2']),
    ).rejects.toMatchObject({ kind });
    expect(attempts).toBe(1);
  }
});
