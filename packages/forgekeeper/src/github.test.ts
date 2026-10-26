import { expect, test } from 'bun:test';
import { checks, ghGraphQL, GitHubForge, type GraphQL } from './github';
import { classifyTargets } from './target';
import { detailsMessage, responsiveFooterSegments } from './format';

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
  ).toMatchObject({ status: 'FAILED', label: '1 failed, 1 pending' });
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
  expect(pr?.pipeline).toMatchObject({ status: 'PENDING', label: '1 pending' });
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
