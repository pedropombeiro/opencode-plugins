import {
  automatedReview,
  isReviewRunning,
  type AutomatedReviewWatcher,
} from './automated-review-watch';
import type { ReviewRequest } from './forge';
import { traitsOf } from './forges';
import { HOME, LEASE_TIME } from './rpc';
import { createStatusStore, type Lookup, type Snapshot } from './store';

// A status key is a session ID, or HOME for the checkout outside a session.
// Keys don't depend on the title or the targets, so a hidden session keeps
// its subscription when either changes.
export { HOME };

export interface StatusServiceOptions {
  // Looks up a key's PRs/MRs. `previous` stands in for targets whose lookup fails.
  load: (key: string, previous: Lookup | undefined) => Promise<Lookup>;
  // Whether the PR/MR is one of the session's targets right now, from the
  // server's own state rather than a lookup that may predate a change.
  isTarget: (sessionID: string, url: string) => boolean;
  // Whether this instance watches the session's reviews. A session that moved
  // to another checkout belongs to that checkout's instance, even while a CLI
  // still leases it here.
  owns?: (sessionID: string) => boolean;
  publish: (key: string, snapshot: Snapshot) => void;
  automated?: Pick<AutomatedReviewWatcher, 'observe' | 'hasPending'>;
  human?: { check: (sessionID: string, request: ReviewRequest) => unknown };
  // Sessions that poll even without a CLI lease, such as while babysitting.
  pinned?: (sessionID: string) => boolean;
  // Receives each lookup of a pinned session's explicit targets.
  babysit?: { observe: (sessionID: string, lookup: Lookup) => Promise<unknown> };
  onWatchError?: (error: unknown) => void;
  interval?: number;
  activeInterval?: number;
  leaseTime?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

interface Lease {
  until: number;
  visible: boolean;
}

// Polls the PRs/MRs of the keys that CLIs lease, and watches each session's
// targets for reviews. A key polls while a CLI shows it, and while a session
// that a CLI has shown has a running automated review, human feedback to
// watch, or a notification to retry.
export function createStatusService(options: StatusServiceOptions) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const leaseTime = options.leaseTime ?? LEASE_TIME;
  const leases = new Map<string, Map<string, Lease>>();
  const holds = new Map<string, () => void>();
  // Watcher work in progress, which `dispose` waits for.
  const tasks = new Set<Promise<unknown>>();
  const track = (task: Promise<unknown>) => {
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  };
  const owns = (key: string) => key !== HOME && (options.owns?.(key) ?? true);
  const pinned = (key: string) => owns(key) && (options.pinned?.(key) ?? false);
  let sweepTimer: unknown;
  let disposed = false;

  const report = (error: unknown) => {
    try {
      options.onWatchError?.(error);
    } catch {
      // A failing error handler must not stop the watchers.
    }
  };

  const store = createStatusStore({
    load: (key) => options.load(key, store.get(key).lookup),
    onChange: (key) => options.publish(key, store.get(key)),
    onLoad: (key, previous, next) => onLoad(key, previous, next),
    onLoadError: report,
    active: isReviewRunning,
    interval: options.interval,
    activeInterval: options.activeInterval,
    now,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
  });

  // The session's current targets among a lookup's PRs/MRs.
  const targets = (key: string, lookup: Lookup | undefined): ReviewRequest[] =>
    owns(key) && lookup?.kind === 'found' && lookup.explicitTarget
      ? lookup.requests.filter((request) => options.isTarget(key, request.url))
      : [];

  const watchedForFeedback = (key: string, lookup: Lookup | undefined) =>
    options.human
      ? targets(key, lookup).filter(
          (request) => traitsOf(request).feedback && request.state === 'opened',
        )
      : [];

  // Whether a session needs polling even when no CLI shows it.
  function needsWatch(key: string): boolean {
    const lookup = store.get(key).lookup;
    if (options.automated) {
      if (targets(key, lookup).some((request) => automatedReview(request)?.state === 'running'))
        return true;
      if (owns(key) && options.automated.hasPending(key)) return true;
    }
    return watchedForFeedback(key, lookup).length > 0;
  }

  // A session without a lookup yet, such as after a restart, may have reviews
  // to watch. Only a lookup can tell, so it polls until one succeeds.
  const unknown = (key: string) => owns(key) && store.get(key).lookup === undefined;

  const liveLeases = (key: string) =>
    [...(leases.get(key)?.values() ?? [])].filter((lease) => lease.until > now());

