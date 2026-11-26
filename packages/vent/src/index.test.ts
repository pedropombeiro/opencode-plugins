import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin, Skill } from '@opencode/plugin';
import plugin, {
  buildResolveVentSkill,
  executeVent,
  formatVentResult,
  parseVentInput,
  RESOLVE_VENT_SKILL_ID,
  resolveOptions,
  sanitizeRemote,
  selectDestination,
} from './index.ts';
import { parseMarkdownSections, ventToFile } from './destinations/file.ts';
import { ventToGitHub } from './destinations/github.ts';
import { parseGitLabEpicRef, ventToGitLab } from './destinations/gitlab.ts';
import type { VentInput, VentMetadata } from './destinations/types.ts';
import type { Exec, ExecOptions, ExecResult } from './exec.ts';
import { formatCommentBody, formatIssueBody } from './format.ts';
import { buildMatchQuery, extractIdentifiers, findBestMatch, similarityScore } from './match.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'opencode-vent-test-'));
  tempDirs.push(dir);
  return dir;
}

const sampleInput: VentInput = {
  title: 'Missing read-only permission for `glab api` pagination flag',
  friction: 'Running `glab api --paginate` prompts for approval even for read-only GET queries.',
  context: 'Listing open issues across a group during triage.',
  evidence: 'Command `glab api --paginate groups/example/issues` triggered a permission prompt.',
  suggestion: 'Allow `glab api *` with `--paginate` when no mutation flags are present.',
  category: 'permissions',
  labels: ['agent-friction'],
};

const sampleMetadata: VentMetadata = {
  date: '2026-11-20',
  timestamp: '2026-11-20T12:00:00.000Z',
  directory: '/Users/dev/project',
  remote: 'git@gitlab.com:example/project.git',
  branch: 'feature/test',
  sessionID: 'ses_12345',
  category: 'permissions',
};

describe('options and routing', () => {
  test('parses valid destinations, defaults, and routes', () => {
    const options = resolveOptions({
      defaultDestination: 'local',
      similarityThreshold: 0.5,
      destinations: {
        local: { type: 'file', path: '~/notes/vents.md' },
        gitlab: {
          type: 'gitlab',
          project: 'org/repo',
          epic: 'https://gitlab.com/groups/org/-/epics/42',
          labels: ['friction'],
        },
        github: {
          type: 'github',
          repo: 'owner/repo',
          labels: ['tooling'],
        },
        invalid: { type: 'gitlab' },
      },
      routes: [
        { directoryPrefix: '~/work', destination: 'gitlab' },
        { remoteContains: 'github.com/owner/', destination: 'github' },
      ],
    });

    expect(options.defaultDestination).toBe('local');
    expect(options.similarityThreshold).toBe(0.5);
    expect(Object.keys(options.destinations)).toEqual(['local', 'gitlab', 'github']);
    expect(options.destinations.gitlab).toEqual({
      type: 'gitlab',
      project: 'org/repo',
      epic: 'https://gitlab.com/groups/org/-/epics/42',
      host: 'gitlab.com',
      confidential: true,
      labels: ['friction'],
    });

    expect(
      selectDestination(options, {
        requested: 'github',
        directory: '/Users/dev/work/app',
        home: '/Users/dev',
      }).name,
    ).toBe('github');

    expect(
      selectDestination(options, {
        directory: '/Users/dev/work/app',
        home: '/Users/dev',
      }).name,
    ).toBe('gitlab');

    expect(
      selectDestination(options, {
        directory: '/Users/dev/other',
        remote: 'git@github.com:owner/repo.git',
        home: '/Users/dev',
      }).name,
    ).toBe('github');

    expect(
      selectDestination(options, {
        directory: '/Users/dev/other',
        home: '/Users/dev',
      }).name,
    ).toBe('local');
  });

  test('selects the sole destination when no defaultDestination is configured', () => {
    const options = resolveOptions({
      destinations: {
        only: { type: 'file', path: '~/vents.md' },
      },
    });
    expect(selectDestination(options, {}).name).toBe('only');
  });

  test('enforces project routes with an exception for opted-in destinations', () => {
    const options = resolveOptions({
      defaultDestination: 'local',
      destinations: {
        local: { type: 'file', path: '~/vents.md' },
        gitlab: { type: 'gitlab', project: 'dev/friction' },
        github: {
          type: 'github',
          repo: 'dev/friction',
          acceptsUnrelated: true,
        },
      },
      routes: [
        { directoryPrefix: '~/gdk', destination: 'gitlab', enforced: true },
        {
          remoteRepository: 'gitlab.com/gitlab-org/gitlab',
          destination: 'gitlab',
          enforced: true,
        },
      ],
    });
    const locations = [
      { directory: '/home/dev/gdk/gitlab/app', home: '/home/dev' },
      {
        directory: '/worktrees/feature',
        remote: 'git@gitlab.com:gitlab-org/gitlab.git',
      },
      {
        directory: '/recovery/clone',
        fetchRemotes: [
          'https://gitlab.com/dev/fork.git',
          'ssh://git@gitlab.com:22/gitlab-org/gitlab.git',
        ],
      },
    ];
    for (const location of locations) {
      expect(selectDestination(options, location).name).toBe('gitlab');
      expect(selectDestination(options, { ...location, requested: 'gitlab' }).name).toBe('gitlab');
      expect(() => selectDestination(options, { ...location, requested: 'github' })).toThrow(
        'set destination to one of "github"',
      );
      expect(() =>
        selectDestination(options, {
          ...location,
          requested: 'github',
          unrelatedReason: ' ',
        }),
      ).toThrow('unrelatedReason');
      expect(() =>
        selectDestination(options, {
          ...location,
          requested: 'local',
          unrelatedReason: "The file destination hasn't opted in.",
        }),
      ).toThrow('This checkout routes');
      expect(
        selectDestination(options, {
          ...location,
          requested: 'github',
          unrelatedReason: 'SSH signing fails in personal repositories too.',
        }).name,
      ).toBe('github');
    }
    expect(() =>
      selectDestination(options, {
        directory: '/home/dev/gdk/gitlab',
        home: '/home/dev',
        unrelatedReason: 'No destination was given.',
      }),
    ).toThrow('requires an explicit destination');
    expect(
      selectDestination(options, {
        directory: '/home/dev/gdk-backup',
        home: '/home/dev',
        remote: 'https://gitlab.com/gitlab-org/gitlab-other.git',
      }).name,
    ).toBe('local');
  });

  test('throws on missing or unknown destination', () => {
    expect(() => selectDestination(resolveOptions({}), {})).toThrow('No vent destinations');
    const options = resolveOptions({
      destinations: {
        local: { type: 'file', path: '~/vents.md' },
      },
    });
    expect(() => selectDestination(options, { requested: 'missing' })).toThrow(
      'Unknown vent destination',
    );
  });

  test('matches directoryPrefix across symlinks and root prefix', async () => {
    const rootDir = await makeTempDir();
    const realWorkDir = join(rootDir, 'work', 'repo');
    const symlinkPath = join(rootDir, 'shortcut-repo');
    await mkdir(realWorkDir, { recursive: true });
    await symlink(realWorkDir, symlinkPath);

    const options = resolveOptions({
      defaultDestination: 'public',
      destinations: {
        work: { type: 'gitlab', project: 'group/work' },
        public: { type: 'github', repo: 'owner/public' },
      },
      routes: [{ directoryPrefix: join(rootDir, 'work'), destination: 'work', enforced: true }],
    });

    expect(selectDestination(options, { directory: symlinkPath }).name).toBe('work');

    const rootRouteOptions = resolveOptions({
      destinations: {
        work: { type: 'gitlab', project: 'group/work' },
      },
      routes: [{ directoryPrefix: '/', destination: 'work', enforced: true }],
    });
    expect(selectDestination(rootRouteOptions, { directory: '/workspace/project' }).name).toBe(
      'work',
    );
  });
});

