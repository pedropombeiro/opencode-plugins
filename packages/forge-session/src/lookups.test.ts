import { describe, expect, test } from 'bun:test';
import type { Exec } from './exec';
import type { Forge, ReviewRef } from './forge';
import { traits, type ForgeCatalog } from './forges';
import type { Repository } from './git';
import { createTitleLookups, NUMBER_TTL } from './lookups';

const repository: Repository = {
  head: 'abc',
  branch: 'local-12-fix',
  sourceBranch: '12-fix',
  source: { host: 'gitlab.com', path: 'me/project' },
  targets: [{ host: 'gitlab.com', path: 'me/project' }],
};

function catalog(numbers: Array<string | undefined | Error>): {
  forges: ForgeCatalog;
  calls: string[];
} {
  const calls: string[] = [];
  const forge = {
    traits: traits('gitlab'),
    async findNumberByBranch(input: Repository) {
      calls.push(input.sourceBranch);
      const next = numbers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  } as unknown as Forge;
  return {
    calls,
    forges: {
      kinds: ['gitlab'],
      kind: () => 'gitlab',
      forHost: (host) => (host === 'gitlab.com' ? forge : undefined),
      projects: async () => [],
      repository: async () => ({ kind: 'repository', repository }),
    },
  };
}

const unused: Exec = async () => ({ code: 1, stdout: '', stderr: 'unused' });

describe('createTitleLookups', () => {
  test('reports the local branch with the number found for its pushed branch', async () => {
    const { forges, calls } = catalog(['45']);
    const found = await createTitleLookups(forges, unused).branch('/repo');
    expect(found).toMatchObject({ branch: 'local-12-fix', number: '45' });
    expect(found?.forge.kind).toBe('gitlab');
    expect(calls).toEqual(['12-fix']);
  });

  test('keeps found numbers and retries missing or failed lookups', async () => {
    const { forges, calls } = catalog([undefined, new Error('offline'), '45']);
    const lookups = createTitleLookups(forges, unused);
    expect((await lookups.branch('/repo'))?.number).toBeUndefined();
    expect((await lookups.branch('/repo'))?.number).toBeUndefined();
    expect((await lookups.branch('/repo'))?.number).toBe('45');
    expect((await lookups.branch('/repo'))?.number).toBe('45');
    expect(calls).toHaveLength(3);
  });

  test('looks a found number up again once it expires, keeping it if that lookup fails', async () => {
    let clock = 0;
    const { forges, calls } = catalog(['1', new Error('offline'), '2', undefined]);
    const lookups = createTitleLookups(forges, unused, () => clock);
    expect((await lookups.branch('/repo'))?.number).toBe('1');
    clock += NUMBER_TTL - 1;
    expect((await lookups.branch('/repo'))?.number).toBe('1');
    expect(calls).toHaveLength(1);
    clock += 1;
    expect((await lookups.branch('/repo'))?.number).toBe('1');
    // A new PR/MR from the same branch replaces the old one.
    expect((await lookups.branch('/repo'))?.number).toBe('2');
    clock += NUMBER_TTL;
    // The forge reports no open PR/MR anymore.
    expect((await lookups.branch('/repo'))?.number).toBeUndefined();
    expect(calls).toHaveLength(4);
  });

  test('skips checkouts without a supported repository', async () => {
    const { forges } = catalog([]);
    const none: ForgeCatalog = {
      ...forges,
      repository: async () => ({ kind: 'none', reason: 'Default branch' }),
    };
    expect(await createTitleLookups(none, unused).branch('/repo')).toBeUndefined();
  });

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
    expect(await createTitleLookups(catalog([]).forges, run).sourceBranch(ref, '/repo')).toBe(
      '34-fix',
    );
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
    expect(
      await createTitleLookups(catalog([]).forges, run).sourceBranch(ref, '/repo'),
    ).toBeUndefined();
  });
});
