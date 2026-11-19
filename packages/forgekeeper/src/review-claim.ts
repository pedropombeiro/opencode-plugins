import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AutomationRecord } from './review-automation';

export interface ExecutionClaim {
  sessionID: string;
  messageID: string;
  batch: string;
}

// The attempt that runs in a checkout directory, so no two attempts, even of
// different PRs/MRs, use one worktree at once.
export interface CheckoutLock {
  batch: string;
  messageID: string;
  url: string;
  at: number;
}

// What holds a checkout directory: an attempt, or cleanup removing it.
export type CheckoutHolder = CheckoutLock | { removal: string; at: number };

interface WorktreeFields {
  name: string;
  url: string;
  projectID: string;
  at: number;
  // The random part of the requested name, unique to one creation, so what
  // a creation left is never confused with another worktree.
  creation?: string;
}

// The intent to create a worktree, recorded before OpenCode creates it, so a
// crash can't leave an unknown worktree. Its key is `intent:` and the
// requested name, which holds its `creation`.
export interface WorktreeIntent extends WorktreeFields {
  key: string;
  directory?: never;
  state: 'creating';
}

// A worktree Forgekeeper created, keyed by its directory, while it's in use
// or reusable (`ready`), or while cleanup removes it (`removing`).
export interface RecordedWorktree extends WorktreeFields {
  key: string;
  directory: string;
  state: 'ready' | 'removing';
}

// Only worktrees recorded here are ever removed.
export type CreatedWorktree = WorktreeIntent | RecordedWorktree;

