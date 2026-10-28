import { describe, expect, test } from 'bun:test';
import type { GitLabMergeRequest, ReviewRequest } from './forge';
import {
  createLifecycleWatcher,
  observe,
  unchanged,
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

  test('records the policy each event happened under', () => {
    const policy = { mode: 'apply' as const, actions: ['retarget' as const] };
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
