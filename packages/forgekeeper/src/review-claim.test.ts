import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewClaims } from './review-claim';
import type { AutomationRecord } from './review-automation';
import { Database } from 'bun:sqlite';

describe('atomic review execution claims', () => {
  test('migrates legacy worktree attempts without losing claims or compare-and-set semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgekeeper-migration-'));
    try {
      const claims = createReviewClaims(root);
      const legacy = {
        batch: 'batch',
        messageID: 'message',
        state: 'running',
        attempt: 1,
        at: 1,
        item: { id: 'item', sessionID: 'one', url: 'target', title: 'Review', links: [], at: 1 },
        checkout: 'worktree',
        execution: {
          stage: 'submitting',
          ownerDirectory: '/owner',
          head: 'abc',
          sourceProject: 'team/project',
          sourceBranch: 'feature',
          directory: '/worktree',
          sessionID: 'linked',
          detached: true,
          prompt: 'task',
        },
      };
      await claims.records.save(legacy as unknown as AutomationRecord);
      await claims.acquire('target', { sessionID: 'one', messageID: 'message', batch: 'batch' });
      claims.close();
      const restored = createReviewClaims(root);
      try {
        const record = (await restored.records.read('batch'))!;
        expect(record).toMatchObject({
          placement: 'environment',
          execution: {
            provider: 'local-worktree',
            version: 1,
            stage: 'submitting',
            prompt: 'task',
            state: { directory: '/worktree', sessionID: 'linked', detached: true },
          },
        });
        expect(record).not.toHaveProperty('checkout');
        expect(await restored.read('target')).toBeDefined();
        expect(await restored.records.finish({ ...record, state: 'completed' }, record)).toBe(true);
        expect(await restored.read('target')).toBeUndefined();
      } finally {
        restored.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  test('a failed admission rolls back the claim and leaves a recoverable queued attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgekeeper-rollback-'));
    const claims = createReviewClaims(root);
    let database: Database | undefined;
    try {
      const queued: AutomationRecord = {
        batch: 'batch',
        messageID: 'message',
        state: 'queued',
        attempt: 1,
        at: 1,
        item: { id: 'item', sessionID: 'one', url: 'target', title: 'Review', links: [], at: 1 },
      };
      await claims.records.save(queued);
      database = new Database(join(root, 'automation.sqlite'));
      database.run(
        "CREATE TRIGGER fail_admission BEFORE UPDATE ON attempts BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END",
      );
      const running: AutomationRecord = { ...queued, state: 'running' };
      await expect(claims.records.start(running, queued)).rejects.toThrow(
        'simulated write failure',
      );
      expect(await claims.read('target')).toBeUndefined();
      expect(await claims.records.read('batch')).toEqual(queued);
      database.run('DROP TRIGGER fail_admission');
      expect(await claims.records.start(running, queued)).toBe(true);
    } finally {
      database?.close();
      claims.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  test('independent instances acquire one shared per-target claim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgekeeper-claims-'));
    try {
      const first = createReviewClaims(root);
      const second = createReviewClaims(root);
      const claim = { sessionID: 'one', messageID: 'message', batch: 'batch' };
      const results = await Promise.all([
        first.acquire('target', claim),
        second.acquire('target', claim),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await second.read('target')).toEqual(claim);
      await second.release('target', { ...claim, messageID: 'other' });
      expect(await first.read('target')).toEqual(claim);
      await first.release('target', claim);
      expect(await second.acquire('target', claim)).toBe(true);
      await first.release('target', { ...claim, messageID: 'stale' });
      expect(await second.read('target')).toEqual(claim);
      first.close();
      second.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('admission persists the running attempt and claim together across reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgekeeper-claims-'));
    try {
      const claims = createReviewClaims(root);
      const queued: AutomationRecord = {
        batch: 'batch',
        messageID: 'message',
        state: 'queued',
        attempt: 1,
        at: 1,
        item: { id: 'item', sessionID: 'one', url: 'target', title: 'Review', links: [], at: 1 },
      };
      expect(await claims.records.save(queued)).toBe(true);
      const running: AutomationRecord = { ...queued, state: 'running' };
      expect(await claims.records.start(running, queued)).toBe(true);
      claims.close();
      const restored = createReviewClaims(root);
      expect(await restored.records.read('batch')).toEqual(running);
      expect(await restored.read('target')).toEqual({
        sessionID: 'one',
        messageID: 'message',
        batch: 'batch',
      });
      restored.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('finishing records the outcome and frees only its own claim, atomically', async () => {
    const claims = createReviewClaims(':memory:');
    try {
      const queued: AutomationRecord = {
        batch: 'batch',
        messageID: 'message',
        state: 'queued',
        attempt: 1,
        at: 1,
        item: { id: 'item', sessionID: 'one', url: 'target', title: 'Review', links: [], at: 1 },
      };
      await claims.records.save(queued);
      const running: AutomationRecord = { ...queued, state: 'running' };
      await claims.records.start(running, queued);
      const completed: AutomationRecord = { ...running, state: 'completed' };
      expect(await claims.records.finish(completed, queued)).toBe(false);
      expect(await claims.read('target')).toBeDefined();
      expect(await claims.records.finish(completed, running)).toBe(true);
      expect(await claims.read('target')).toBeUndefined();
      expect(await claims.records.read('batch')).toEqual(completed);
      const other = { sessionID: 'two', messageID: 'other', batch: 'other' };
      await claims.acquire('target', other);
      const failed: AutomationRecord = { ...completed, state: 'failed' };
      expect(await claims.records.finish(failed, completed)).toBe(true);
      expect(await claims.read('target')).toEqual(other);
    } finally {
      claims.close();
    }
  });

  test('independent writers cannot overwrite progress or acquire a claim from a stale record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgekeeper-cas-'));
    const first = createReviewClaims(root);
    const second = createReviewClaims(root);
    try {
      const queued: AutomationRecord = {
        batch: 'batch',
        messageID: 'message',
        state: 'queued',
        attempt: 1,
        at: 1,
        item: { id: 'item', sessionID: 'one', url: 'target', title: 'Review', links: [], at: 1 },
      };
      await first.records.save(queued);
      const stale = (await second.records.read('batch'))!;
      const running: AutomationRecord = { ...queued, state: 'running' };
      expect(await first.records.start(running, queued)).toBe(true);
      expect(await second.records.save({ ...stale, state: 'skipped' }, stale)).toBe(false);
      expect(await second.records.start(running, stale)).toBe(false);
      const completed: AutomationRecord = { ...running, state: 'completed' };
      expect(await first.records.save(completed, running)).toBe(true);
      expect(await second.records.save({ ...running, startedAt: 2 }, running)).toBe(false);
      expect(await first.records.read('batch')).toEqual(completed);
    } finally {
      first.close();
      second.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

const item = { id: 'item', sessionID: 'one', url: 'target', title: 'Review', links: [], at: 1 };
const queued: AutomationRecord = {
  batch: 'batch',
  messageID: 'message',
  state: 'queued',
  attempt: 1,
  at: 1,
  item,
};

describe('checkout locks', () => {
  const lock = { batch: 'batch', messageID: 'message', url: 'target', at: 1 };

  test('one attempt holds a directory until its outcome frees the PR/MR', async () => {
    const claims = createReviewClaims(':memory:');
    try {
      await claims.records.save(queued);
      const running: AutomationRecord = { ...queued, state: 'running' };
      expect(await claims.records.start(running, queued)).toBe(true);
      expect(await claims.locks.acquire('/wt', lock)).toBe(true);
      // The holder may take it again; another attempt can't.
      expect(await claims.locks.acquire('/wt', lock)).toBe(true);
      expect(await claims.locks.acquire('/wt', { ...lock, batch: 'other' })).toBe(false);
      expect(await claims.records.finish({ ...running, state: 'completed' }, running)).toBe(true);
      expect(await claims.locks.read('/wt')).toBeUndefined();
    } finally {
      claims.close();
    }
  });

  test('releasing a claim frees the directories its attempt holds', async () => {
    const claims = createReviewClaims(':memory:');
    try {
      const claim = { sessionID: 'one', messageID: 'message', batch: 'batch' };
      await claims.records.save(queued);
      expect(await claims.records.start({ ...queued, state: 'running' }, queued)).toBe(true);
      expect(await claims.locks.acquire('/wt', lock)).toBe(true);
      // A stale release frees nothing.
      await claims.release('target', { ...claim, messageID: 'stale' });
      expect(await claims.locks.read('/wt')).toEqual(lock);
      await claims.release('target', claim);
      expect(await claims.locks.read('/wt')).toBeUndefined();
    } finally {
      claims.close();
    }
  });

  test('only a running attempt that holds its claim takes a directory', async () => {
    const claims = createReviewClaims(':memory:');
    try {
      // Not stored, then queued without the claim.
      expect(await claims.locks.acquire('/wt', lock)).toBe(false);
      await claims.records.save(queued);
      expect(await claims.locks.acquire('/wt', lock)).toBe(false);
      const running: AutomationRecord = { ...queued, state: 'running' };
      expect(await claims.records.start(running, queued)).toBe(true);
      // An earlier attempt of the batch can't.
      expect(await claims.locks.acquire('/wt', { ...lock, messageID: 'earlier' })).toBe(false);
      // Once the attempt ended, such as when another session recovered it
      // after its owner was deleted, its late worktree creation can't.
      expect(await claims.records.finish({ ...running, state: 'failed' }, running)).toBe(true);
      expect(await claims.locks.acquire('/wt', lock)).toBe(false);
      expect(await claims.locks.read('/wt')).toBeUndefined();
    } finally {
      claims.close();
    }
  });

  test("frees a lock left by an attempt that can't run anymore, but no other", async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgekeeper-locks-'));
    const claims = createReviewClaims(root);
    try {
      const running: AutomationRecord = { ...queued, state: 'running' };
      await claims.records.save(queued);
      await claims.records.start(running, queued);
      expect(await claims.locks.acquire('/wt', lock)).toBe(true);
      // Its outcome is uncertain, so it keeps its claim, and the directory.
      const uncertain: AutomationRecord = { ...running, state: 'failed' };
      await claims.records.save(uncertain, running);
      const next = {
        ...queued,
        batch: 'next',
        messageID: 'next',
        item: { ...item, url: 'other' },
      };
      const nextLock = { batch: 'next', messageID: 'next', url: 'other', at: 2 };
      await claims.records.save(next);
      await claims.records.start({ ...next, state: 'running' }, next);
      expect(await claims.locks.acquire('/wt', nextLock)).toBe(false);
      // An earlier version could leave the lock after the claim was freed.
      const db = new Database(join(root, 'automation.sqlite'));
      db.query('DELETE FROM claims WHERE target = ?').run('target');
      db.close();
      expect(await claims.locks.acquire('/wt', nextLock)).toBe(true);
      expect(await claims.locks.read('/wt')).toEqual(nextLock);
      // A stale finalizer of the first attempt frees nothing of the next.
      await claims.locks.release(lock);
      expect(await claims.locks.read('/wt')).toEqual(nextLock);
    } finally {
      claims.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('worktree removal reservations', () => {
  const row = {
    key: '/wt',
    directory: '/wt',
    name: 'forgekeeper-project-1',
    url: 'target',
    projectID: 'project',
    state: 'ready' as const,
    at: 1,
  };
  const lock = { batch: 'batch', messageID: 'message', url: 'target', at: 1 };

  test('a reservation and an attempt never hold a worktree at once', async () => {
    const claims = createReviewClaims(':memory:');
    try {
      await claims.records.save(queued);
      await claims.records.start({ ...queued, state: 'running' }, queued);
      await claims.worktrees.save(row);
      expect(await claims.locks.acquire('/wt', lock)).toBe(true);
      // An attempt holds it, so cleanup can't reserve it.
      expect(await claims.worktrees.reserveRemoval(row, 2)).toBeUndefined();
      await claims.locks.release(lock);
      const removing = (await claims.worktrees.reserveRemoval(row, 2))!;
      expect(removing).toEqual({ ...row, state: 'removing', at: 2 });
      // Cleanup reserved it, so no attempt can take it.
      expect(await claims.locks.acquire('/wt', lock)).toBe(false);
      // A removal that didn't happen makes it reusable again.
      expect(await claims.worktrees.cancelRemoval(removing)).toBe(true);
      const ready = { ...removing, state: 'ready' as const };
      expect(await claims.worktrees.list()).toEqual([ready]);
      expect(await claims.locks.acquire('/wt', lock)).toBe(true);
      await claims.locks.release(lock);
      const again = (await claims.worktrees.reserveRemoval(ready, 3))!;
      expect(await claims.worktrees.completeRemoval(again)).toBe(true);
      expect(await claims.worktrees.list()).toEqual([]);
      expect(await claims.locks.read('/wt')).toBeUndefined();
    } finally {
      claims.close();
    }
  });

  test('a stale reservation leaves the lock of the cleanup that took it over', async () => {
    const claims = createReviewClaims(':memory:');
    try {
      await claims.worktrees.save(row);
      const crashed = (await claims.worktrees.reserveRemoval(row, 2))!;
      const takeover = (await claims.worktrees.reserveRemoval(crashed, 3))!;
      expect(await claims.worktrees.cancelRemoval(crashed)).toBe(false);
      expect(await claims.locks.read('/wt')).toEqual({ removal: '/wt', at: 3 });
      expect(await claims.worktrees.completeRemoval(takeover)).toBe(true);
      expect(await claims.locks.read('/wt')).toBeUndefined();
    } finally {
      claims.close();
    }
  });

  test("cleanup takes over the lock of an attempt that can't run anymore", async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgekeeper-reserve-'));
    const claims = createReviewClaims(root);
    try {
      const running: AutomationRecord = { ...queued, state: 'running' };
      await claims.records.save(queued);
      await claims.records.start(running, queued);
      await claims.worktrees.save(row);
      expect(await claims.locks.acquire('/wt', lock)).toBe(true);
      expect(await claims.worktrees.reserveRemoval(row, 2)).toBeUndefined();
      const completed: AutomationRecord = { ...running, state: 'completed' };
      await claims.records.finish(completed, running);
      // An earlier version could leave the attempt's lock after its outcome.
      const db = new Database(join(root, 'automation.sqlite'));
      db.query('INSERT INTO checkout_locks (directory, holder, value) VALUES (?, ?, ?)').run(
        '/wt',
        JSON.stringify([lock.batch, lock.messageID]),
        JSON.stringify(lock),
      );
      db.close();
      expect(await claims.locks.read('/wt')).toEqual(lock);
      expect(await claims.worktrees.reserveRemoval(row, 3)).toEqual({
        ...row,
        state: 'removing',
        at: 3,
      });
      expect(await claims.locks.read('/wt')).toEqual({ removal: '/wt', at: 3 });
    } finally {
      claims.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('worktree creation records', () => {
  const intent = {
    key: 'intent:forgekeeper-project-1-aaaa',
    name: 'forgekeeper-project-1-aaaa',
    url: 'target',
    projectID: 'project',
    state: 'creating' as const,
    at: 1,
    creation: 'aaaa',
  };

  test("a creation never takes over another one's worktree", async () => {
    const claims = createReviewClaims(':memory:');
    try {
      const other = {
        key: '/wt',
        directory: '/wt',
        name: 'forgekeeper-other-7-bbbb',
        url: 'other',
        projectID: 'project',
        state: 'ready' as const,
        at: 1,
        creation: 'bbbb',
      };
      await claims.worktrees.save(other);
      await claims.worktrees.save(intent);
      const mine = { ...intent, key: '/new', directory: '/new', state: 'ready' as const };
      expect(
        await claims.worktrees.replace(intent, [
          { ...intent, key: '/wt', directory: '/wt', state: 'ready' },
          mine,
        ]),
      ).toEqual([mine]);
      expect(await claims.worktrees.read('/wt')).toEqual(other);
      // A replaced intent replaces nothing again.
      expect(await claims.worktrees.replace(intent, [])).toBeUndefined();
    } finally {
      claims.close();
    }
  });
});
