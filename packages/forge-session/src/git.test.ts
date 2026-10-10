import { describe, expect, test } from 'bun:test';
import type { Exec } from './exec';
import { parseRemote, resolveProjects, resolveRepository } from './git';

const onGitLab = (host: string) => host === 'gitlab.com';

describe('resolveProjects', () => {
  test('lists GitLab remotes with origin first', async () => {
    const run = fakeGit({
      'config --get-regexp ^remote\\..*\\.url$': [
        'remote.security.url git@gitlab.com:gitlab-org/security/gitlab.git',
        'remote.github.url git@github.com:me/gitlab.git',
        'remote.origin.url git@gitlab.com:gitlab-org/gitlab.git',
      ].join('\n'),
    });
    expect(await resolveProjects(run, '/repo', onGitLab)).toEqual({
      kind: 'projects',
      projects: [
        { host: 'gitlab.com', path: 'gitlab-org/gitlab' },
        { host: 'gitlab.com', path: 'gitlab-org/security/gitlab' },
      ],
    });
  });

  test('reports a checkout without GitLab remotes', async () => {
    const run = fakeGit({
      'config --get-regexp ^remote\\..*\\.url$': 'remote.origin.url git@github.com:me/x.git',
    });
    expect(await resolveProjects(run, '/repo', onGitLab)).toEqual({
      kind: 'none',
      reason: 'No matching forge remote',
    });
  });
});

describe('parseRemote', () => {
  test.each([
    ['git@gitlab.com:gitlab-org/gitlab.git', { host: 'gitlab.com', path: 'gitlab-org/gitlab' }],
    [
      'ssh://git@gitlab.com:2222/group/sub/project.git',
      { host: 'gitlab.com', path: 'group/sub/project' },
    ],
    ['https://oauth2@GitLab.com/group/project/', { host: 'gitlab.com', path: 'group/project' }],
    ['gitlab.com:group/project', { host: 'gitlab.com', path: 'group/project' }],
  ])('parses %s', (url, expected) => {
    expect(parseRemote(url)).toEqual(expected);
  });

  test.each(['/srv/repo.git', 'file:///srv/repo.git', 'https://gitlab.com/project', 'not a url'])(
    'rejects %s',
    (url) => {
      expect(parseRemote(url)).toBeUndefined();
    },
  );
});

type Responses = Record<string, string | undefined>;

function fakeGit(responses: Responses): Exec {
  return async (_file, args) => {
    const output = responses[args.join(' ')];
    return output === undefined
      ? { stdout: '', stderr: 'fatal', code: 128 }
      : { stdout: `${output}\n`, stderr: '', code: 0 };
  };
}

const REFS =
  'for-each-ref --format=%(push:remotename)%00%(push:remoteref)%00%(upstream:remotename)%00%(upstream:remoteref) refs/heads/feature';

const base: Responses = {
  'rev-parse --show-toplevel': '/repo',
  'symbolic-ref --quiet --short HEAD': 'feature',
  'rev-parse HEAD': 'abc123',
  'config --get-regexp ^remote\\..*\\.url$': [
    'remote.origin.url git@gitlab.com:me/project.git',
    'remote.upstream.url https://gitlab.com/group/project.git',
    'remote.github.url git@github.com:me/project.git',
  ].join('\n'),
  [REFS]: 'origin\0refs/heads/remote-feature\0origin\0refs/heads/remote-feature',
  'symbolic-ref --quiet --short refs/remotes/origin/HEAD': 'origin/main',
};

describe('resolveRepository', () => {
  test('uses the push branch and includes same-host remotes as targets', async () => {
    const lookup = await resolveRepository(fakeGit(base), '/repo', onGitLab);
    expect(lookup).toEqual({
      kind: 'repository',
      repository: {
        head: 'abc123',
        branch: 'feature',
        sourceBranch: 'remote-feature',
        source: { host: 'gitlab.com', path: 'me/project' },
        targets: [
          { host: 'gitlab.com', path: 'me/project' },
          { host: 'gitlab.com', path: 'group/project' },
        ],
      },
    });
  });

  test('falls back to origin and the local branch name without tracking', async () => {
    const lookup = await resolveRepository(
      fakeGit({ ...base, [REFS]: '\0\0\0' }),
      '/repo',
      onGitLab,
    );
    expect(lookup.kind === 'repository' && lookup.repository.sourceBranch).toBe('feature');
  });

  test('reports detached HEAD', async () => {
    const responses = { ...base, 'symbolic-ref --quiet --short HEAD': undefined };
    expect(await resolveRepository(fakeGit(responses), '/repo', onGitLab)).toEqual({
      kind: 'none',
      reason: 'Detached HEAD',
    });
  });

  test('reports a non-repository', async () => {
    const lookup = await resolveRepository(fakeGit({}), '/tmp', onGitLab);
    expect(lookup).toEqual({ kind: 'none', reason: 'Not a Git repository' });
  });

  test('ignores branches whose source remote is not GitLab', async () => {
    const responses = { ...base, [REFS]: 'github\0refs/heads/feature\0\0' };
    expect(await resolveRepository(fakeGit(responses), '/repo', onGitLab)).toEqual({
      kind: 'none',
      reason: 'Not a supported forge remote',
    });
  });

  test("skips the remote's default branch", async () => {
    const responses = { ...base, [REFS]: 'origin\0refs/heads/main\0\0' };
    expect(await resolveRepository(fakeGit(responses), '/repo', onGitLab)).toEqual({
      kind: 'none',
      reason: 'Default branch',
    });
  });
});