describe('similarity matching', () => {
  test('matches recurring friction with paraphrased title and shared identifier', () => {
    const candidates = [
      {
        id: '1',
        title: 'Permission prompt on `glab api` with pagination flag',
        body: 'Calling `glab api --paginate` asks for approval on GET requests.',
      },
      {
        id: '2',
        title: 'Slow test suite startup on macOS',
        body: 'Running integration specs takes two minutes to boot Docker.',
      },
    ];

    const match = findBestMatch(
      { title: sampleInput.title, body: sampleInput.friction },
      candidates,
      0.45,
    );
    expect(match?.item.id).toBe('1');
    expect(match!.score).toBeGreaterThanOrEqual(0.45);
  });

  test('does not match unrelated frictions', () => {
    const score = similarityScore(
      {
        title: 'Broken symlink after running dotfiles bootstrap',
        body: 'Bootstrap script leaves a dangling link in ~/.local/bin.',
      },
      {
        title: 'ClickHouse query timeout on CI pipeline metrics',
        body: 'Querying build duration over 90 days times out after 30 seconds.',
      },
    );
    expect(score).toBeLessThan(0.2);
  });

  test('ignores backticked session metadata inside <details> blocks', () => {
    const metadataBlock = formatIssueBody(
      {
        title: 'ClickHouse query timeout',
        friction: 'Querying build duration times out.',
        context: 'Checking dashboard latency.',
      },
      sampleMetadata,
    );
    expect(extractIdentifiers(metadataBlock).size).toBe(0);

    const score = similarityScore(
      {
        title: 'Broken symlink after bootstrap',
        body: formatIssueBody(
          {
            title: 'Broken symlink after bootstrap',
            friction: 'Bootstrap script leaves a dangling link.',
            context: 'Running dotfiles setup.',
          },
          sampleMetadata,
        ),
      },
      {
        title: 'ClickHouse query timeout',
        body: metadataBlock,
      },
    );
    expect(score).toBeLessThan(0.1);
  });

  test('includes evidence identifiers when building a match query', () => {
    const query = buildMatchQuery({
      title: 'Linter fails to start from shell',
      friction: 'Running the markdown linter fails with a shim version error.',
      evidence: 'Invoking `markdownlint-cli2` prints `No version is set for shim`.',
    });
    const ids = extractIdentifiers(`${query.title}\n${query.body}`);
    expect(ids.has('markdownlint-cli2')).toBe(true);
    expect(ids.has('no version is set for shim')).toBe(true);
  });

  test('matches identical and overlapping non-Latin Unicode titles', () => {
    expect(
      similarityScore(
        { title: '設定画面が開かない', body: 'クリックしても反応しない' },
        { title: '設定画面が開かない', body: '別の説明' },
      ),
    ).toBe(1);

    expect(
      similarityScore(
        { title: '設定画面でエラーが発生する', body: '設定画面を開くとクラッシュする' },
        { title: '設定画面でエラーが発生する問題', body: '設定画面を開くと失敗する' },
      ),
    ).toBeGreaterThan(0.3);
  });
});

describe('formatting', () => {
  test('formats structured issue body and comment body with session metadata', () => {
    const issueBody = formatIssueBody(sampleInput, sampleMetadata);
    expect(issueBody).toContain('## Friction');
    expect(issueBody).toContain('## Context');
    expect(issueBody).toContain('## Evidence / Reproduction');
    expect(issueBody).toContain('## Suggested Improvement');
    expect(issueBody).toContain('<details>');
    expect(issueBody).toContain('- **Branch**: `feature/test`');
    expect(issueBody).toContain('- **Session**: `ses_12345`');

    const commentBody = formatCommentBody(sampleInput, sampleMetadata);
    expect(commentBody).toContain('Additional occurrence reported on 2026-11-20.');
    expect(commentBody).toContain('### Context');
  });

  test('escapes standalone GitLab quick-action lines and closes unclosed fences in user text', () => {
    const body = formatIssueBody(
      {
        title: 'Quick action test',
        friction:
          'quoting a command:\n/close\n/label ~bug\r/reopen\n    ```\n/confidential\n    ```',
        context: 'Checking quick action escaping.',
        evidence: '```text\n    ```\n/reopen\n',
        suggestion: 'Use `/close` inline or escape it.',
      },
      sampleMetadata,
    );

    expect(body).toContain('\\/close');
    expect(body).toContain('\\/label ~bug');
    expect(body).toContain('\\/reopen');
    expect(body).toContain('    ```\n\\/confidential\n    ```');
    expect(body).toContain('```text\n    ```\n/reopen\n```');
  });
});

