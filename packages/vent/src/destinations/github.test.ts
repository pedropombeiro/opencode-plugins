import { describe, expect, test } from 'bun:test';
import type { Exec, ExecOptions, ExecResult } from '../exec.ts';
import { sampleInput, sampleMetadata } from '../testing.ts';
import { ventToGitHub } from './github.ts';

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
