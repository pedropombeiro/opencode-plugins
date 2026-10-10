import { describe, expect, test } from 'bun:test';
import type {
  Forge,
  ForgeKind,
  GitHubPullRequest,
  GitLabMergeRequest,
  ReviewRequest,
} from './forge';
import { kinds, traits, type ForgeCatalog } from './forges';
import type { RemoteProject, Repository, RepositoryLookup } from './git';
import { locate } from './locate';
import { TargetLookupError } from './store';
import { classifyTargets } from './target';
import { deferred, until, type Deferred } from './testing';

// Finds `found` by its own number only, like a forge that has just that PR/MR.
class FakeForge implements Forge {
  readonly calls: string[] = [];
  readonly traits;

  constructor(
    kind: ForgeKind,
    private readonly found?: ReviewRequest,
    private readonly branch: ReviewRequest[] = [],
  ) {
    this.traits = traits(kind);
  }

  async findByNumber(projects: readonly RemoteProject[], number: string) {
    this.calls.push(`number ${projects.map((project) => project.path).join(',')} ${number}`);
    return this.found?.iid === number ? this.found : undefined;
  }

  async findByBranch(repository: Repository) {
    this.calls.push(`branch ${repository.sourceBranch}`);
    return this.branch;
  }

  async findNumberByBranch() {
    return this.branch[0]?.iid;
  }

  async sourceBranch() {
    return undefined;
  }
}

const merge = {
  forge: 'gitlab',
  iid: '45',
  url: 'https://gitlab.com/g/p/-/merge_requests/45',
} as GitLabMergeRequest;
const pull = {
  forge: 'github',
  iid: '7',
  url: 'https://github.com/o/r/pull/7',
} as GitHubPullRequest;
const repository = (host: string): RepositoryLookup => ({
  kind: 'repository',
  repository: {
    head: 'abc',
    branch: 'feature',
    sourceBranch: 'feature',
    source: { host, path: 'o/r' },
    targets: [],
  },
});
const onGitLab = { gitlab: [{ host: 'gitlab.com', path: 'g/p' }] };
const onGitHub = { github: [{ host: 'github.com', path: 'o/r' }] };

function catalog(
  forges: Partial<Record<ForgeKind, FakeForge>>,
  extra: {
    projects?: Partial<Record<ForgeKind, RemoteProject[]>>;
    repository?: RepositoryLookup;
  } = {},
): ForgeCatalog {
  const kind = (host: string): ForgeKind | undefined =>
    host === 'github.com' ? 'github' : host.includes('gitlab') ? 'gitlab' : undefined;
  return {
    kinds,
    kind,
    forHost: (host) => {
      const match = kind(host);
      return match ? forges[match] : undefined;
    },
    projects: async (_directory, match) => extra.projects?.[match] ?? [],
    repository: async () => extra.repository ?? { kind: 'none', reason: 'Not a Git repository' },
  };
}

const target = (url: string) => classifyTargets({ url });
const targets = (...urls: string[]) => classifyTargets({ targets: urls.map((url) => ({ url })) });

const mergeOf = (iid: string, overrides: Partial<GitLabMergeRequest> = {}) =>
  ({
    forge: 'gitlab',
    iid,
    url: `https://gitlab.com/g/p/-/merge_requests/${iid}`,
    ...overrides,
  }) as GitLabMergeRequest;

// Finds requests by number, fails for the numbers in `failing`, and records
// how many lookups ran at once. With `hold` set, each lookup waits in `gates`
// until the test releases it.
class FailingForge extends FakeForge {
  peak = 0;
  hold = false;
  readonly gates: Deferred[] = [];
  running = 0;

  constructor(
    private readonly requests: Map<string, ReviewRequest>,
    private readonly failing = new Set<string>(),
  ) {
    super('gitlab');
  }

  override async findByNumber(_projects: readonly RemoteProject[], number: string) {
    this.peak = Math.max(this.peak, ++this.running);
    if (this.hold) {
      const gate = deferred();
      this.gates.push(gate);
      await gate.promise;
    }
    this.running--;
    if (this.failing.has(number)) throw new Error('glab failed');
    return this.requests.get(number);
  }
}

