import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { createFeedbackDiscovery, RECENT_ACTIVITY } from '../src/feedback-discovery';
import { classifyTargets, targetOutput, type Target } from '../src/target';

const now = 10 * RECENT_ACTIVITY;
const targets = JSON.stringify([{ url: 'https://gitlab.com/example/app/-/merge_requests/1' }]);
const messages = (at: number) =>
  JSON.stringify(
    Array.from({ length: 100 }, (_, i) => ({
      type: i % 2 ? 'assistant' : 'user',
      time: { created: at - 100 + i },
      text: 'x'.repeat(256),
    })),
  );
const recent = messages(now);
const old = messages(now - RECENT_ACTIVITY * 2);

async function benchmark(size: number) {
  const db = new Database(':memory:');
  try {
    db.run('CREATE TABLE sessions (id INTEGER PRIMARY KEY, targets TEXT, directory TEXT)');
    db.run('CREATE TABLE contexts (id INTEGER PRIMARY KEY, messages TEXT)');
    const insert = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
    const insertContext = db.prepare('INSERT INTO contexts VALUES (?, ?)');
    db.transaction(() => {
      for (let i = 0; i < size; i++) {
        insert.run(i, i % 2 ? '[]' : targets, i % 4 ? '/other' : '/repo');
        if (i % 4 === 0) insertContext.run(i, i < 40 ? recent : old);
      }
    })();
    const scan = db.prepare<{ id: number; targets: string }, []>(
      'SELECT id, targets FROM sessions',
    );
    const getSession = db.prepare<{ directory: string }, [string]>(
      'SELECT directory FROM sessions WHERE id = ?',
    );
    const getContext = db.prepare<{ messages: string }, [string]>(
      'SELECT messages FROM contexts WHERE id = ?',
    );
    let sessionReads = 0;
    let contextReads = 0;
    const discovery = createFeedbackDiscovery({
      directory: '/repo',
      now: () => now,
      paused: async () => false,
      candidates: async () =>
        scan
          .all()
          .flatMap((row) =>
            classifyTargets(targetOutput(JSON.parse(row.targets) as Target[]))?.some(
              (t) => t.kind === 'merge-request',
            )
              ? [String(row.id)]
              : [],
          ),
      candidate: async () => {
        throw new Error('Expected full discovery');
      },
      session: async (id) => {
        sessionReads++;
        return { time: {}, location: getSession.get(id)! };
      },
      activity: async (id) => {
        contextReads++;
        const context: { type: string; time: { created: number } }[] = JSON.parse(
          getContext.get(id)!.messages,
        );
        return context.reduce(
          (latest, m) => (m.type === 'user' ? Math.max(latest, m.time.created) : latest),
          0,
        );
      },
      watch: (ids) =>
        assert.deepEqual(
          ids.map(Number).sort((a, b) => a - b),
          Array.from({ length: 10 }, (_, i) => i * 4),
        ),
      error: (error) => {
        throw error;
      },
    });
    const start = performance.now();
    await discovery.refresh();
    const coldMs = performance.now() - start;
    const coldReads = contextReads;
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      sessionReads = contextReads = 0;
      const start = performance.now();
      await discovery.refresh();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    process.stdout.write(
      `${size}\t${coldReads}\t${coldMs.toFixed(1)}\t${sessionReads}\t${contextReads}\t${times[3].toFixed(3)}\n`,
    );
    discovery.stop();
  } finally {
    db.close();
  }
}

process.stdout.write('records\tcoldContexts\tcoldMs\twarmSessions\twarmContexts\twarmMedianMs\n');
for (const size of [100, 1000, 10000]) await benchmark(size);
