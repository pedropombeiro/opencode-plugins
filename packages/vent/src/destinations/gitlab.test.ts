import { describe, expect, test } from 'bun:test';
import type { Exec, ExecOptions, ExecResult } from '../exec.ts';
import { formatVentResult } from '../index.ts';
import { sampleInput, sampleMetadata } from '../testing.ts';
import { parseGitLabEpicRef, ventToGitLab } from './gitlab.ts';

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