describe('locate', () => {
  test('resolves explicit targets with the matching forge and skips titles and the branch', async () => {
    const gitlab = new FakeForge('gitlab', merge);
    const github = new FakeForge('github', pull);
    const forges = catalog(
      { gitlab, github },
      { projects: onGitLab, repository: repository('gitlab.com') },
    );
    expect(await locate(forges, { directory: '/repo', targets: target(merge.url) })).toEqual({
      kind: 'found',
      sessionTarget: merge.url,
      explicitTarget: true,
      requests: [merge],
    });
    expect(
      await locate(forges, { directory: '/repo', targets: target(pull.url), title: '[!45]' }),
    ).toMatchObject({
      explicitTarget: true,
      requests: [pull],
    });
    expect(gitlab.calls).toEqual(['number g/p 45']);
    expect(github.calls).toEqual(['number o/r 7']);
  });

  test('rejects explicit targets on unconfigured hosts', async () => {
    expect(
      await locate(catalog({}), {
        directory: '/repo',
        targets: target('https://github.example.com/o/r/pull/7'),
      }),
    ).toEqual({
      kind: 'none',
      reason: 'Unsupported session target host',
      explicitTarget: true,
    });
  });

  test('never falls back to the branch for an unresolved explicit target or an issue', async () => {
    const gitlab = new FakeForge('gitlab', undefined, [merge]);
    const forges = catalog({ gitlab }, { repository: repository('gitlab.com') });
    expect(await locate(forges, { directory: '/repo', targets: target(merge.url) })).toEqual({
      kind: 'none',
      reason: 'Explicit PR/MR target could not be resolved',
      explicitTarget: true,
    });
    const issue = await locate(forges, {
      directory: '/repo',
      targets: target('https://gitlab.com/g/p/-/issues/3'),
    });
    expect(issue).toMatchObject({ kind: 'none' });
    expect(issue.kind === 'none' && issue.explicitTarget).toBeFalsy();
    expect(gitlab.calls).toEqual(['number g/p 45']);
  });

  test('rethrows the lookup error of a single target', async () => {
    const gitlab = new FailingForge(new Map(), new Set(['45']));
    await expect(
      locate(catalog({ gitlab }), { directory: '/repo', targets: target(merge.url) }),
    ).rejects.toThrow('glab failed');
  });

  test('looks up every target in order, skipping issues', async () => {
    const gitlab = new FailingForge(
      new Map([
        ['1', mergeOf('1')],
        ['2', mergeOf('2')],
      ]),
    );
    const lookup = await locate(catalog({ gitlab }), {
      directory: '/repo',
      targets: targets(mergeOf('2').url, 'https://gitlab.com/g/p/-/issues/9', mergeOf('1').url),
    });
    expect(lookup).toEqual({
      kind: 'found',
      sessionTarget: '2 PRs/MRs set with set_session_target',
      explicitTarget: true,
      requests: [mergeOf('2'), mergeOf('1')],
    });
  });

  test("keeps the other targets when one can't be found or fails, reusing its previous result", async () => {
    const gitlab = new FailingForge(new Map([['1', mergeOf('1')]]), new Set(['2']));
    const urls = targets(mergeOf('1').url, mergeOf('2').url, mergeOf('3').url);
    const previous = {
      kind: 'found' as const,
      explicitTarget: true,
      requests: [mergeOf('2', { duoReviewState: 'REVIEW_STARTED' })],
    };
    expect(
      await locate(catalog({ gitlab }), { directory: '/repo', targets: urls, previous }),
    ).toMatchObject({
      requests: [mergeOf('1'), mergeOf('2', { duoReviewState: 'REVIEW_STARTED' })],
      failed: [
        { url: mergeOf('2').url, reason: 'glab failed' },
        { url: mergeOf('3').url, reason: 'Explicit PR/MR target could not be resolved' },
      ],
    });
    // Without a previous result, the failed target is only listed.
    expect(await locate(catalog({ gitlab }), { directory: '/repo', targets: urls })).toMatchObject({
      requests: [mergeOf('1')],
      failed: [{ url: mergeOf('2').url }, { url: mergeOf('3').url }],
    });
  });

  test('throws when every lookup of several targets fails, and explains when none resolves', async () => {
    const failing = new FailingForge(new Map(), new Set(['1', '2']));
    const urls = targets(mergeOf('1').url, mergeOf('2').url);
    const rejection = locate(catalog({ gitlab: failing }), { directory: '/repo', targets: urls });
    await expect(rejection).rejects.toThrow('glab failed');
    await expect(rejection).rejects.toBeInstanceOf(TargetLookupError);
    expect(
      await locate(catalog({ gitlab: new FailingForge(new Map()) }), {
        directory: '/repo',
        targets: urls,
      }),
    ).toEqual({
      kind: 'none',
      reason: 'No session target PR/MR could be resolved',
      explicitTarget: true,
    });
    expect(
      await locate(catalog({}), {
        directory: '/repo',
        targets: targets('https://gitlab.com/g/p/-/issues/1', 'https://gitlab.com/g/p/-/issues/2'),
      }),
    ).toEqual({ kind: 'none', reason: 'No session target is a PR/MR' });
  });

  test('limits concurrent lookups', async () => {
    const gitlab = new FailingForge(
      new Map(Array.from({ length: 10 }, (_, index) => [`${index + 1}`, mergeOf(`${index + 1}`)])),
    );
    const urls = targets(...Array.from({ length: 10 }, (_, index) => mergeOf(`${index + 1}`).url));
    gitlab.hold = true;
    const located = locate(catalog({ gitlab }), { directory: '/repo', targets: urls });
    // The lookups fill the limit, and the rest wait for slots.
    await until(() => gitlab.running === 4);
    for (let released = 0; released < 10; released++) {
      await until(() => gitlab.gates.length > released);
      gitlab.gates[released].resolve();
    }
    const lookup = await located;
    expect(lookup).toMatchObject({ kind: 'found' });
    expect(lookup.kind === 'found' && lookup.requests.map((request) => request.iid)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
    ]);
    expect(gitlab.peak).toBe(4);
  });

  test("uses a title reference on the checkout's forge", async () => {
    expect(
      await locate(catalog({ gitlab: new FakeForge('gitlab', merge) }, { projects: onGitLab }), {
        directory: '/repo',
        title: '[#12, !45]',
      }),
    ).toMatchObject({
      sessionTarget: '!45 (from the session title)',
      requests: [merge],
    });
    expect(
      await locate(catalog({ github: new FakeForge('github', pull) }, { projects: onGitHub }), {
        directory: '/repo',
        title: '[#7]',
      }),
    ).toMatchObject({
      sessionTarget: '#7 (from the session title)',
      requests: [pull],
    });
  });

  test('skips title references that name issues, such as `[#42, #7]`', async () => {
    const github = new FakeForge('github', pull);
    const lookup = await locate(catalog({ github }, { projects: onGitHub }), {
      directory: '/repo',
      title: '[#42, #7]',
    });
    expect(lookup).toMatchObject({ requests: [pull] });
    expect(github.calls).toEqual(['number o/r 42', 'number o/r 7']);
  });

  test('falls back to the branch when no title reference is a PR/MR', async () => {
    const gitlab = new FakeForge('gitlab', undefined, [merge]);
    const forges = catalog(
      { gitlab },
      { projects: onGitLab, repository: repository('gitlab.com') },
    );
    // `#12` is a GitLab issue, and the checkout has no GitHub remote to check it on.
    expect(await locate(forges, { directory: '/repo', title: '[#12, !45]' })).toMatchObject({
      requests: [merge],
    });
    expect(gitlab.calls).toEqual(['number g/p 45', 'branch feature']);

    const github = new FakeForge('github', undefined, [pull]);
    const issue = catalog({ github }, { projects: onGitHub, repository: repository('github.com') });
    expect(await locate(issue, { directory: '/repo', title: '[#42]' })).toMatchObject({
      requests: [pull],
    });
    expect(github.calls).toEqual(['number o/r 42', 'branch feature']);
  });

  test("dispatches branch lookups by the source remote's forge", async () => {
    const github = new FakeForge('github', undefined, [pull]);
    const lookup = await locate(catalog({ github }, { repository: repository('github.com') }), {
      directory: '/repo',
    });
    expect(lookup).toMatchObject({ kind: 'found', requests: [pull] });
    expect(github.calls).toEqual(['branch feature']);
    expect(await locate(catalog({ github }), { directory: '/repo' })).toEqual({
      kind: 'none',
      reason: 'Not a Git repository',
    });
  });
});
