import type { Exec } from './exec';

// How many forge requests run at once.
export const CONCURRENCY = 4;

// Maps `items` with at most `limit` calls of `fn` running at once, keeping
// the order of `items` in the results.
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Runs at most `limit` tasks at once, in the order they were queued.
export function createLimiter(limit: number) {
  let running = 0;
  const queue: Array<() => void> = [];
  // A finished task hands its slot to the next queued one, so a task that
  // arrives during the handoff can't take the slot too.
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else running--;
  };
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    else running++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

// An `exec` that shares the limiter, so every status lookup and feedback
// fetch, across all sessions, runs at most `limit` forge commands at once.
// Once `signal` aborts, such as when the plugin stops, queued and new
// commands fail without running.
export function limitExec(run: Exec, limit = CONCURRENCY, signal?: AbortSignal): Exec {
  const limited = createLimiter(limit);
  const cancelled = { stdout: '', stderr: 'The plugin stopped', code: -1 };
  return (file, args, cwd) =>
    limited(async () => (signal?.aborted ? cancelled : run(file, args, cwd)));
}