export function createReviewClaims(
  root = join(
    process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
    'opencode',
    'forgekeeper',
    'review-claims',
  ),
) {
  let database: Database | undefined;
  let closed = false;
  const db = () => {
    if (closed) throw new Error('Review automation storage is closed');
    if (database) return database;
    if (root !== ':memory:') mkdirSync(root, { recursive: true, mode: 0o700 });
    database = new Database(root === ':memory:' ? root : join(root, 'automation.sqlite'));
    database.run('PRAGMA busy_timeout = 1000');
    database.run(
      'CREATE TABLE IF NOT EXISTS claims (target TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    database.run(
      'CREATE TABLE IF NOT EXISTS attempts (batch TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    database.run(
      'CREATE TABLE IF NOT EXISTS checkout_locks (directory TEXT PRIMARY KEY, holder TEXT NOT NULL, value TEXT NOT NULL)',
    );
    database.run(
      'CREATE TABLE IF NOT EXISTS worktrees (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    database
      .transaction(() => {
        for (const row of database!
          .query<{ batch: string; value: string }, []>('SELECT batch, value FROM attempts')
          .all()) {
          const record = JSON.parse(row.value);
          let changed = false;
          if (record.checkout !== undefined) {
            record.placement = record.checkout === 'worktree' ? 'environment' : 'session';
            delete record.checkout;
            changed = true;
          }
          if (record.execution && !record.execution.provider) {
            const { directory, sessionID, remote, detached, ...source } = record.execution;
            record.execution = {
              ...source,
              provider: 'local-worktree',
              version: 1,
              state: { directory, sessionID, remote, detached },
            };
            changed = true;
          }
          if (changed)
            database!
              .query('UPDATE attempts SET value = ? WHERE batch = ? AND value = ?')
              .run(JSON.stringify(record), row.batch, row.value);
        }
      })
      .immediate();
    return database;
  };
  const holderOf = (holder: { batch: string; messageID?: string }) =>
    JSON.stringify([holder.batch, holder.messageID ?? null]);
  // Frees the checkouts an attempt holds, with its PR/MR claim.
  const releaseLocks = (holder: { batch: string; messageID?: string }) =>
    db().query('DELETE FROM checkout_locks WHERE holder = ?').run(holderOf(holder));
  // The lock holder of a removal, the same for every cleanup of a directory.
  const removalHolder = (directory: string) => JSON.stringify(['removal', directory]);
  const readWorktree = (key: string): CreatedWorktree | undefined => {
    const row = db()
      .query<{ value: string }, [string]>('SELECT value FROM worktrees WHERE key = ?')
      .get(key);
    return row ? JSON.parse(row.value) : undefined;
  };
  // Applies `write` to a reserved worktree's record and, if the reservation
  // was still stored, frees its removal lock, in one transaction. A stale
  // reservation's lock belongs to the cleanup that took it over.
  const endRemoval = (removing: RecordedWorktree, write: () => { changes: number }) =>
    db()
      .transaction(() => {
        if (write().changes !== 1) return false;
        db()
          .query('DELETE FROM checkout_locks WHERE directory = ? AND holder = ?')
          .run(removing.directory, removalHolder(removing.directory));
        return true;
      })
      .immediate();
  const readRecord = (batch: string): AutomationRecord | undefined => {
    const row = db()
      .query<{ value: string }, [string]>('SELECT value FROM attempts WHERE batch = ?')
      .get(batch);
    return row ? JSON.parse(row.value) : undefined;
  };
  const compareAndSet = (record: AutomationRecord, expected?: AutomationRecord) => {
    const value = JSON.stringify(record);
    const result = expected
      ? db()
          .query('UPDATE attempts SET value = ? WHERE batch = ? AND value = ?')
          .run(value, record.batch, JSON.stringify(expected))
      : db()
          .query('INSERT OR IGNORE INTO attempts (batch, value) VALUES (?, ?)')
          .run(record.batch, value);
    return result.changes === 1;
  };
  const acquire = (target: string, claim: ExecutionClaim) =>
    db()
      .query('INSERT OR IGNORE INTO claims (target, value) VALUES (?, ?)')
      .run(target, JSON.stringify(claim)).changes === 1;
  const release = (target: string, claim: ExecutionClaim) => {
    const result = db()
      .query('DELETE FROM claims WHERE target = ? AND value = ?')
      .run(target, JSON.stringify(claim));
    if (result.changes === 1) releaseLocks(claim);
  };
  const claimOf = (record: AutomationRecord): ExecutionClaim => ({
    sessionID: record.item.sessionID,
    messageID: record.messageID!,
    batch: record.batch,
  });
  // Whether the attempt still holds its PR/MR's execution claim.
  const holdsClaim = (lock: CheckoutLock) => {
    const row = db()
      .query<{ value: string }, [string]>('SELECT value FROM claims WHERE target = ?')
      .get(lock.url);
    const claim: ExecutionClaim | undefined = row ? JSON.parse(row.value) : undefined;
    return claim?.batch === lock.batch && claim.messageID === lock.messageID;
  };
  // Whether the attempt is its batch's current one and may still run.
  const isLive = (lock: CheckoutLock) => {
    const record = readRecord(lock.batch);
    return (
      record?.messageID === lock.messageID &&
      (record.state === 'queued' || record.state === 'running')
    );
  };
  // Whether a stored lock's attempt can't run anymore: it isn't its batch's
  // queued or running attempt, and it no longer holds the PR/MR's claim, as
  // an attempt whose outcome is uncertain does.
  const staleLock = (value: string) => {
    const holder = JSON.parse(value) as CheckoutHolder;
    return !('removal' in holder) && !isLive(holder) && !holdsClaim(holder);
  };
  const lockOf = (directory: string) =>
    db()
      .query<{ holder: string; value: string }, [string]>(
        'SELECT holder, value FROM checkout_locks WHERE directory = ?',
      )
      .get(directory);
  // Frees the directory's lock when its attempt can't run anymore, such as
  // one whose worktree creation ended after the attempt did. Returns the lock
  // that still holds it.
  const reclaim = (directory: string) => {
    const current = lockOf(directory);
    if (!current || !staleLock(current.value)) return current;
    db()
      .query('DELETE FROM checkout_locks WHERE directory = ? AND holder = ?')
      .run(directory, current.holder);
    return undefined;
  };

  return {
    async acquire(target: string, claim: ExecutionClaim) {
      return acquire(target, claim);
    },
    async read(target: string): Promise<ExecutionClaim | undefined> {
      const row = db()
        .query<{ value: string }, [string]>('SELECT value FROM claims WHERE target = ?')
        .get(target);
      return row ? JSON.parse(row.value) : undefined;
    },
    async release(target: string, claim: ExecutionClaim) {
      db()
        .transaction(() => release(target, claim))
        .immediate();
    },
    locks: {
      // Takes the directory for the attempt, while it's its batch's running
      // attempt and holds the PR/MR's claim, unless another attempt that may
      // still run holds the directory, or cleanup is removing it.
      async acquire(directory: string, lock: CheckoutLock): Promise<boolean> {
        return db()
          .transaction(() => {
            const record = readRecord(lock.batch);
            if (
              record?.messageID !== lock.messageID ||
              record.state !== 'running' ||
              !holdsClaim(lock)
            )
              return false;
            if (readWorktree(directory)?.state === 'removing') return false;
            const current = reclaim(directory);
            if (current) return current.holder === holderOf(lock);
            return (
              db()
                .query(
                  'INSERT OR IGNORE INTO checkout_locks (directory, holder, value) VALUES (?, ?, ?)',
                )
                .run(directory, holderOf(lock), JSON.stringify(lock)).changes === 1
            );
          })
          .immediate();
      },
      async read(directory: string): Promise<CheckoutHolder | undefined> {
        const row = db()
          .query<{ value: string }, [string]>(
            'SELECT value FROM checkout_locks WHERE directory = ?',
          )
          .get(directory);
        return row ? JSON.parse(row.value) : undefined;
      },
      async release(holder: { batch: string; messageID?: string }) {
        releaseLocks(holder);
      },
    },
    worktrees: {
      async list(): Promise<CreatedWorktree[]> {
        return db()
          .query<{ value: string }, []>('SELECT value FROM worktrees')
          .all()
          .map((row) => JSON.parse(row.value));
      },
      // Stores the record if the stored one is still `expected`, or, without
      // it, if there is none.
      async save(record: CreatedWorktree, expected?: CreatedWorktree): Promise<boolean> {
        const value = JSON.stringify(record);
        const result = expected
          ? db()
              .query('UPDATE worktrees SET value = ? WHERE key = ? AND value = ?')
              .run(value, record.key, JSON.stringify(expected))
          : db()
              .query('INSERT OR IGNORE INTO worktrees (key, value) VALUES (?, ?)')
              .run(record.key, value);
        return result.changes === 1;
      },
      async read(key: string): Promise<CreatedWorktree | undefined> {
        return readWorktree(key);
      },
      // Replaces a creation intent with what OpenCode created. A directory
      // already recorded keeps its record, so a creation never takes over
      // another one's worktree. Returns the records stored, or undefined
      // when the intent was no longer stored.
      async replace(
        intent: WorktreeIntent,
        records: RecordedWorktree[],
      ): Promise<RecordedWorktree[] | undefined> {
        return db()
          .transaction(() => {
            const removed = db()
              .query('DELETE FROM worktrees WHERE key = ? AND value = ?')
              .run(intent.key, JSON.stringify(intent));
            if (removed.changes !== 1) return undefined;
            return records.filter(
              (record) =>
                db()
                  .query('INSERT OR IGNORE INTO worktrees (key, value) VALUES (?, ?)')
                  .run(record.key, JSON.stringify(record)).changes === 1,
            );
          })
          .immediate();
      },
      async remove(record: CreatedWorktree): Promise<boolean> {
        return (
          db()
            .query('DELETE FROM worktrees WHERE key = ? AND value = ?')
            .run(record.key, JSON.stringify(record)).changes === 1
        );
      },
      // Reserves the worktree for removal: marks it `removing` at `at` and
      // takes its checkout lock, in one write, if the stored record is still
      // `expected` and no attempt that may still run holds the lock. A
      // removal left by a crash holds the lock under the same holder, so a
      // later cleanup can take it over. Returns the reservation, or
      // undefined when it wasn't made.
      async reserveRemoval(
        expected: RecordedWorktree,
        at: number,
      ): Promise<RecordedWorktree | undefined> {
        const { directory } = expected;
        const holder = removalHolder(directory);
        const removing: RecordedWorktree = { ...expected, state: 'removing', at };
        return db()
          .transaction(() => {
            if (JSON.stringify(readWorktree(expected.key)) !== JSON.stringify(expected))
              return undefined;
            const lock = reclaim(directory);
            if (lock && lock.holder !== holder) return undefined;
            db()
              .query('UPDATE worktrees SET value = ? WHERE key = ?')
              .run(JSON.stringify(removing), expected.key);
            db()
              .query(
                'INSERT OR REPLACE INTO checkout_locks (directory, holder, value) VALUES (?, ?, ?)',
              )
              .run(directory, holder, JSON.stringify({ removal: directory, at }));
            return removing;
          })
          .immediate();
      },
      // Makes a reserved worktree reusable again, and frees its lock.
      // Returns false when the reservation was no longer stored, such as
      // when another cleanup took it over.
      async cancelRemoval(removing: RecordedWorktree): Promise<boolean> {
        return endRemoval(removing, () =>
          db()
            .query('UPDATE worktrees SET value = ? WHERE key = ? AND value = ?')
            .run(
              JSON.stringify({ ...removing, state: 'ready' }),
              removing.key,
              JSON.stringify(removing),
            ),
        );
      },
      // Forgets a removed worktree, and frees its lock. Returns false when
      // the reservation was no longer stored.
      async completeRemoval(removing: RecordedWorktree): Promise<boolean> {
        return endRemoval(removing, () =>
          db()
            .query('DELETE FROM worktrees WHERE key = ? AND value = ?')
            .run(removing.key, JSON.stringify(removing)),
        );
      },
    },
    records: {
      async read(batch: string) {
        return readRecord(batch);
      },
      async save(record: AutomationRecord, expected?: AutomationRecord) {
        return compareAndSet(record, expected);
      },
      async list(): Promise<AutomationRecord[]> {
        return db()
          .query<{ value: string }, []>('SELECT value FROM attempts')
          .all()
          .map((row) => JSON.parse(row.value));
      },
      async start(record: AutomationRecord, expected: AutomationRecord): Promise<boolean> {
        return db()
          .transaction(() => {
            const current = readRecord(record.batch);
            if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
            if (!acquire(record.item.url, claimOf(record))) return false;
            if (!compareAndSet(record, expected))
              throw new Error('Review attempt changed during admission');
            return true;
          })
          .immediate();
      },
      // Records a definitive outcome and frees the attempt's PR/MR claim in
      // one transaction, so a crash can't leave finished work holding it.
      async finish(record: AutomationRecord, expected: AutomationRecord): Promise<boolean> {
        return db()
          .transaction(() => {
            if (!compareAndSet(record, expected)) return false;
            release(record.item.url, claimOf(record));
            releaseLocks(record);
            return true;
          })
          .immediate();
      },
    },
    close() {
      database?.close();
      database = undefined;
      closed = true;
    },
  };
}
