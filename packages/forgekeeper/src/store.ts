import { ForgeError, type ErrorKind, type ReviewRequest } from './forge';
import type { Repository } from './git';

// `explicitTarget` on `none` marks explicit PR/MR targets that couldn't be
// resolved, unlike targets that aren't PRs/MRs, such as issues.
export type Lookup =
  | { kind: 'none'; reason: string; explicitTarget?: boolean }
  // `repository` is set for branch lookups. A session target lookup sets
  // `sessionTarget` instead, a display label for where the PR/MR came from,
  // because it ignores the checked-out branch.
  // `explicitTarget` is set only for PRs/MRs that came from set_session_target.
  // `failed` lists explicit targets whose lookup failed. A target that failed
  // with an error keeps its previous result in `requests`, if it had one.
  | {
      kind: 'found';
      repository?: Repository;
      sessionTarget?: string;
      explicitTarget?: boolean;
      requests: ReviewRequest[];
      failed?: { url: string; reason: string }[];
    };

// Thrown when no explicit PR/MR target could be looked up. The failure
// concerns PRs/MRs that the session is known to work on, unlike a failed
// branch lookup, which may concern no PR/MR at all.
export class TargetLookupError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

// `revision` grows with every change, and across server reloads, so a client
// that gets snapshots over several channels, such as RPC responses and
// events, can keep the newest one.
// `targeted` is set while the key has explicit PR/MR targets, as far as the
// last lookup or target change knows. It outlasts failures that happen before
// the targets are known, such as a failed session read.
export interface Snapshot {
  revision?: number;
  lookup?: Lookup;
  fetchedAt?: number;
  error?: { kind: ErrorKind; message: string; at: number };
  targeted?: boolean;
  loading: boolean;
}

export interface StoreOptions {
  load: (key: string) => Promise<Lookup>;
  // Receives the key whose snapshot changed.
  onChange: (key: string) => void;
  // Called after each successful load with the lookup it replaced.
  onLoad?: (key: string, previous: Lookup | undefined, next: Lookup) => void;
  // Receives errors thrown by `onLoad`, which would otherwise be swallowed.
  onLoadError?: (error: unknown) => void;
  // Lookups that match poll at `activeInterval` instead of `interval`.
  active?: (lookup: Lookup | undefined) => boolean;
  activeInterval?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  interval?: number;
  maxBackoff?: number;
  // Event-driven refreshes within this window after a fetch are skipped.
  minEventInterval?: number;
}

interface Entry {
  snapshot: Snapshot;
  refs: number;
  failures: number;
  inflight?: Promise<Snapshot>;
  // The running load started before a change, so its result is discarded.
  invalidated?: boolean;
  // A change happened while nothing polled, so the next acquire loads at once.
  stale?: boolean;
  timer?: unknown;
}

// Explicit PR/MR targets that none of could be resolved, such as while the
// forge returns nothing for them.
export const unresolved = (lookup: Lookup | undefined) =>
  lookup?.kind === 'none' && lookup.explicitTarget === true;

