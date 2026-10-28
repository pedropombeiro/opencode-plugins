interface Entry<T> {
  promise: Promise<T>;
  expires: number;
}

export interface FetchHealth {
  loading: boolean;
  // The last fetch whose result monitoring could use.
  fetchedAt?: number;
  // The last fetch that finished, usable or not.
  attemptedAt?: number;
  result?: FetchResult;
  error?: { message: string; at: number };
}

// `incomplete` results, such as a partial comment page, and `unavailable`
// ones, such as a PR/MR that wasn't found, can't establish a baseline.
export type FetchResult = 'usable' | 'incomplete' | 'unavailable';

export function createRequestCache<T>(options: {
  ttl: (value: T) => number;
  now?: () => number;
  capacity?: number;
  classify?: (value: T) => FetchResult;
}) {
  const entries = new Map<string, Entry<T>>();
  const health = new Map<string, FetchHealth>();
  const now = options.now ?? Date.now;
  const capacity = options.capacity ?? 1000;
  const record = (key: string, value: FetchHealth) => {
    health.delete(key);
    health.set(key, value);
    if (health.size > capacity) health.delete(health.keys().next().value!);
  };
  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const cached = entries.get(key);
      if (cached && cached.expires > now()) return cached.promise;
      entries.delete(key);
      record(key, { ...health.get(key), loading: true });
      const entry: Entry<T> = {
        expires: Infinity,
        promise: Promise.resolve()
          .then(load)
          .then(
            (value) => {
              entry.expires = now() + options.ttl(value);
              if (entries.get(key) === entry) {
                const result = options.classify?.(value) ?? 'usable';
                const previous = health.get(key)?.fetchedAt;
                const fetchedAt = result === 'usable' ? now() : previous;
                record(key, {
                  loading: false,
                  attemptedAt: now(),
                  result,
                  ...(fetchedAt !== undefined ? { fetchedAt } : {}),
                });
              }
              return value;
            },
            (error: unknown) => {
              if (entries.get(key) === entry) {
                entries.delete(key);
                record(key, {
                  ...health.get(key),
                  loading: false,
                  attemptedAt: now(),
                  error: {
                    message: error instanceof Error ? error.message : String(error),
                    at: now(),
                  },
                });
              }
              throw error;
            },
          ),
      };
      entries.set(key, entry);
      if (entries.size > capacity) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      return entry.promise;
    },
    invalidate: (key: string) => {
      entries.delete(key);
      const previous = health.get(key);
      if (previous) record(key, { ...previous, loading: false });
    },
    inspect: (key: string): FetchHealth => structuredClone(health.get(key) ?? { loading: false }),
    clear: () => {
      entries.clear();
      for (const [key, value] of health) health.set(key, { ...value, loading: false });
    },
  };
}
