import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewClaims } from './review-claim';
import type { AutomationRecord } from './review-automation';
import { Database } from 'bun:sqlite';

describe('atomic review execution claims', () => {
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

describe('checkout locks', () => {
  const item = { id: 'item', sessionID: 'one', url: 'target', title: 'Review', links: [], at: 1 };
  const queued: AutomationRecord = {
    batch: 'batch',
    messageID: 'message',
    state: 'queued',
    attempt: 1,
    at: 1,
    item,
  };
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
      expect(await claims.acquire('target', claim)).toBe(true);
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
});