describe('GitLab destination', () => {
  test('parses epic URLs, work item URLs, and shorthand refs', () => {
    expect(
      parseGitLabEpicRef('https://gitlab.com/groups/gitlab-org/-/epics/123', 'gitlab.com'),
    ).toEqual({
      host: 'gitlab.com',
      groupPath: 'gitlab-org',
      iid: '123',
      url: 'https://gitlab.com/groups/gitlab-org/-/epics/123',
    });

    expect(
      parseGitLabEpicRef('https://gitlab.example.com/groups/org/sub/-/work_items/99', 'gitlab.com'),
    ).toEqual({
      host: 'gitlab.example.com',
      groupPath: 'org/sub',
      iid: '99',
      url: 'https://gitlab.example.com/groups/org/sub/-/epics/99',
    });

    expect(parseGitLabEpicRef('gitlab-org/quality&77', 'gitlab.com')).toEqual({
      host: 'gitlab.com',
      groupPath: 'gitlab-org/quality',
      iid: '77',
      url: 'https://gitlab.com/groups/gitlab-org/quality/-/epics/77',
    });
  });

  test('rejects an epic URL whose host disagrees with the configured GitLab host', async () => {
    const calls: string[][] = [];
    const mockExec: Exec = async (_file, args): Promise<ExecResult> => {
      calls.push(args);
      return { stdout: '[]', stderr: '', code: 0 };
    };

    await expect(
      ventToGitLab(
        'gitlab',
        {
          type: 'gitlab',
          project: 'group/project',
          epic: 'https://gitlab.com/groups/group/-/epics/42',
          host: 'gitlab.example.com',
          confidential: true,
          labels: [],
        },
        sampleInput,
        sampleMetadata,
        { exec: mockExec, threshold: 0.45 },
      ),
    ).rejects.toThrow(
      'GitLab epic host "gitlab.com" does not match destination host "gitlab.example.com".',
    );
    expect(calls).toHaveLength(0);
  });

  test('comments on matching open epic issue instead of creating a duplicate', async () => {
    const calls: Array<{ file: string; args: string[]; stdin?: string }> = [];
    const mockExec: Exec = async (file, args, options?: ExecOptions): Promise<ExecResult> => {
      calls.push({ file, args, stdin: options?.stdin });
      if (args.includes('--method')) {
        return { stdout: JSON.stringify({ id: 555 }), stderr: '', code: 0 };
      }
      return {
        stdout: JSON.stringify([
          {
            id: 9001,
            iid: 42,
            project_id: 278964,
            title: 'Permission prompt on `glab api` pagination flag',
            description: 'Running `glab api --paginate` triggers an approval prompt.',
            state: 'opened',
            confidential: true,
            web_url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/42',
          },
        ]),
        stderr: '',
        code: 0,
      };
    };

    const result = await ventToGitLab(
      'gitlab',
      {
        type: 'gitlab',
        project: 'gitlab-org/gitlab',
        epic: 'https://gitlab.com/groups/gitlab-org/-/epics/100',
        host: 'gitlab.com',
        confidential: true,
        labels: ['workflow'],
      },
      sampleInput,
      sampleMetadata,
      { exec: mockExec, threshold: 0.45 },
    );

    expect(result).toEqual({
      action: 'commented',
      destination: 'gitlab',
      destinationType: 'gitlab',
      url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/42#note_555',
      title: sampleInput.title,
      matchedTitle: 'Permission prompt on `glab api` pagination flag',
      matchScore: expect.any(Number),
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual([
      'api',
      '--hostname',
      'gitlab.com',
      '--paginate',
      'groups/gitlab-org/epics/100/issues?state=opened&per_page=100',
    ]);
    expect(calls[1]!.args).toEqual([
      'api',
      '--hostname',
      'gitlab.com',
      '--method',
      'POST',
      '--header',
      'Content-Type: application/json',
      '--input',
      '-',
      'projects/278964/issues/42/notes',
    ]);
    expect(JSON.parse(calls[1]!.stdin!).body).toContain(
      'Additional occurrence reported on 2026-11-20.',
    );
  });

  test('creates a confidential issue under the epic when no existing issue matches', async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const mockExec: Exec = async (_file, args, options?: ExecOptions): Promise<ExecResult> => {
      calls.push({ args, stdin: options?.stdin });
      if (!args.includes('--method')) {
        return { stdout: '[]', stderr: '', code: 0 };
      }
      if (args.at(-1)?.includes('/issues') && options?.stdin) {
        return {
          stdout: JSON.stringify({
            id: 7777,
            iid: 101,
            project_id: 278964,
            title: sampleInput.title,
            web_url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/101',
            epic: { id: 500, iid: 100 },
          }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '{}', stderr: '', code: 0 };
    };

    const result = await ventToGitLab(
      'gitlab',
      {
        type: 'gitlab',
        project: 'gitlab-org/gitlab',
        epic: 'https://gitlab.com/groups/gitlab-org/-/epics/100',
        host: 'gitlab.com',
        confidential: true,
        labels: ['workflow'],
      },
      sampleInput,
      sampleMetadata,
      { exec: mockExec, threshold: 0.45 },
    );

    expect(result).toEqual({
      action: 'created',
      destination: 'gitlab',
      destinationType: 'gitlab',
      url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/101',
      title: sampleInput.title,
    });

    expect(calls).toHaveLength(3);
    const payload = JSON.parse(calls[2]!.stdin!) as Record<string, unknown>;
    expect(payload.confidential).toBe(true);
    expect(payload.labels).toBe('workflow,permissions,agent-friction');
    expect(payload.description).toContain('/epic https://gitlab.com/groups/gitlab-org/-/epics/100');
  });

  test('falls back to REST epic link endpoint if response omits epic field', async () => {
    const endpoints: string[] = [];
    const mockExec: Exec = async (_file, args, options?: ExecOptions): Promise<ExecResult> => {
      const endpoint = args.at(-1)!;
      endpoints.push(endpoint);
      if (!args.includes('--method')) return { stdout: '[]', stderr: '', code: 0 };
      if (options?.stdin) {
        return {
          stdout: JSON.stringify({
            id: 8888,
            iid: 102,
            project_id: 278964,
            title: sampleInput.title,
            web_url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/102',
          }),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: '{}', stderr: '', code: 0 };
    };

    const result = await ventToGitLab(
      'gitlab',
      {
        type: 'gitlab',
        project: 'gitlab-org/gitlab',
        epic: 'https://gitlab.com/groups/gitlab-org/-/epics/100',
        host: 'gitlab.com',
        confidential: true,
        labels: [],
      },
      sampleInput,
      sampleMetadata,
      { exec: mockExec, threshold: 0.45 },
    );

    expect(result.action).toBe('created');
    expect(result.note).toBeUndefined();
    expect(endpoints).toEqual([
      'groups/gitlab-org/epics/100/issues?state=opened&per_page=100',
      'groups/gitlab-org/epics/100/issues?state=closed&per_page=100',
      'projects/gitlab-org%2Fgitlab/issues',
      'groups/gitlab-org/epics/100/issues/8888',
    ]);
  });

  test('reports the closest closed match in the destination project without writing', async () => {
    const title = 'glab draft update help reverses positional arguments';
    const url = 'https://gitlab.com/dev/friction/-/work_items/8';
    const mockExec: Exec = async (_file, args, options) => {
      expect(args).not.toContain('--method');
      expect(options?.stdin).toBeUndefined();
      if (args.at(-1)?.includes('state=opened')) {
        return { stdout: '[]', stderr: '', code: 0 };
      }
      expect(args).toContain('--paginate');
      expect(args.at(-1)).toBe('groups/org/epics/42/issues?state=closed&per_page=100');
      return {
        stdout: JSON.stringify([
          {
            title,
            state: 'closed',
            confidential: true,
            web_url: 'https://gitlab.com/org/other/-/issues/1',
          },
          {
            title: `${title} in old versions`,
            state: 'closed',
            confidential: true,
            web_url: 'https://gitlab.com/dev/friction/-/issues/7',
          },
          { title, state: 'closed', confidential: true, web_url: url },
        ]),
        stderr: '',
        code: 0,
      };
    };
    const result = await ventToGitLab(
      'gitlab',
      {
        type: 'gitlab',
        project: 'dev/friction',
        epic: 'org&42',
        host: 'gitlab.com',
        confidential: true,
        labels: [],
      },
      { ...sampleInput, title: ` ${title.toUpperCase()} ` },
      sampleMetadata,
      { exec: mockExec, threshold: 0.45 },
    );
    expect(result).toMatchObject({
      action: 'closed-match',
      url,
      matchedTitle: title,
    });
    expect(result.note).toContain('No issue or comment was created.');
    expect(formatVentResult(result)).toContain('similar closed gitlab issue');
  });

  test('filters project issues by destination labels when no epic is configured', async () => {
    const endpoints: string[] = [];
    const mockExec: Exec = async (_file, args): Promise<ExecResult> => {
      endpoints.push(args.at(-1)!);
      if (!args.includes('--method')) return { stdout: '[]', stderr: '', code: 0 };
      return {
        stdout: JSON.stringify({
          id: 9999,
          iid: 103,
          project_id: 278964,
          title: sampleInput.title,
          web_url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/103',
        }),
        stderr: '',
        code: 0,
      };
    };

    const result = await ventToGitLab(
      'gitlab',
      {
        type: 'gitlab',
        project: 'gitlab-org/gitlab',
        host: 'gitlab.com',
        confidential: true,
        labels: ['agent-friction', 'tooling'],
      },
      sampleInput,
      sampleMetadata,
      { exec: mockExec, threshold: 0.45 },
    );

    expect(result.action).toBe('created');
    expect(endpoints[0]).toBe(
      'projects/gitlab-org%2Fgitlab/issues?state=opened&per_page=100&labels=agent-friction%2Ctooling',
    );
  });

  test('ignores non-confidential or out-of-project epic issues when destination is confidential', async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const mockExec: Exec = async (_file, args, options?: ExecOptions): Promise<ExecResult> => {
      calls.push({ args, stdin: options?.stdin });
      if (!args.includes('--method')) {
        if (args.at(-1)?.includes('state=opened')) {
          return {
            stdout: JSON.stringify([
              {
                id: 1001,
                iid: 10,
                project_id: 278964,
                title: sampleInput.title,
                description: sampleInput.friction,
                state: 'opened',
                confidential: false,
                web_url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/10',
              },
              {
                id: 1004,
                iid: 13,
                project_id: 278964,
                title: sampleInput.title,
                description: sampleInput.friction,
                state: 'opened',
                web_url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/13',
              },
              {
                id: 1002,
                iid: 11,
                project_id: 999999,
                title: sampleInput.title,
                description: sampleInput.friction,
                state: 'opened',
                confidential: true,
                web_url: 'https://gitlab.com/gitlab-org/other-project/-/issues/11',
              },
            ]),
            stderr: '',
            code: 0,
          };
        }
        return {
          stdout: JSON.stringify([
            {
              id: 1003,
              iid: 12,
              project_id: 278964,
              title: sampleInput.title,
              description: sampleInput.friction,
              state: 'closed',
              confidential: false,
              web_url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/12',
            },
            {
              id: 1005,
              iid: 14,
              project_id: 278964,
              title: sampleInput.title,
              description: sampleInput.friction,
              state: 'closed',
              web_url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/14',
            },
          ]),
          stderr: '',
          code: 0,
        };
      }
      return {
        stdout: JSON.stringify({
          id: 2000,
          iid: 99,
          project_id: 278964,
          title: sampleInput.title,
          web_url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/99',
          epic: { id: 500, iid: 100 },
        }),
        stderr: '',
        code: 0,
      };
    };

    const result = await ventToGitLab(
      'gitlab',
      {
        type: 'gitlab',
        project: 'gitlab-org/gitlab',
        epic: 'https://gitlab.com/groups/gitlab-org/-/epics/100',
        host: 'gitlab.com',
        confidential: true,
        labels: [],
      },
      sampleInput,
      sampleMetadata,
      { exec: mockExec, threshold: 0.45 },
    );

    expect(result.action).toBe('created');
    expect(result.url).toBe('https://gitlab.com/gitlab-org/gitlab/-/issues/99');
  });

  test('matches an open issue on the second page of paginated results', async () => {
    const page1 = JSON.stringify([
      {
        id: 3001,
        iid: 1,
        project_id: 278964,
        title: 'Unrelated build failure on runner',
        description: 'Container image pull failed.',
        state: 'opened',
        confidential: true,
        web_url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/1',
      },
    ]);
    const page2 = JSON.stringify([
      {
        id: 3002,
        iid: 2,
        project_id: 278964,
        title: 'Permission prompt on `glab api` pagination flag',
        description: 'Running `glab api --paginate` triggers an approval prompt.',
        state: 'opened',
        confidential: true,
        web_url: 'https://gitlab.com/gitlab-org/gitlab/-/issues/2',
      },
    ]);

    const mockExec: Exec = async (_file, args): Promise<ExecResult> => {
      if (!args.includes('--method')) {
        expect(args).toContain('--paginate');
        return { stdout: `${page1}\n${page2}`, stderr: '', code: 0 };
      }
      return { stdout: JSON.stringify({ id: 777 }), stderr: '', code: 0 };
    };

    const result = await ventToGitLab(
      'gitlab',
      {
        type: 'gitlab',
        project: 'gitlab-org/gitlab',
        host: 'gitlab.com',
        confidential: true,
        labels: [],
      },
      sampleInput,
      sampleMetadata,
      { exec: mockExec, threshold: 0.45 },
    );

    expect(result.action).toBe('commented');
    expect(result.url).toBe('https://gitlab.com/gitlab-org/gitlab/-/issues/2#note_777');
  });
});

describe('GitHub destination', () => {
  test('ignores pull requests and comments on a matching open issue', async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const mockExec: Exec = async (_file, args, options?: ExecOptions): Promise<ExecResult> => {
      calls.push({ args, stdin: options?.stdin });
      if (!args.includes('--method')) {
        return {
          stdout: JSON.stringify([
            {
              number: 10,
              title: sampleInput.title,
              body: sampleInput.friction,
              html_url: 'https://github.com/owner/repo/pull/10',
              pull_request: {},
            },
            {
              number: 11,
              title: 'Permission prompt on `glab api` pagination flag',
              body: 'Running `glab api --paginate` asks for approval.',
              html_url: 'https://github.com/owner/repo/issues/11',
            },
          ]),
          stderr: '',
          code: 0,
        };
      }
      return {
        stdout: JSON.stringify({
          html_url: 'https://github.com/owner/repo/issues/11#issuecomment-9',
        }),
        stderr: '',
        code: 0,
      };
    };

    const result = await ventToGitHub(
      'github',
      {
        type: 'github',
        repo: 'owner/repo',
        host: 'github.com',
        labels: ['friction'],
      },
      sampleInput,
      sampleMetadata,
      { exec: mockExec, threshold: 0.45 },
    );

    expect(result.action).toBe('commented');
    expect(result.url).toBe('https://github.com/owner/repo/issues/11#issuecomment-9');
    expect(calls[1]!.args).toContain('repos/owner/repo/issues/11/comments');
  });

  test('creates a new issue when no open issue matches', async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const mockExec: Exec = async (_file, args, options?: ExecOptions): Promise<ExecResult> => {
      calls.push({ args, stdin: options?.stdin });
      if (!args.includes('--method')) return { stdout: '[]', stderr: '', code: 0 };
      return {
        stdout: JSON.stringify({
          html_url: 'https://github.com/owner/repo/issues/12',
        }),
        stderr: '',
        code: 0,
      };
    };

    const result = await ventToGitHub(
      'github',
      {
        type: 'github',
        repo: 'owner/repo',
        host: 'github.com',
        labels: ['friction'],
      },
      sampleInput,
      sampleMetadata,
      { exec: mockExec, threshold: 0.45 },
    );

    expect(result.action).toBe('created');
    expect(result.url).toBe('https://github.com/owner/repo/issues/12');
    expect(calls[0]!.args).toContain(
      'repos/owner/repo/issues?state=open&per_page=100&labels=friction',
    );
    expect(calls[1]!.args).toContain(
      'repos/owner/repo/issues?state=closed&per_page=100&labels=friction',
    );
    const payload = JSON.parse(calls[2]!.stdin!) as { labels: string[] };
    expect(payload.labels).toEqual(['friction', 'permissions', 'agent-friction']);
  });

  test('matches a GitHub issue on the second page when --paginate returns concatenated JSON arrays', async () => {
    const page1 = JSON.stringify([
      {
        number: 1,
        title: 'Unrelated flaky test in CI',
        body: 'Random timeout in integration suite. See [guide][ref] for details.',
        html_url: 'https://github.com/owner/repo/issues/1',
      },
    ]);
    const page2 = JSON.stringify([
      {
        number: 105,
        title: 'Permission prompt on `glab api` pagination flag',
        body: 'Running `glab api --paginate` asks for approval in `[mode][flag]`.',
        html_url: 'https://github.com/owner/repo/issues/105',
      },
    ]);

    const mockExec: Exec = async (_file, args): Promise<ExecResult> => {
      if (!args.includes('--method')) {
        expect(args).toContain('--paginate');
        return { stdout: `${page1}${page2}[]`, stderr: '', code: 0 };
      }
      return {
        stdout: JSON.stringify({
          html_url: 'https://github.com/owner/repo/issues/105#issuecomment-42',
        }),
        stderr: '',
        code: 0,
      };
    };

    const result = await ventToGitHub(
      'github',
      {
        type: 'github',
        repo: 'owner/repo',
        host: 'github.com',
        labels: ['friction'],
      },
      sampleInput,
      sampleMetadata,
      { exec: mockExec, threshold: 0.45 },
    );

    expect(result.action).toBe('commented');
    expect(result.url).toBe('https://github.com/owner/repo/issues/105#issuecomment-42');
  });
});

describe('file destination', () => {
  test('creates the file, appends new sections, and appends occurrences under matching sections', async () => {
    const dir = await makeTempDir();
    const targetPath = join(dir, 'docs', 'vents.md');

    const first = await ventToFile(
      'local',
      { type: 'file', path: targetPath },
      sampleInput,
      sampleMetadata,
      { threshold: 0.45 },
    );
    expect(first.action).toBe('created');

    const secondInput: VentInput = {
      title: 'Docker daemon stalls after macOS sleep',
      friction: 'Colima socket stops responding until restarted after wake from sleep.',
      context: 'Running container builds after reopening the laptop.',
    };
    const second = await ventToFile(
      'local',
      { type: 'file', path: targetPath },
      secondInput,
      sampleMetadata,
      { threshold: 0.45 },
    );
    expect(second.action).toBe('created');

    const recurring = await ventToFile(
      'local',
      { type: 'file', path: targetPath },
      {
        title: 'Approval prompt on `glab api` pagination flag',
        friction: 'Another `glab api --paginate` GET call prompted for approval.',
        context: 'Checking merge requests across projects.',
      },
      {
        ...sampleMetadata,
        date: '2026-11-21',
        timestamp: '2026-11-21T09:00:00.000Z',
      },
      { threshold: 0.45 },
    );
    expect(recurring.action).toBe('commented');
    expect(recurring.matchedTitle).toBe(sampleInput.title);

    const content = await readFile(targetPath, 'utf8');
    const sections = parseMarkdownSections(content);
    expect(sections.map((section) => section.title)).toEqual([
      sampleInput.title,
      secondInput.title,
    ]);
    expect(sections[0]!.body).toContain('### Occurrence (2026-11-21)');
    expect(sections[1]!.body).not.toContain('### Occurrence (2026-11-21)');
  });

  test('ignores ## headings inside fenced code blocks', () => {
    const markdown = [
      '# Agent Vents',
      '',
      '## Real section',
      '',
      '```markdown',
      '## Not a section',
      '```',
      '',
      '## Second section',
      '',
      'Body text',
    ].join('\n');

    expect(parseMarkdownSections(markdown).map((s) => s.title)).toEqual([
      'Real section',
      'Second section',
    ]);
  });

  test('serializes concurrent writes to the same file without losing entries', async () => {
    const dir = await makeTempDir();
    const targetPath = join(dir, 'concurrent.md');

    await Promise.all([
      ventToFile(
        'local',
        { type: 'file', path: targetPath },
        {
          title: 'First concurrent friction',
          friction: 'The first tool failed during setup.',
          context: 'Testing concurrent write safety.',
        },
        sampleMetadata,
        { threshold: 0.45 },
      ),
      ventToFile(
        'local',
        { type: 'file', path: targetPath },
        {
          title: 'Second unrelated timeout issue',
          friction: 'Database query timed out on large table scan.',
          context: 'Running analytics benchmarks.',
        },
        sampleMetadata,
        { threshold: 0.45 },
      ),
    ]);

    const content = await readFile(targetPath, 'utf8');
    const sections = parseMarkdownSections(content);
    expect(sections.map((section) => section.title)).toEqual([
      'First concurrent friction',
      'Second unrelated timeout issue',
    ]);
  });

  test('ignores triple-backtick lines and headings inside a four-backtick fence and respects AbortSignal', async () => {
    const markdown = [
      '# Agent vents',
      '',
      '## Real section',
      '',
      '````markdown',
      '```',
      '## Heading inside nested fence',
      '```',
      '````',
      '',
      '## Second real section',
      '',
      'Body text.',
    ].join('\n');

    const sections = parseMarkdownSections(markdown);
    expect(sections.map((section) => section.title)).toEqual([
      'Real section',
      'Second real section',
    ]);

    const dir = await makeTempDir();
    const targetPath = join(dir, 'aborted.md');
    const controller = new AbortController();
    controller.abort();

    await expect(
      ventToFile('local', { type: 'file', path: targetPath }, sampleInput, sampleMetadata, {
        threshold: 0.45,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(await Bun.file(targetPath).exists()).toBe(false);
  });
});

describe('executeVent and input parsing', () => {
  test('validates input and executes through selected destination', async () => {
    expect(() => parseVentInput({ title: 'x', friction: 'missing context' })).toThrow('`context`');

    const dir = await makeTempDir();
    const targetPath = join(dir, 'vents.md');
    const options = resolveOptions({
      defaultDestination: 'local',
      destinations: { local: { type: 'file', path: targetPath } },
    });

    const mockExec: Exec = async (_file, args): Promise<ExecResult> => {
      if (args.includes('remote')) {
        return {
          stdout: 'origin\tgit@github.com:example/repo.git (fetch)\n',
          stderr: '',
          code: 0,
        };
      }
      return { stdout: 'main\n', stderr: '', code: 0 };
    };

    const result = await executeVent(sampleInput, options, {
      sessionID: 'ses_999',
      directory: dir,
      exec: mockExec,
      now: () => new Date('2026-11-20T15:30:00.000Z'),
    });

    expect(result.action).toBe('created');
    expect(formatVentResult(result)).toContain('Created new file vent');

    const saved = await readFile(targetPath, 'utf8');
    expect(saved).toContain('- **Repository**: `github.com/example/repo`');
    expect(saved).toContain('- **Branch**: `main`');
  });

  test('strips credentials from HTTPS and SSH remote URLs before recording metadata', async () => {
    expect(
      sanitizeRemote('https://oauth2:glpat-secret-token-123@gitlab.com/example/project.git'),
    ).toBe('gitlab.com/example/project');
    expect(
      sanitizeRemote(
        'https://oauth2:secret token with space@gitlab.com:8443/example/project.git?private_token=leak#frag',
      ),
    ).toBe('gitlab.com/example/project');
    expect(sanitizeRemote('ssh://git@gitlab.com:2222/example/project.git')).toBe(
      'gitlab.com/example/project',
    );
    expect(sanitizeRemote('git@github.com:owner/repo.git')).toBe('github.com/owner/repo');
    expect(sanitizeRemote('git@gitlab.com:/group/work.git')).toBe('gitlab.com/group/work');
    expect(sanitizeRemote('gitlab.com:group/work.git')).toBe('gitlab.com/group/work');

    const dir = await makeTempDir();
    const targetPath = join(dir, 'vents.md');
    const options = resolveOptions({
      defaultDestination: 'local',
      destinations: { local: { type: 'file', path: targetPath } },
    });

    const mockExec: Exec = async (_file, args): Promise<ExecResult> => {
      if (args.includes('remote')) {
        return {
          stdout:
            'origin\thttps://oauth2:glpat-dummy-token-xyz@gitlab.com/example/repo.git (fetch)\n',
          stderr: '',
          code: 0,
        };
      }
      return { stdout: 'main\n', stderr: '', code: 0 };
    };

    await executeVent(sampleInput, options, {
      sessionID: 'ses_token',
      directory: dir,
      exec: mockExec,
    });

    const saved = await readFile(targetPath, 'utf8');
    expect(saved).toContain('- **Repository**: `gitlab.com/example/repo`');
    expect(saved).not.toContain('glpat-dummy-token-xyz');
    expect(saved).not.toContain('oauth2');
  });

  test('matches enforced remoteContains route against SSH SCP-style fetch remote while sanitizing metadata', async () => {
    const options = resolveOptions({
      defaultDestination: 'other',
      destinations: {
        work: { type: 'gitlab', project: 'group/work' },
        other: { type: 'github', repo: 'owner/other' },
      },
      routes: [
        {
          remoteContains: 'gitlab.com:group/',
          destination: 'work',
          enforced: true,
        },
      ],
    });

    const invokedTools: string[] = [];
    const payloads: Array<Record<string, unknown>> = [];
    const mockExec: Exec = async (file, args, execOptions): Promise<ExecResult> => {
      invokedTools.push(file);
      if (file === 'git') {
        return {
          code: 0,
          stderr: '',
          stdout: args.includes('remote')
            ? 'origin\tgit@gitlab.com:group/work.git (fetch)\n'
            : 'main\n',
        };
      }
      if (!args.includes('--method')) {
        return { code: 0, stderr: '', stdout: '[]' };
      }
      if (execOptions?.stdin) {
        payloads.push(JSON.parse(execOptions.stdin) as Record<string, unknown>);
      }
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          id: 1,
          iid: 1,
          project_id: 10,
          title: sampleInput.title,
          web_url: 'https://gitlab.com/group/work/-/issues/1',
        }),
      };
    };

    const result = await executeVent(sampleInput, options, {
      sessionID: 'ses_scp',
      directory: '/workspace',
      exec: mockExec,
    });

    expect(result.destination).toBe('work');
    expect(result.destinationType).toBe('gitlab');
    expect(invokedTools).not.toContain('gh');
    expect(String(payloads[0]?.description)).toContain('- **Repository**: `gitlab.com/group/work`');
  });

  test('matches partial-clone remotes with [blob:none] filter and fails closed when git remote discovery fails', async () => {
    const options = resolveOptions({
      defaultDestination: 'public',
      destinations: {
        work: { type: 'gitlab', project: 'group/work' },
        public: { type: 'github', repo: 'owner/public', acceptsUnrelated: true },
      },
      routes: [
        {
          remoteRepository: 'gitlab.com/group/work',
          destination: 'work',
          enforced: true,
        },
      ],
    });

    const partialCloneExec: Exec = async (file, args): Promise<ExecResult> => {
      if (file === 'git') {
        return {
          code: 0,
          stderr: '',
          stdout: args.includes('remote')
            ? 'origin\thttps://gitlab.com/group/work.git (fetch) [blob:none]\r\n'
            : 'main\r\n',
        };
      }
      if (!args.includes('--method')) return { code: 0, stderr: '', stdout: '[]' };
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          id: 1,
          iid: 2,
          project_id: 10,
          title: sampleInput.title,
          web_url: 'https://gitlab.com/group/work/-/issues/2',
        }),
      };
    };

    const partialResult = await executeVent(sampleInput, options, {
      sessionID: 'ses_partial',
      directory: '/workspace',
      exec: partialCloneExec,
    });
    expect(partialResult.destination).toBe('work');
    expect(
      selectDestination(options, {
        fetchRemotes: ['git@gitlab.com:/group/work.git'],
      }).name,
    ).toBe('work');
    expect(
      selectDestination(options, {
        fetchRemotes: ['gitlab.com:group/work.git'],
      }).name,
    ).toBe('work');

    const failedGitTools: string[] = [];
    const failedGitExec: Exec = async (file): Promise<ExecResult> => {
      failedGitTools.push(file);
      return {
        code: 128,
        stdout: '',
        stderr: 'fatal: detected dubious ownership in repository at /workspace',
      };
    };

    await expect(
      executeVent(sampleInput, options, {
        sessionID: 'ses_fail_closed',
        directory: '/workspace',
        exec: failedGitExec,
      }),
    ).rejects.toThrow('Cannot evaluate enforced vent route for "work"');
    expect(failedGitTools).toEqual(['git', 'git']);
  });

  test('omits checkout-identifying metadata on unrelated overrides by default', async () => {
    const options = resolveOptions({
      defaultDestination: 'work',
      destinations: {
        work: { type: 'gitlab', project: 'group/work' },
        public: { type: 'github', repo: 'owner/public', acceptsUnrelated: true },
      },
      routes: [{ directoryPrefix: '/secret/work', destination: 'work', enforced: true }],
    });

    const payloads: Array<Record<string, unknown>> = [];
    const mockExec: Exec = async (_file, args, execOptions): Promise<ExecResult> => {
      if (!args.includes('--method')) return { code: 0, stderr: '', stdout: '[]' };
      if (execOptions?.stdin) {
        payloads.push(JSON.parse(execOptions.stdin) as Record<string, unknown>);
      }
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ html_url: 'https://github.com/owner/public/issues/1' }),
      };
    };

    await executeVent(
      {
        ...sampleInput,
        destination: 'public',
        unrelatedReason: 'Personal global plugin issue unrelated to the work repository.',
      },
      options,
      {
        sessionID: 'ses_secret_123',
        directory: '/secret/work/confidential-repo',
        remote: 'git@gitlab.com:group/confidential-repo.git',
        branch: 'secret-feature',
        exec: mockExec,
      },
    );

    const body = String(payloads[0]?.body ?? '');
    expect(body).not.toContain('/secret/work');
    expect(body).not.toContain('confidential-repo');
    expect(body).not.toContain('secret-feature');
    expect(body).not.toContain('ses_secret_123');
  });

  test('routes a fork with a matching fetch remote and leaves the log untouched on GitLab failure', async () => {
    const dir = await makeTempDir();
    const targetPath = join(dir, 'vents.md');
    const options = resolveOptions({
      defaultDestination: 'local',
      destinations: {
        local: { type: 'file', path: targetPath, acceptsUnrelated: true },
        gitlab: { type: 'gitlab', project: 'dev/friction', epic: 'org&42' },
      },
      routes: [
        {
          remoteRepository: 'gitlab.com/org/project',
          destination: 'gitlab',
          enforced: true,
        },
      ],
    });
    const mockExec: Exec = async (file, args) => {
      if (file === 'glab') return { code: 1, stdout: '', stderr: 'authorization failed' };
      return {
        code: 0,
        stdout: args.includes('remote')
          ? 'origin\thttps://gitlab.com/dev/fork.git (fetch)\nupstream\thttps://gitlab.com/org/project.git (fetch)\n'
          : 'main\n',
        stderr: '',
      };
    };
    const runtime = { sessionID: 'ses_999', directory: dir, exec: mockExec };
    await expect(
      executeVent({ ...sampleInput, destination: 'local' }, options, runtime),
    ).rejects.toThrow('unrelatedReason');
    await expect(executeVent(sampleInput, options, runtime)).rejects.toThrow(
      'authorization failed',
    );
    expect(await Bun.file(targetPath).exists()).toBe(false);
    const personal = await executeVent(
      {
        ...sampleInput,
        destination: 'local',
        unrelatedReason: 'An unrelated user-wide tool failed.',
      },
      options,
      runtime,
    );
    expect(personal.destinationType).toBe('file');
    expect(await Bun.file(targetPath).exists()).toBe(true);
    const legacy = await executeVent(
      {
        ...sampleInput,
        destination: 'local',
        localReason: 'The deprecated alias still works.',
      },
      options,
      runtime,
    );
    expect(legacy.destinationType).toBe('file');
  });
});

