export function createKeyedQueue() {
  const pending = new Map<string, Promise<void>>();
  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const next = (pending.get(key) ?? Promise.resolve()).then(task);
      const settled = next.then(
        () => {},
        () => {},
      );
      pending.set(key, settled);
      void settled.then(() => {
        if (pending.get(key) === settled) pending.delete(key);
      });
      return next;
    },
    tasks: () => [...pending.values()],
  };
}
