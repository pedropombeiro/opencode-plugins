import { describe, expect, test } from 'bun:test';
import type { GitLabMergeRequest, ReviewRequest } from './forge';
import { proposeRetargets, stricter, type RetargetOptions } from './lifecycle-execution';
import type { LifecycleRecord } from './lifecycle-watch';
import type { EventPolicy } from './options';

const url = (iid: string) => `https://gitlab.com/g/p/-/merge_requests/${iid}`;

const record = (iid: string, overrides: Partial<LifecycleRecord> = {}): LifecycleRecord => ({
  sessionID: 'one',
  url: url(iid),
  reference: `!${iid}`,
  state: 'opened',
  cycles: 0,
  targetProject: 'g/p',
  targetBranch: 'main',
  sourceProject: 'g/p',
  sourceBranch: `branch-${iid}`,
  pending: [],
  at: 0,
  ...overrides,
});

const parent = record('1', { state: 'merged' });
const child = record('2', { targetBranch: 'branch-1', parent: url('1') });

const prepare: EventPolicy = { mode: 'prepare', actions: ['retarget'] };
const notify: EventPolicy = { mode: 'notify', actions: [] };

function harness(
  remote: Partial<GitLabMergeRequest> = {},
  overrides: Partial<RetargetOptions> = {},
) {
  const current = {
    forge: 'gitlab',
    iid: '2',
    url: url('2'),
    state: 'opened',
    targetProject: 'g/p',
    targetBranch: 'branch-1',
    ...remote,
  } as ReviewRequest;
  const reads: string[] = [];
  const options: RetargetOptions = {
    parent,
    children: [child],
    policy: prepare,
    fetch: async (target) => {
      reads.push(target);
      return current;
    },
    ...overrides,
  };
  return { reads, lines: () => proposeRetargets(options) };
}

describe('stricter', () => {
  test('keeps the lower mode and only the actions both allow', () => {
    expect(stricter(prepare, prepare)).toEqual(prepare);
    expect(stricter(prepare, { mode: 'prepare', actions: [] })).toEqual({
      mode: 'prepare',
      actions: [],
    });
    expect(stricter(prepare, notify)).toEqual(notify);
    expect(stricter(notify, prepare)).toEqual(notify);
    // An event recorded without a policy, such as before policies existed.
    expect(stricter(undefined, prepare)).toEqual(notify);
    // One recorded with `apply`, which an earlier release had.
    const applied = { mode: 'apply', actions: ['retarget'] } as unknown as EventPolicy;
    expect(stricter(applied, prepare)).toEqual(notify);
  });
});

describe('proposeRetargets', () => {
  test('proposes retargeting a dependent MR to the branch its parent merged into', async () => {
    const app = harness();
    expect(await app.lines()).toEqual(['Proposed: retarget !2 from branch-1 to main.']);
    expect(app.reads).toEqual([url('2')]);
  });

  test('only describes the dependents without "prepare" and its action', async () => {
    // Without the retarget action, such as when `stricter` keeps only the
    // actions both policies allow, nothing is worked out.
    for (const policy of [notify, { mode: 'prepare', actions: [] }] as EventPolicy[]) {
      const app = harness({}, { policy });
      expect(await app.lines()).toEqual(['!2 builds on !1: it targets branch-1.']);
      expect(app.reads).toEqual([]);
    }
  });

  test("proposes nothing when the forge's current state says so", async () => {
    for (const [remote, line] of [
      // Such as after GitLab retargeted it, when the merge deleted the branch.
      [{ targetBranch: 'main' }, '!2 already targets main.'],
      [{ targetBranch: 'other' }, '!2 now targets other, not branch-1, so it keeps its target.'],
      [{ state: 'merged' }, '!2 is no longer open, so it keeps its target.'],
      [{ targetProject: 'g/other' }, '!2 targets another project now, so it keeps its target.'],
    ] as const) {
      expect(await harness(remote).lines()).toEqual([line]);
    }
    const gone = harness({}, { fetch: async () => undefined });
    expect(await gone.lines()).toEqual(['!2 is no longer open, so it keeps its target.']);
  });

  test("doesn't guess a new target for a parent from a fork", async () => {
    const app = harness({}, { parent: { ...parent, sourceProject: 'fork/p' } });
    expect(await app.lines()).toEqual([
      '!2 builds on !1, which came from another project, so its new target is unclear.',
    ]);
    expect(app.reads).toEqual([]);
  });

  test('reports a failed read', async () => {
    const app = harness(
      {},
      {
        fetch: async () => {
          throw new Error('timeout');
        },
      },
    );
    expect(await app.lines()).toEqual(['Could not read !2: timeout.']);
  });
});
