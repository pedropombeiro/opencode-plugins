import { describe, expect, test } from 'bun:test';
import type { GitLabMergeRequest, ReviewRequest } from './forge';
import {
  createLifecycleWatcher,
  observe,
  unchanged,
  MAX_SEEN_FAILURES,
  UNLISTED_FAILURE,
  type LifecycleEvent,
  type LifecycleRecord,
} from './lifecycle-watch';

const mr = (iid: string, overrides: Partial<GitLabMergeRequest> = {}): ReviewRequest =>
  ({
    forge: 'gitlab',
    iid,
    url: `https://gitlab.com/g/p/-/merge_requests/${iid}`,
    state: 'opened',
    conflicts: false,
    conflictsKnown: true,
    targetProject: 'g/p',
    targetBranch: 'main',
    sourceProject: 'g/p',
    sourceBranch: `branch-${iid}`,
    ...overrides,
  }) as ReviewRequest;

const reference = (request: ReviewRequest) => `!${request.iid}`;

// Runs lookups through `observe` in order, as the watcher stores them.
function run(...lookups: ReviewRequest[][]) {
  let records = new Map<string, LifecycleRecord>();
  let at = 0;
  for (const requests of lookups) {
    const next = observe('one', requests, records, reference, ++at);
    records = new Map([...records, ...next.map((record) => [record.url, record] as const)]);
  }
  return records;
}

const events = (records: Map<string, LifecycleRecord>) =>
  [...records.values()].flatMap((record) => record.pending.map((event) => event.id));

