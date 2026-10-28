import { describe, expect, test } from 'bun:test';
import type { GitLabMergeRequest, ReviewRequest } from './forge';
import {
  retargetChildren,
  stricter,
  type RetargetEntry,
  type RetargetOptions,
} from './lifecycle-execution';
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

const apply: EventPolicy = { mode: 'apply', actions: ['retarget'] };

function harness(
  remote: Partial<GitLabMergeRequest> = {},
  overrides: Partial<RetargetOptions> = {},
) {
  let current = {
    forge: 'gitlab',
    iid: '2',
    url: url('2'),
    state: 'opened',
    targetProject: 'g/p',
    targetBranch: 'branch-1',
    ...remote,
  } as ReviewRequest;
  const journal = new Map<string, RetargetEntry>();
  const calls: string[] = [];
  const reads: string[] = [];
  const options: RetargetOptions = {
    parent,
    children: [child],
    policy: apply,
    fetch: async (target) => {
      reads.push(target);
      return current;
    },
    retarget: async (request, branch) => {
      calls.push(`${request.iid} ${branch}`);
      current = { ...current, targetBranch: branch };
    },
    journal: {
      get: async (key) => journal.get(key),
      set: async (key, entry) => void journal.set(key, entry),
    },
    ...overrides,
  };
  return { options, journal, calls, reads, run: () => retargetChildren(options) };
}

describe('stricter', () => {
  test('keeps the lower mode and only the actions both allow', () => {
    const prepare: EventPolicy = { mode: 'prepare', actions: ['retarget'] };
    expect(stricter(apply, prepare)).toEqual(prepare);
    expect(stricter(prepare, apply)).toEqual(prepare);
    expect(stricter(apply, { mode: 'apply', actions: [] })).toEqual({ mode: 'apply', actions: [] });
    expect(stricter(apply, { mode: 'notify', actions: [] })).toEqual({
      mode: 'notify',
      actions: [],
    });
    // An event recorded without a policy, such as before execution existed.
    expect(stricter(undefined, apply)).toEqual({ mode: 'notify', actions: [] });
  });
});

describe('retargetChildren', () => {
  test('retargets a dependent MR to the branch its parent merged into, and confirms it', async () => {
    const app = harness();
    expect(await app.run()).toEqual(['Retargeted !2 from branch-1 to main.']);
    expect(app.calls).toEqual(['2 main']);
    // Read before and after the change.
    expect(app.reads).toEqual([url('2'), url('2')]);
    expect(app.journal.get(url('2'))).toMatchObject({
      state: 'done',
      from: 'branch-1',
      to: 'main',
    });
  });

  test('only describes or proposes without "apply" and its action', async () => {
    const notify = harness({}, { policy: { mode: 'notify', actions: [] } });
    expect(await notify.run()).toEqual(['!2 builds on !1: it targets branch-1.']);
    expect(notify.reads).toEqual([]);
    for (const policy of [
      { mode: 'prepare', actions: ['retarget'] },
      { mode: 'apply', actions: [] },
    ] as EventPolicy[]) {
      const app = harness({}, { policy });
      expect(await app.run()).toEqual(['Proposed: retarget !2 from branch-1 to main.']);
      expect(app.calls).toEqual([]);
      expect(app.journal.size).toBe(0);
    }
    const unsupported = harness({}, { retarget: undefined });
    expect(await unsupported.run()).toEqual([
      "Proposed: retarget !2 from branch-1 to main. Forgekeeper can't retarget on this forge.",
    ]);
  });

  test("leaves the MR alone when the forge's current state says so", async () => {
    for (const [remote, line] of [
      [{ targetBranch: 'main' }, '!2 already targets main.'],
      [{ targetBranch: 'other' }, '!2 now targets other, not branch-1, so it keeps its target.'],
      [{ state: 'merged' }, '!2 is no longer open, so it keeps its target.'],
      [{ targetProject: 'g/other' }, '!2 targets another project now, so it keeps its target.'],
    ] as const) {
      const app = harness(remote);
      expect(await app.run()).toEqual([line]);
      expect(app.calls).toEqual([]);
    }
    const gone = harness({}, { fetch: async () => undefined });
    expect(await gone.run()).toEqual(['!2 is no longer open, so it keeps its target.']);
  });

  test("doesn't guess a new target for a parent from a fork", async () => {
    const app = harness({}, { parent: { ...parent, sourceProject: 'fork/p' } });
    expect(await app.run()).toEqual([
      '!2 builds on !1, which came from another project, so its new target is unclear.',
    ]);
    expect(app.reads).toEqual([]);
  });

  test('reports a failed retarget, and a retry after a lost response finds it done', async () => {
    const app = harness(
      {},
      {
        retarget: async () => {
          throw new Error('403 Forbidden');
        },
      },
    );
    expect(await app.run()).toEqual([
      'Could not retarget !2 from branch-1 to main: 403 Forbidden.',
    ]);
    expect(app.journal.get(url('2'))?.state).toBe('running');
    // The change went through although its response was lost.
    const retry = harness({ targetBranch: 'main' });
    retry.journal.set(url('2'), app.journal.get(url('2'))!);
    expect(await retry.run()).toEqual(['!2 already targets main.']);
    expect(retry.calls).toEqual([]);
  });

  test('repeats a finished outcome without reading or changing anything again', async () => {
    const app = harness();
    await app.run();
    app.reads.length = 0;
    expect(await app.run()).toEqual(['Retargeted !2 from branch-1 to main.']);
    expect(app.reads).toEqual([]);
    expect(app.calls).toEqual(['2 main']);
  });

  test('reports a read failure without changing anything', async () => {
    const app = harness(
      {},
      {
        fetch: async () => {
          throw new Error('timeout');
        },
      },
    );
    expect(await app.run()).toEqual(['Could not read !2: timeout.']);
    expect(app.calls).toEqual([]);
  });
});
