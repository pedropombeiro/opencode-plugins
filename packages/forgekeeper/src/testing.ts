// Helpers for tests that need to control when asynchronous work finishes.

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

// A promise that the test settles itself, which holds work in flight until
// the test has seen what it needs to check.
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// Lets every promise reaction that is already queued run, including those
// that the reactions queue in turn. It waits for no time, and for nothing
// that needs a timer or I/O, so it makes tests deterministic only for work
// built from promises. Prefer `until` when the test knows what to wait for.
export const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// Waits until the condition holds. Gives up after a number of turns instead of
// an amount of time, so a slow machine can't fail it, and a condition that
// never comes true fails fast with a clear error.
export async function until(condition: () => boolean, turns = 1_000): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    if (condition()) return;
    await flush();
  }
  throw new Error(`Condition not met after ${turns} turns: ${condition}`);
}