describe('observe', () => {
  test('records the first lookup without events, so nothing old is announced', () => {
    const records = run([mr('1', { conflicts: true }), mr('2', { state: 'merged' })]);
    expect(events(records)).toEqual([]);
    expect(records.get(mr('1').url)).toMatchObject({ conflicts: true, cycles: 0, pending: [] });
  });

  test('announces a PR/MR that starts to conflict, once per conflict', () => {
    const records = run(
      [mr('1')],
      [mr('1', { conflicts: true })],
      [mr('1', { conflicts: true })],
      [mr('1')],
      [mr('1', { conflicts: true })],
    );
    expect(events(records)).toEqual([
      JSON.stringify(['one', mr('1').url, 'conflict', 1]),
      JSON.stringify(['one', mr('1').url, 'conflict', 2]),
    ]);
  });

  test('keeps the last known mergeability while the forge recalculates it', () => {
    const records = run(
      [mr('1')],
      [mr('1', { conflicts: true, conflictsKnown: false })],
      [mr('1', { conflicts: true })],
    );
    expect(events(records)).toHaveLength(1);
    // Without a known state yet, the first known conflict isn't a change.
    expect(
      events(run([mr('1', { conflictsKnown: false })], [mr('1', { conflicts: true })])),
    ).toEqual([]);
  });

  test('announces a merge, but not a close, nor a conflict on a PR/MR that is no longer open', () => {
    const records = run(
      [mr('1'), mr('2')],
      [mr('1', { state: 'merged', conflicts: true }), mr('2', { state: 'closed' })],
    );
    expect(events(records)).toEqual([JSON.stringify(['one', mr('1').url, 'merged'])]);
  });

  // A pipeline with these failed jobs, each `name` or `name#attempt`, still
  // running unless `status` says.
  const pipeline = (id: string, failed: string[], status = 'RUNNING', complete = true) => ({
    pipeline: {
      id,
      status,
      label: status.toLowerCase(),
      failedJobs: failed.map((entry) => ({
        id: `job-${entry}`,
        name: entry.split('#')[0],
        url: `https://gitlab.com/g/p/-/jobs/${entry}`,
      })),
      failedJobsComplete: complete,
    },
  });
  const failure = (id: string, ...jobs: string[]) =>
    JSON.stringify(['one', mr('1').url, 'ci-failed', id, jobs.map((job) => `job-${job}`)]);

  test('announces failed jobs while the pipeline still runs, and each later failure', () => {
    const records = run(
      [mr('1', pipeline('p1', []))],
      [mr('1', pipeline('p1', ['rspec']))],
      // A job that's still failing, and the pipeline's end, are nothing new.
      [mr('1', pipeline('p1', ['rspec']))],
      [mr('1', pipeline('p1', ['rspec', 'lint', 'security']))],
      [mr('1', pipeline('p1', ['rspec', 'lint', 'security'], 'FAILED'))],
    );
    expect(events(records)).toEqual([failure('p1', 'rspec'), failure('p1', 'lint', 'security')]);
    expect(records.get(mr('1').url)?.pending[1]).toMatchObject({
      kind: 'ci-failed',
      pipeline: 'p1',
      jobs: ['job-lint', 'job-security'],
    });
    expect(records.get(mr('1').url)?.ci).toMatchObject({
      id: 'p1',
      failed: true,
      running: false,
      complete: true,
    });
  });

  test('announces another pipeline that fails, and a retry that fails again', () => {
    const records = run(
      [mr('1', pipeline('p1', []))],
      [mr('1', pipeline('p1', ['rspec']))],
      // A retry is a new attempt of the job, which failed again.
      [mr('1', pipeline('p1', ['rspec#2']))],
      // A new pipeline that already fails when first seen is new.
      [mr('1', pipeline('p2', ['rspec']))],
    );
    expect(events(records)).toEqual([
      failure('p1', 'rspec'),
      failure('p1', 'rspec#2'),
      failure('p2', 'rspec'),
    ]);
  });

  test('announces a job attempt once, even when it leaves the listed jobs and comes back', () => {
    // Each lookup's events are delivered, as the watcher does, so an event
    // ID that repeats counts again.
    let records = new Map<string, LifecycleRecord>();
    const announced: string[] = [];
    for (const [at, failed] of [[], ['a'], ['b'], ['a']].entries()) {
      const [record] = observe(
        'one',
        [mr('1', pipeline('p1', failed, 'RUNNING', at === 0))],
        records,
        reference,
        at,
      );
      announced.push(...record.pending.map((event) => event.id));
      records = new Map([[record.url, { ...record, pending: [] }]]);
    }
    // Newer failures push `a` past the jobs the forge reads, then retries of
    // those let it back in.
    expect(announced).toEqual([failure('p1', 'a'), failure('p1', 'b')]);
    expect(records.get(mr('1').url)?.ci?.seen).toEqual(['job-a', 'job-b']);
    // Another pipeline starts afresh.
    const next = run([mr('1', pipeline('p1', ['a']))], [mr('1', pipeline('p2', ['a']))]);
    expect(next.get(mr('1').url)?.ci?.seen).toEqual(['job-a']);
  });

  test('keeps only the newest failed job attempts it has seen', () => {
    const many = Array.from({ length: MAX_SEEN_FAILURES + 5 }, (_, index) => `j${index}`);
    const records = run([mr('1', pipeline('p1', []))], [mr('1', pipeline('p1', many))]);
    const seen = records.get(mr('1').url)?.ci?.seen ?? [];
    expect(seen).toHaveLength(MAX_SEEN_FAILURES);
    expect(seen.at(-1)).toBe(`job-j${MAX_SEEN_FAILURES + 4}`);
  });

  test('records whether the forge listed every failed job', () => {
    const records = run([mr('1', pipeline('p1', ['rspec'], 'RUNNING', false))]);
    expect(records.get(mr('1').url)?.ci?.complete).toBe(false);
  });

  test("announces an unread job's failure once the pipeline's status reports it", () => {
    const records = run(
      [mr('1', pipeline('p1', []))],
      // Only jobs allowed to fail were read, and more failed: nothing is known.
      [mr('1', pipeline('p1', [], 'RUNNING', false))],
      [mr('1', pipeline('p1', [], 'FAILED', false))],
      [mr('1', pipeline('p1', [], 'FAILED', false))],
    );
    expect(events(records)).toEqual([
      JSON.stringify(['one', mr('1').url, 'ci-failed', 'p1', [UNLISTED_FAILURE]]),
    ]);
    expect(records.get(mr('1').url)?.ci).toMatchObject({ failed: true, unlisted: true });
  });

  test('records failed pipelines without events on the first lookup, and in older records', () => {
    expect(events(run([mr('1', pipeline('p1', ['rspec']))]))).toEqual([]);
    // A record from before Forgekeeper watched pipelines only learns it.
    const [legacy] = observe('one', [mr('1')], new Map(), reference, 1);
    delete legacy.ci;
    const [record] = observe(
      'one',
      [mr('1', pipeline('p1', ['rspec']))],
      new Map([[legacy.url, legacy]]),
      reference,
      2,
    );
    expect(record.pending).toEqual([]);
    expect(record.ci).toMatchObject({ id: 'p1', failed: true });
    // So does one from before Forgekeeper told job attempts apart.
    const unidentified = {
      ...record,
      ci: { id: 'p1', failed: true, running: true, jobs: [{ name: 'rspec' }] },
    } as unknown as LifecycleRecord;
    const [upgraded] = observe(
      'one',
      [mr('1', pipeline('p1', ['rspec']))],
      new Map([[record.url, unidentified]]),
      reference,
      3,
    );
    expect(upgraded.pending).toEqual([]);
    // Nor does a PR/MR that's no longer open announce one.
    expect(
      events(
        run(
          [mr('1', pipeline('p1', []))],
          [mr('1', { state: 'closed', ...pipeline('p1', ['x']) })],
        ),
      ),
    ).toEqual([]);
  });

  test('counts a failed job only in a pipeline the forge identifies', () => {
    const unidentified = { pipeline: { status: 'FAILED', label: 'failed' } };
    expect(events(run([mr('1')], [mr('1', unidentified)]))).toEqual([]);
  });

  test('records the delivery mode each event happened under, except the inbox', () => {
    const previous = new Map([[mr('1').url, run([mr('1')]).get(mr('1').url)!]]);
    const merged = [mr('1', { state: 'merged' })];
    const pending = (mode: 'inbox' | 'summary') =>
      observe('one', merged, previous, reference, 5, undefined, () => mode)[0].pending;
    expect(pending('summary')).toMatchObject([{ kind: 'merged', delivery: 'summary' }]);
    expect(pending('inbox')[0].delivery).toBeUndefined();
  });

  test('records the policy each event happened under', () => {
    const policy = { mode: 'prepare' as const, actions: ['retarget' as const] };
    const [record] = observe(
      'one',
      [mr('1', { state: 'merged' })],
      new Map([[mr('1').url, run([mr('1')]).get(mr('1').url)!]]),
      reference,
      5,
      (kind) => (kind === 'merged' ? policy : undefined),
    );
    expect(record.pending).toEqual([
      { kind: 'merged', id: JSON.stringify(['one', mr('1').url, 'merged']), detectedAt: 5, policy },
    ]);
  });

  test('links a target to the one whose source branch it targets, and keeps that after a merge', () => {
    const parent = mr('1');
    const child = mr('2', { targetBranch: 'branch-1' });
    let records = run([parent, child]);
    expect(records.get(child.url)?.parent).toBe(parent.url);
    // GitLab retargets the child and deletes the branch when the parent merges.
    records = run([parent, child], [mr('1', { state: 'merged' }), mr('2')]);
    expect(records.get(child.url)?.parent).toBe(parent.url);
    // A parent that's still open and no longer matches isn't one.
    expect(run([parent, child], [parent, mr('2')]).get(child.url)?.parent).toBeUndefined();
    // Nor is one the session no longer targets.
    expect(run([parent, child], [mr('2')]).get(child.url)?.parent).toBeUndefined();
  });

  test('links only matching projects on the same host, and nothing when several match', () => {
    const child = mr('2', { targetBranch: 'branch-1' });
    expect(run([mr('1', { sourceProject: 'fork/p' }), child]).get(child.url)?.parent).toBe(
      undefined,
    );
    const elsewhere = mr('1', { url: 'https://example.com/g/p/-/merge_requests/1' });
    expect(run([elsewhere, child]).get(child.url)?.parent).toBeUndefined();
    const twin = mr('3', { sourceBranch: 'branch-1' });
    expect(run([mr('1'), twin, child]).get(child.url)?.parent).toBeUndefined();
  });

  test('compares records without their write time', () => {
    const [a] = observe('one', [mr('1')], new Map(), reference, 1);
    const [b] = observe('one', [mr('1')], new Map(), reference, 2);
    expect(unchanged(a, b)).toBe(true);
    expect(unchanged(a, { ...b, conflicts: true })).toBe(false);
    expect(unchanged(undefined, b)).toBe(false);
  });
});