export function createStatusStore(options: StoreOptions) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const interval = options.interval ?? 120_000;
  const maxBackoff = options.maxBackoff ?? 900_000;
  const minEventInterval = options.minEventInterval ?? 15_000;
  const entries = new Map<string, Entry>();
  let disposed = false;
  // Starts at the store's creation time in microseconds, so a store created
  // later, such as after a reload, starts above every revision of this one.
  let revision = now() * 1000;

  const entry = (key: string) => {
    let value = entries.get(key);
    if (!value) {
      value = { snapshot: { loading: false }, refs: 0, failures: 0 };
      entries.set(key, value);
    }
    return value;
  };

  const update = (key: string, value: Entry, patch: Partial<Snapshot>) => {
    value.snapshot = { ...value.snapshot, ...patch, revision: ++revision };
    if (!disposed) options.onChange(key);
  };

  const cancelTimer = (value: Entry) => {
    if (value.timer === undefined) return;
    clearTimer(value.timer);
    value.timer = undefined;
  };

  const baseInterval = (value: Entry) =>
    options.active?.(value.snapshot.lookup) ? (options.activeInterval ?? interval) : interval;
  const pollDelay = (value: Entry) =>
    Math.min(baseInterval(value) * 2 ** value.failures, maxBackoff);

  // The last load, successful or not, so failed lookups also wait out their backoff.
  const lastAttempt = (value: Entry) =>
    Math.max(value.snapshot.fetchedAt ?? -Infinity, value.snapshot.error?.at ?? -Infinity);

  const schedule = (key: string, value: Entry, delay = pollDelay(value)) => {
    cancelTimer(value);
    if (disposed || value.refs === 0) return;
    const lookup = value.snapshot.lookup;
    // Without a PR/MR there is nothing to watch; turn ends, branch changes, and
    // the command still look again. Explicit targets that couldn't be resolved
    // are retried, with backoff, since they may become available.
    if (
      !value.snapshot.error &&
      !unresolved(lookup) &&
      (lookup?.kind !== 'found' || lookup.requests.length === 0)
    )
      return;
    value.timer = setTimer(() => {
      value.timer = undefined;
      void refresh(key);
    }, delay);
  };

  function refresh(key: string): Promise<Snapshot> {
    if (disposed) return Promise.resolve({ loading: false });
    const value = entry(key);
    if (value.inflight) return value.inflight;
    value.stale = false;
    update(key, value, { loading: true });
    value.inflight = options
      .load(key)
      .then(
        (lookup) => {
          // A load that started before a change, such as new session targets,
          // describes the old state. It must not reach the watchers.
          if (disposed || value.invalidated) return;
          const previous = value.snapshot.lookup;
          // An unresolved explicit target backs off like a failure.
          value.failures = unresolved(lookup) ? value.failures + 1 : 0;
          update(key, value, {
            lookup,
            fetchedAt: now(),
            error: undefined,
            targeted: lookup.explicitTarget === true ? true : undefined,
            loading: false,
          });
          // A failing callback must not leave the load in flight forever.
          try {
            if (!disposed) options.onLoad?.(key, previous, lookup);
          } catch (error) {
            try {
              options.onLoadError?.(error);
            } catch {
              // A failing error handler must not stop polling.
            }
          }
        },
        (error: unknown) => {
          if (disposed || value.invalidated) return;
          value.failures++;
          const target = error instanceof TargetLookupError;
          const cause = target ? error.cause : error;
          update(key, value, {
            loading: false,
            error: {
              kind: cause instanceof ForgeError ? cause.kind : 'request',
              message: cause instanceof Error ? cause.message : String(cause),
              at: now(),
            },
            ...(target ? { targeted: true } : {}),
          });
        },
      )
      .then(() => {
        value.inflight = undefined;
        if (value.invalidated && !disposed) {
          value.invalidated = false;
          return refresh(key);
        }
        schedule(key, value);
        return value.snapshot;
      });
    return value.inflight;
  }

  return {
    get(key: string): Snapshot {
      return entries.get(key)?.snapshot ?? { loading: false };
    },
    acquire(key: string): () => void {
      const value = entry(key);
      value.refs++;
      // Showing a session again, such as on a tab switch, reuses cached data
      // until the next poll would have been due, and resumes that poll schedule.
      if (value.refs === 1 && !value.inflight) {
        const remaining = lastAttempt(value) + pollDelay(value) - now();
        if (value.stale || remaining <= 0) void refresh(key);
        else schedule(key, value, remaining);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        value.refs--;
        if (value.refs === 0) cancelTimer(value);
      };
    },
    refresh,
    keys(): string[] {
      return [...entries.keys()];
    },
    // Refreshes a key that something polls, unless it was fetched moments ago.
    notify(key: string) {
      const value = entries.get(key);
      if (!value || value.refs === 0 || value.inflight) return;
      const last = Math.max(value.snapshot.fetchedAt ?? 0, value.snapshot.error?.at ?? 0);
      if (now() - last < minEventInterval) return;
      void refresh(key);
    },
    // Forces a refresh after a known state change, such as a branch switch or
    // new session targets. A load that started before the change is discarded,
    // even when nothing polls the key anymore.
    invalidate(key: string) {
      const value = entries.get(key);
      if (!value) return;
      if (value.inflight) value.invalidated = true;
      else if (value.refs > 0) void refresh(key);
      else value.stale = true;
    },
    // Records whether the key has explicit PR/MR targets, such as after a
    // target change, before the next lookup confirms it.
    setTargeted(key: string, targeted: boolean) {
      const value = entries.get(key);
      if (!value || disposed || (value.snapshot.targeted === true) === targeted) return;
      update(key, value, { targeted: targeted ? true : undefined });
    },
    dispose() {
      disposed = true;
      for (const value of entries.values()) cancelTimer(value);
      entries.clear();
    },
  };
}

export type StatusStore = ReturnType<typeof createStatusStore>;
