import { describe, expect, test } from 'bun:test';
import type { Exec } from './exec';
import type { ReviewRef } from './forge';
import { createTitleLookups } from './lookups';

describe('createTitleLookups', () => {
  test('reads the source branch with the forge that the URL names', async () => {
    const runs: string[][] = [];
    const run: Exec = async (file, args) => {
      runs.push([file, ...args]);
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          data: { repository: { pullRequest: { headRefName: '34-fix' } } },
        }),
      };
    };
    const ref: ReviewRef = {
      forge: 'github',
      host: 'github.example.com',
      project: 'o/r',
      iid: '7',
    };
    expect(await createTitleLookups(run).sourceBranch(ref, '/repo')).toBe('34-fix');
    expect(runs[0].slice(0, 5)).toEqual([
      'gh',
      'api',
      'graphql',
      '--hostname',
      'github.example.com',
    ]);
  });

  test('treats a failed source branch lookup as unknown', async () => {
    const run: Exec = async () => ({ code: 1, stdout: '', stderr: 'gh: HTTP 502' });
    const ref: ReviewRef = { forge: 'gitlab', host: 'gitlab.com', project: 'g/p', iid: '7' };
    expect(await createTitleLookups(run).sourceBranch(ref, '/repo')).toBeUndefined();
  });
});