describe('createLifecycleWatcher', () => {
  function harness(deliver: (event: LifecycleEvent) => Promise<boolean>) {
    const stored = new Map<string, LifecycleRecord>();
    const writes: LifecycleRecord[] = [];
    const watcher = createLifecycleWatcher({
      records: async (sessionID) =>
        [...stored.values()].filter((record) => record.sessionID === sessionID),
      write: async (record) => {
        writes.push(structuredClone(record));
        stored.set(record.url, structuredClone(record));
      },
      waiting: async () => [...stored.values()].filter((record) => record.pending.length),
      deliver: (_record, event) => deliver(event),
      reference,
      now: () => 1,
    });
    return { watcher, stored, writes };
  }

  test('stores each event with its baseline before delivering it', async () => {
    const delivered: string[] = [];
    const app = harness(async (event) => {
      // The event is already stored when its delivery starts.
      expect(app.stored.get(mr('1').url)?.pending.map((entry) => entry.id)).toContain(event.id);
      delivered.push(event.kind);
      return true;
    });
    await app.watcher.observe('one', [mr('1')]);
    expect(app.writes).toHaveLength(1);
    // An unchanged lookup writes nothing.
    await app.watcher.observe('one', [mr('1')]);
    expect(app.writes).toHaveLength(1);
    await app.watcher.observe('one', [mr('1', { state: 'merged' })]);
    expect(delivered).toEqual(['merged']);
    expect(app.stored.get(mr('1').url)?.pending).toEqual([]);
  });

  test('keeps an event that fails for a retry, and drops one its delivery refuses', async () => {
    let failing = true;
    const delivered: string[] = [];
    const app = harness(async (event) => {
      if (failing && event.kind === 'merged') throw new Error('session unavailable');
      delivered.push(event.kind);
      return event.kind !== 'conflict';
    });
    await app.watcher.observe('one', [mr('1'), mr('2')]);
    await expect(
      app.watcher.observe('one', [mr('1', { state: 'merged' }), mr('2', { conflicts: true })]),
    ).rejects.toThrow('session unavailable');
    // The other event still went, and the failed one waits.
    expect(delivered).toEqual(['conflict']);
    expect(app.stored.get(mr('1').url)?.pending).toHaveLength(1);
    expect(app.stored.get(mr('2').url)?.pending).toEqual([]);
    // Nothing polls a merged MR, so only the retry delivers it.
    failing = false;
    await app.watcher.retry();
    expect(delivered).toEqual(['conflict', 'merged']);
    expect(app.stored.get(mr('1').url)?.pending).toEqual([]);
  });

  test("runs a session's lookups one at a time, so concurrent ones announce once", async () => {
    const delivered: string[] = [];
    const app = harness(async (event) => {
      delivered.push(event.id);
      return true;
    });
    await app.watcher.observe('one', [mr('1')]);
    await Promise.all([
      app.watcher.observe('one', [mr('1', { state: 'merged' })]),
      app.watcher.observe('one', [mr('1', { state: 'merged' })]),
      app.watcher.retry(),
    ]);
    expect(delivered).toHaveLength(1);
  });
});
