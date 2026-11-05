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
    return database;
  };
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
  const release = (target: string, claim: ExecutionClaim) =>
    db()
      .query('DELETE FROM claims WHERE target = ? AND value = ?')
      .run(target, JSON.stringify(claim));
  const claimOf = (record: AutomationRecord): ExecutionClaim => ({
    sessionID: record.item.sessionID,
    messageID: record.messageID!,
    batch: record.batch,
  });

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
      release(target, claim);
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
