import { describe, expect, test } from 'bun:test';
import type { GitLabMergeRequest, ReviewRequest } from './forge';
import {
  MAX_RETARGET_ATTEMPTS,
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
    allowed: async () => true,
    retarget: async (request, branch) => {
      calls.push(`${request.iid} ${branch}`);
      current = { ...current, targetBranch: branch };
    },
    journal: {
      get: async (key) => journal.get(key),
      set: async (key, entry) => void journal.set(key, structuredClone(entry)),
    },
    ...overrides,
  };
  return {
    options,
    journal,
    calls,
    reads,
    run: () => retargetChildren(options),
    lines: async () => (await retargetChildren(options)).lines,
  };
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
    expect(await app.run()).toEqual({
      lines: ['Retargeted !2 from branch-1 to main.'],
      retry: false,
    });
    expect(app.calls).toEqual(['2 main']);
    // Read before and after the change.
    expect(app.reads).toEqual([url('2'), url('2')]);
    expect(app.journal.get(url('2'))).toMatchObject({
      state: 'done',
      from: 'branch-1',
      to: 'main',
      attempts: 1,
      sent: true,
    });
  });

  test('only describes or proposes without "apply" and its action', async () => {
    // Without the retarget action, neither mode works anything out, such as
    // when `stricter` keeps only the actions both policies allow.
    for (const policy of [
      { mode: 'notify', actions: [] },
      { mode: 'prepare', actions: [] },
      { mode: 'apply', actions: [] },
    ] as EventPolicy[]) {
      const app = harness({}, { policy });
      expect(await app.lines()).toEqual(['!2 builds on !1: it targets branch-1.']);
      expect(app.reads).toEqual([]);
      expect(app.journal.size).toBe(0);
    }
    const prepare = harness({}, { policy: { mode: 'prepare', actions: ['retarget'] } });
    expect(await prepare.lines()).toEqual(['Proposed: retarget !2 from branch-1 to main.']);
    expect(prepare.calls).toEqual([]);
    expect(prepare.journal.size).toBe(0);
    const unsupported = harness({}, { retarget: undefined });
    expect(await unsupported.lines()).toEqual([
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
      expect(await app.lines()).toEqual([line]);
      expect(app.calls).toEqual([]);
    }
    const gone = harness({}, { fetch: async () => undefined });
    expect(await gone.lines()).toEqual(['!2 is no longer open, so it keeps its target.']);
  });

  test('leaves a dependent alone that the session dropped while it was read', async () => {
    const app = harness({}, { allowed: async () => false });
    expect(await app.lines()).toEqual([
      '!2 is no longer a target of this session, so Forgekeeper left it alone.',
    ]);
    expect(app.calls).toEqual([]);
    expect(app.journal.get(url('2'))?.state).toBe('done');
  });

  test("doesn't guess a new target for a parent from a fork", async () => {
    const app = harness({}, { parent: { ...parent, sourceProject: 'fork/p' } });
    expect(await app.lines()).toEqual([
      '!2 builds on !1, which came from another project, so its new target is unclear.',
    ]);
    expect(app.reads).toEqual([]);
  });

  test('retries a failed retarget, and counts one whose response was lost as done', async () => {
    let failing = true;
    const app = harness(
      {},
      {
        retarget: async () => {
          if (failing) throw new Error('timeout');
        },
      },
    );
    expect(await app.run()).toEqual({
      lines: ['Could not retarget !2 from branch-1 to main: timeout.'],
      retry: true,
    });
    expect(app.journal.get(url('2'))).toMatchObject({ state: 'running', attempts: 1, sent: true });
    // The change went through although its response was lost.
    failing = false;
    const retry = harness({ targetBranch: 'main' });
    retry.journal.set(url('2'), app.journal.get(url('2'))!);
    expect(await retry.run()).toEqual({
      lines: ['Retargeted !2 from branch-1 to main.'],
      retry: false,
    });
    expect(retry.calls).toEqual([]);
    expect(retry.journal.get(url('2'))).toMatchObject({ state: 'done', attempts: 2 });
  });

  test('gives up after the attempt limit, failed reads included', async () => {
    const app = harness(
      {},
      {
        fetch: async () => {
          throw new Error('timeout');
        },
      },
    );
    for (let attempt = 1; attempt < MAX_RETARGET_ATTEMPTS; attempt++)
      expect(await app.run()).toEqual({ lines: ['Could not read !2: timeout.'], retry: true });
    expect(await app.run()).toEqual({
      lines: [
        `Could not read !2: timeout. Forgekeeper gave up after ${MAX_RETARGET_ATTEMPTS} attempts.`,
      ],
      retry: false,
    });
    expect(app.journal.get(url('2'))?.state).toBe('done');
    expect(app.calls).toEqual([]);
  });

  test('never sends another change after a reload interrupts the last attempt', async () => {
    const interrupted: RetargetEntry = {
      state: 'running',
      from: 'branch-1',
      to: 'main',
      attempts: MAX_RETARGET_ATTEMPTS,
      sent: true,
    };
    const app = harness();
    app.journal.set(url('2'), interrupted);
    expect(await app.run()).toEqual({
      lines: [
        `Could not retarget !2 from branch-1 to main. Forgekeeper gave up after ${MAX_RETARGET_ATTEMPTS} attempts.`,
      ],
      retry: false,
    });
    expect(app.calls).toEqual([]);
    expect(app.journal.get(url('2'))).toMatchObject({
      state: 'done',
      attempts: MAX_RETARGET_ATTEMPTS,
    });
    // It still reports a change that the interrupted attempt made.
    const landed = harness({ targetBranch: 'main' });
    landed.journal.set(url('2'), interrupted);
    expect(await landed.lines()).toEqual(['Retargeted !2 from branch-1 to main.']);
    expect(landed.calls).toEqual([]);
    // And a read that fails then doesn't earn another attempt.
    const unreadable = harness(
      {},
      {
        fetch: async () => {
          throw new Error('timeout');
        },
      },
    );
    unreadable.journal.set(url('2'), interrupted);
    expect(await unreadable.run()).toEqual({
      lines: [
        `Could not read !2: timeout. Forgekeeper gave up after ${MAX_RETARGET_ATTEMPTS} attempts.`,
      ],
      retry: false,
    });
  });

  test('retries when it cannot tell whether the session still targets the dependent', async () => {
    const app = harness(
      {},
      {
        allowed: async () => {
          throw new Error('session unavailable');
        },
      },
    );
    expect(await app.run()).toEqual({
      lines: ['Could not check !2: session unavailable.'],
      retry: true,
    });
    expect(app.calls).toEqual([]);
  });

  test('repeats a finished outcome without reading or changing anything again', async () => {
    const app = harness();
    await app.run();
    app.reads.length = 0;
    expect(await app.lines()).toEqual(['Retargeted !2 from branch-1 to main.']);
    expect(app.reads).toEqual([]);
    expect(app.calls).toEqual(['2 main']);
  });

  test('reports a read failure while preparing without retrying', async () => {
    const app = harness(
      {},
      {
        policy: { mode: 'prepare', actions: ['retarget'] },
        fetch: async () => {
          throw new Error('timeout');
        },
      },
    );
    expect(await app.run()).toEqual({ lines: ['Could not read !2: timeout.'], retry: false });
    expect(app.journal.size).toBe(0);
  });
});
