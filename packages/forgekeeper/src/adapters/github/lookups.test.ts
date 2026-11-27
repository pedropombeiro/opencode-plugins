import { expect, test } from 'bun:test';
import { ForgeError } from '../../forge';
import { classifyTargets } from '../../target';
import { ghGraphQL, GitHubForge } from './adapter';
import { byNumber, pull } from './testing';

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