describe('closed matches', () => {
  const closedIssue = (labels: string[]) => ({
    number: 5,
    title: sampleInput.title,
    body: sampleInput.friction,
    html_url: 'https://github.com/owner/repo/issues/5',
    labels: labels.map((name) => ({ name })),
  });
  const githubDestination = {
    type: 'github' as const,
    repo: 'owner/repo',
    host: 'github.com',
    labels: ['agent-friction'],
    reopenLabels: ['resolution::cannot-reproduce', 'resolution::mitigated'],
    resolutionLabelPrefix: 'resolution::',
  };

  const githubExec = (closed: unknown[]) => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const exec: Exec = async (_file, args, options?: ExecOptions) => {
      calls.push({ args, stdin: options?.stdin });
      if (!args.includes('--method')) {
        const list = args.at(-1)!.includes('state=closed') ? closed : [];
        return { stdout: JSON.stringify(list), stderr: '', code: 0 };
      }
      return {
        stdout: JSON.stringify({
          html_url: 'https://github.com/owner/repo/issues/6',
        }),
        stderr: '',
        code: 0,
      };
    };
    return { exec, calls };
  };

  test('reports a closed match without writing, and advises reopening when it had no fix', async () => {
    const { exec, calls } = githubExec([
      closedIssue(['agent-friction', 'resolution::cannot-reproduce']),
    ]);
    const result = await ventToGitHub('github', githubDestination, sampleInput, sampleMetadata, {
      exec,
      threshold: 0.45,
    });
    expect(result.action).toBe('closed-match');
    expect(result.closedLabels).toEqual(['agent-friction', 'resolution::cannot-reproduce']);
    expect(result.note).toContain('onClosedMatch: "reopen"');
    expect(calls.some((call) => call.args.includes('--method'))).toBe(false);
  });

  test('advises a new linked issue when the closed match was fixed', async () => {
    const { exec } = githubExec([closedIssue(['agent-friction', 'resolution::fixed'])]);
    const result = await ventToGitHub('github', githubDestination, sampleInput, sampleMetadata, {
      exec,
      threshold: 0.45,
    });
    expect(result.action).toBe('closed-match');
    expect(result.note).toContain('onClosedMatch: "create"');
    expect(result.note).toContain('regression');
  });

  test('reopens a closed GitHub issue, drops its resolution label, and comments', async () => {
    const { exec, calls } = githubExec([
      closedIssue(['agent-friction', 'resolution::cannot-reproduce']),
    ]);
    const result = await ventToGitHub(
      'github',
      githubDestination,
      { ...sampleInput, onClosedMatch: 'reopen' },
      sampleMetadata,
      { exec, threshold: 0.45 },
    );
    expect(result.action).toBe('reopened');
    const writes = calls.filter((call) => call.args.includes('--method'));
    expect(writes).toHaveLength(2);
    expect(writes[0]!.args).toContain('PATCH');
    expect(writes[0]!.args).toContain('repos/owner/repo/issues/5');
    expect(JSON.parse(writes[0]!.stdin!)).toEqual({
      state: 'open',
      state_reason: 'reopened',
      labels: ['agent-friction'],
    });
    expect(writes[1]!.args).toContain('repos/owner/repo/issues/5/comments');
    expect(formatVentResult(result)).toContain('Reopened closed github issue');
  });

  test('files a new GitHub issue that links the closed match', async () => {
    const { exec, calls } = githubExec([closedIssue(['agent-friction', 'resolution::fixed'])]);
    const result = await ventToGitHub(
      'github',
      githubDestination,
      { ...sampleInput, onClosedMatch: 'create' },
      sampleMetadata,
      { exec, threshold: 0.45 },
    );
    expect(result.action).toBe('created');
    expect(result.note).toContain('https://github.com/owner/repo/issues/5');
    const writes = calls.filter((call) => call.args.includes('--method'));
    expect(writes).toHaveLength(1);
    const payload = JSON.parse(writes[0]!.stdin!) as { body: string };
    expect(payload.body).toContain(
      'Related to the closed issue https://github.com/owner/repo/issues/5.',
    );
  });

  test('reopens a closed GitLab issue and removes its resolution label', async () => {
    const calls: Array<{ args: string[]; stdin?: string }> = [];
    const exec: Exec = async (_file, args, options?: ExecOptions) => {
      calls.push({ args, stdin: options?.stdin });
      if (!args.includes('--method')) {
        const closed = args.at(-1)!.includes('state=closed');
        return {
          stdout: JSON.stringify(
            closed
              ? [
                  {
                    id: 1,
                    iid: 7,
                    project_id: 99,
                    title: sampleInput.title,
                    description: sampleInput.friction,
                    state: 'closed',
                    confidential: true,
                    labels: ['agent-friction', 'resolution::cannot-reproduce'],
                    web_url: 'https://gitlab.com/dev/friction/-/issues/7',
                  },
                ]
              : [],
          ),
          stderr: '',
          code: 0,
        };
      }
      return { stdout: JSON.stringify({ id: 55 }), stderr: '', code: 0 };
    };
    const result = await ventToGitLab(
      'gitlab',
      {
        type: 'gitlab',
        project: 'dev/friction',
        host: 'gitlab.com',
        confidential: true,
        labels: [],
        resolutionLabelPrefix: 'resolution::',
      },
      { ...sampleInput, onClosedMatch: 'reopen' },
      sampleMetadata,
      { exec, threshold: 0.45 },
    );
    expect(result.action).toBe('reopened');
    expect(result.url).toBe('https://gitlab.com/dev/friction/-/issues/7#note_55');
    const writes = calls.filter((call) => call.args.includes('--method'));
    expect(writes[0]!.args).toContain('PUT');
    expect(writes[0]!.args).toContain('projects/99/issues/7');
    expect(JSON.parse(writes[0]!.stdin!)).toEqual({
      state_event: 'reopen',
      remove_labels: 'resolution::cannot-reproduce',
    });
    expect(writes[1]!.args).toContain('projects/99/issues/7/notes');
  });

  test('validates onClosedMatch and closedMatchUrl target pinning', async () => {
    expect(parseVentInput({ ...sampleInput, onClosedMatch: 'reopen' }).onClosedMatch).toBe(
      'reopen',
    );
    expect(() => parseVentInput({ ...sampleInput, onClosedMatch: 'delete' })).toThrow(
      'Invalid `onClosedMatch`',
    );

    const { exec, calls } = githubExec([closedIssue(['agent-friction'])]);
    await expect(
      ventToGitHub(
        'github',
        { ...githubDestination, resolutionLabelPrefix: undefined },
        {
          ...sampleInput,
          onClosedMatch: 'reopen',
          closedMatchUrl: 'https://github.com/owner/repo/issues/999',
        },
        sampleMetadata,
        { exec, threshold: 0.45 },
      ),
    ).rejects.toThrow('does not match approved closedMatchUrl');

    await ventToGitHub(
      'github',
      { ...githubDestination, resolutionLabelPrefix: undefined },
      {
        ...sampleInput,
        onClosedMatch: 'reopen',
        closedMatchUrl: 'https://github.com/owner/repo/issues/5',
      },
      sampleMetadata,
      { exec, threshold: 0.45 },
    );
    const patchCall = calls.find((call) => call.args.includes('PATCH'));
    expect(JSON.parse(patchCall!.stdin!)).toEqual({
      state: 'open',
      state_reason: 'reopened',
    });
  });
});