  // Polls the key while it's wanted, and stops otherwise.
  function sync(key: string) {
    if (disposed) return;
    const live = liveLeases(key);
    const wanted =
      pinned(key) ||
      (live.length > 0 && (live.some((lease) => lease.visible) || unknown(key) || needsWatch(key)));
    const release = holds.get(key);
    if (wanted && !release) holds.set(key, store.acquire(key));
    else if (!wanted && release) {
      release();
      holds.delete(key);
    }
  }

  function onLoad(key: string, previous: Lookup | undefined, next: Lookup) {
    if (owns(key) && options.automated) {
      track(
        options.automated
          .observe(key, previous, next)
          .catch(report)
          .finally(() => sync(key)),
      );
    }
    if (pinned(key) && options.babysit && next.kind === 'found' && next.explicitTarget) {
      track(
        options.babysit
          .observe(key, next)
          .catch(report)
          .finally(() => sync(key)),
      );
    }
    for (const request of watchedForFeedback(key, next)) {
      track(
        Promise.resolve()
          .then(() => options.human?.check(key, request))
          .catch(report),
      );
    }
    sync(key);
  }

  function sweep() {
    const at = now();
    for (const key of new Set([...leases.keys(), ...holds.keys()])) {
      const clients = leases.get(key);
      for (const [clientID, lease] of clients ?? [])
        if (lease.until <= at) clients?.delete(clientID);
      if (clients?.size === 0) leases.delete(key);
      sync(key);
    }
  }

  function scheduleSweep() {
    if (disposed || sweepTimer !== undefined || leases.size === 0) return;
    sweepTimer = setTimer(() => {
      sweepTimer = undefined;
      sweep();
      scheduleSweep();
    }, leaseTime / 3);
  }

  function forget(clientID: string, keep: ReadonlySet<string> = new Set()) {
    const changed: string[] = [];
    for (const [key, clients] of leases) {
      if (keep.has(key) || !clients.delete(clientID)) continue;
      if (clients.size === 0) leases.delete(key);
      changed.push(key);
    }
    return changed;
  }

  return {
    // Renews a CLI's leases: `keys` are the keys it has shown, and `visible`
    // is the one on screen. Keys the CLI no longer lists lose its lease.
    watch(clientID: string, keys: readonly string[], visible?: string): Record<string, Snapshot> {
      const listed = new Set(keys);
      const changed = new Set([...forget(clientID, listed), ...listed]);
      const until = now() + leaseTime;
      for (const key of listed) {
        const clients = leases.get(key) ?? new Map<string, Lease>();
        leases.set(key, clients);
        clients.set(clientID, { until, visible: key === visible });
      }
      for (const key of changed) sync(key);
      scheduleSweep();
      return Object.fromEntries([...listed].map((key) => [key, store.get(key)]));
    },
    release(clientID: string) {
      for (const key of forget(clientID)) sync(key);
    },
    get: (key: string) => store.get(key),
    refresh: (key: string) => store.refresh(key),
    // After a change that the next lookup must see, such as new targets. A
    // leased session that doesn't poll is looked up once, because its new
    // targets may have reviews to watch.
    invalidate(key: string) {
      store.invalidate(key);
      if (!disposed && !holds.has(key) && liveLeases(key).length > 0) void store.refresh(key);
    },
    setTargeted: (key: string, targeted: boolean) => store.setTargeted(key, targeted),
    // After the key's pin changes, such as when babysitting starts or stops.
    // A pinned key is looked up right away, so the babysitter records its
    // baseline without waiting for the next poll.
    resync(key: string) {
      sync(key);
      if (pinned(key) && !disposed) void store.refresh(key);
    },
    // After an event that may have changed the PRs/MRs, such as a turn ending.
    notify: (key: string) => store.notify(key),
    keys: () => store.keys(),
    // Whether the key polls, for tests and diagnostics.
    polling: (key: string) => holds.has(key),
    // Stops polling. The returned promise settles once running watcher work
    // has, or after `wait` milliseconds, whichever comes first.
    async dispose(wait = 0) {
      disposed = true;
      if (sweepTimer !== undefined) clearTimer(sweepTimer);
      for (const release of holds.values()) release();
      holds.clear();
      store.dispose();
      if (wait <= 0 || tasks.size === 0) return;
      let timer: unknown;
      await Promise.race([
        Promise.allSettled([...tasks]),
        new Promise<void>((resolve) => (timer = setTimer(resolve, wait))),
      ]);
      clearTimer(timer);
    },
  };
}

export type StatusService = ReturnType<typeof createStatusService>;
