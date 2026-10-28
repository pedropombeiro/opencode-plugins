interface Entry<T> {
  promise: Promise<T>;
  expires: number;
}

export function createRequestCache<T>(options: {
  ttl: (value: T) => number;
  now?: () => number;
  capacity?: number;
}) {
  const entries = new Map<string, Entry<T>>();
  const now = options.now ?? Date.now;
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const cached = entries.get(key);
      if (cached && cached.expires > now()) return cached.promise;
      entries.delete(key);
      const entry: Entry<T> = {
        expires: Infinity,
        promise: Promise.resolve()
          .then(load)
          .then(
            (value) => {
              entry.expires = now() + options.ttl(value);
              return value;
            },
            (error: unknown) => {
              if (entries.get(key) === entry) entries.delete(key);
              throw error;
            },
          ),
      };
      entries.set(key, entry);
      if (entries.size > (options.capacity ?? 1000)) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      return entry.promise;
    },
    invalidate: (key: string) => {
      entries.delete(key);
    },
    clear: () => entries.clear(),
  };
}