describe('resolve-vent skill registration', () => {
  test('builds a resolve-vent skill tailored to configured destinations', () => {
    const options = resolveOptions({
      destinations: {
        gitlab: {
          type: 'gitlab',
          project: 'org/work-friction',
          epic: 'https://gitlab.com/groups/org/-/epics/42',
          labels: ['agent-friction'],
          resolutionLabelPrefix: 'status::',
          reopenLabels: ['status::needs-info', 'status::mitigated'],
        },
        github: {
          type: 'github',
          repo: 'owner/agent-friction',
          labels: ['agent-friction'],
        },
      },
    });

    const skill = buildResolveVentSkill(options);
    expect(skill.id).toBe(RESOLVE_VENT_SKILL_ID as Skill.ID);
    expect(skill.path).toBe('skill://resolve-vent/SKILL.md' as Skill.Info['path']);
    expect(skill.description).toContain('`org/work-friction` GitLab issues/work items');
    expect(skill.description).toContain('`owner/agent-friction` GitHub issues');
    expect(skill.content).toContain('**gitlab** (GitLab `gitlab.com`)');
    expect(skill.content).toContain('**github** (GitHub `github.com`)');
    expect(skill.content).toContain(
      '**gitlab**: `status::needs-info` or `status::mitigated` marks an item closed without a confirmed fix',
    );
    expect(skill.content).toContain(
      '**github**: no `reopenLabels` are configured. Ask the user whether to reopen the closed item and add the new evidence (`vent` with `onClosedMatch: "reopen"`, keeping its existing labels) or to file a new item that links the closed one (`onClosedMatch: "create"`).',
    );
    expect(skill.content).toContain('`status::cannot-reproduce`');
    expect(skill.content).toContain('glab api --hostname <host>');
    expect(skill.content).toContain('gh issue close <issue-url> --comment <text>');
    expect(skill.content).toContain('--reason duplicate --duplicate-of <primary>');

    const fileOnlySkill = buildResolveVentSkill(
      resolveOptions({
        destinations: {
          local: { type: 'file', path: '~/.agents/docs/vents.md' },
        },
      }),
    );
    expect(fileOnlySkill.content).toContain('append a `### Resolution`');
    expect(fileOnlySkill.content).toContain('`~/.agents/docs/vents.md`');
    expect(fileOnlySkill.content).not.toContain('gh issue close');
  });

  test('registers the skill via ctx.skill.transform unless a local override exists', async () => {
    const registeredSkills = new Map<string, Skill.Info>();
    let skillsDisposed = false;
    let toolsDisposed = false;
    let contextHookDisposed = false;

    const makeCtx = () =>
      ({
        options: {
          destinations: {
            github: { type: 'github', repo: 'owner/agent-friction' },
          },
        },
        location: { directory: '/workspace' },
        session: {
          get: async () => ({ location: { directory: '/workspace' } }),
          hook: async () => ({
            dispose: async () => {
              contextHookDisposed = true;
            },
          }),
        },
        skill: {
          transform: async (
            cb: (editor: {
              get: (id: string) => Skill.Info | undefined;
              add: (s: Skill.Info) => void;
            }) => void,
          ) => {
            cb({
              get: (id) => registeredSkills.get(id),
              add: (s) => registeredSkills.set(s.id, s),
            });
            return {
              dispose: async () => {
                skillsDisposed = true;
              },
            };
          },
        },
        tool: {
          transform: async (cb: (editor: { add: (t: unknown) => void }) => void) => {
            cb({ add: () => {} });
            return {
              dispose: async () => {
                toolsDisposed = true;
              },
            };
          },
        },
      }) as unknown as Plugin.Context;

    const cleanup = await plugin.setup(makeCtx());
    expect(registeredSkills.get(RESOLVE_VENT_SKILL_ID)?.description).toContain(
      '`owner/agent-friction` GitHub issues',
    );

    const customSkill = {
      id: RESOLVE_VENT_SKILL_ID as Skill.ID,
      name: RESOLVE_VENT_SKILL_ID as Skill.Name,
      description: 'Custom local skill override',
      path: '/Users/dev/.agents/skills/resolve-vent/SKILL.md' as Skill.Info['path'],
      content: '# Custom',
    };
    registeredSkills.set(RESOLVE_VENT_SKILL_ID, customSkill);
    await plugin.setup(makeCtx());
    expect(registeredSkills.get(RESOLVE_VENT_SKILL_ID)?.description).toBe(
      'Custom local skill override',
    );

    await cleanup?.();
    expect(skillsDisposed).toBe(true);
    expect(toolsDisposed).toBe(true);
    expect(contextHookDisposed).toBe(true);
  });
});
