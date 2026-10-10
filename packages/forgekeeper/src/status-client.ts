import { HEARTBEAT, HOME } from './rpc';
import type { Snapshot } from './store';

// Where a status lives: the server plugin instance of `directory`, and a
// session ID or HOME within it.
export interface Place {
  directory: string;
  key: string;
}

export const samePlace = (a: Place, b: Place) => a.directory === b.directory && a.key === b.key;
const placeID = (place: Place) => JSON.stringify([place.directory, place.key]);

export interface StatusClientOptions {
  clientID: string;
  watch: (
    directory: string,
    input: { clientID: string; keys: string[]; visible?: string },
  ) => Promise<{ enabled: boolean; statuses: Record<string, unknown> }>;
  refresh: (directory: string, key: string) => Promise<{ enabled: boolean; snapshot: unknown }>;
  release: (directory: string, clientID: string) => Promise<unknown>;
  // Called after any snapshot or setting changes, so the UI can render again.
  onChange: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  defer?: (callback: () => void) => void;
}

export type StatusClient = ReturnType<typeof createStatusClient>;

// The CLI's side of the status service: which keys it has shown, the leases
// that keep the server watching them, and the snapshots the server sent.
// Each directory is its own server plugin instance, with its own options.
export function createStatusClient(options: StatusClientOptions) {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
  const clearTimer =
    options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const defer = options.defer ?? queueMicrotask;

  const snapshots = new Map<string, Snapshot>();
  // The keys this CLI has shown since it started, per directory. The server
  // keeps watching their reviews while they are hidden.
  const shown = new Map<string, Set<string>>();
  // Whether each directory's server has status on (`reviewStatus`).
  const enabled = new Map<string, boolean>();
  let visible: Place | undefined;
  let disposed = false;

  const isShown = (place: Place) => shown.get(place.directory)?.has(place.key) === true;

  // Snapshots arrive both as RPC responses and as events, in any order, so
  // only a newer revision replaces the current one. A snapshot without a
  // revision, for a key the server hasn't looked up yet, never replaces one
  // with a revision.
  function apply(place: Place, snapshot: Snapshot) {
    const id = placeID(place);
    if ((snapshot.revision ?? -1) >= (snapshots.get(id)?.revision ?? -1))
      snapshots.set(id, snapshot);
  }

  // Without the server, such as while its plugin reloads, the last status
  // stays, marked stale. The CLI never looks PRs/MRs up itself, because it
  // can't know the session's targets.
  function unavailable(directory: string, error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    const failure = {
      kind: 'request' as const,
      message: `PR/MR status service unavailable: ${reason}`,
      at: now(),
    };
    for (const key of shown.get(directory) ?? []) {
      const id = placeID({ directory, key });
      snapshots.set(id, { ...(snapshots.get(id) ?? {}), loading: false, error: failure });
    }
    options.onChange();
  }

  // A failed renewal, such as while the server plugin loads, retries sooner
  // than the next heartbeat, backing off up to it.
  const failures = new Map<string, number>();
  const retries = new Map<string, unknown>();
  function retryLater(directory: string) {
    const count = (failures.get(directory) ?? 0) + 1;
    failures.set(directory, count);
    const timer = retries.get(directory);
    if (timer !== undefined) clearTimer(timer);
    retries.set(
      directory,
      setTimer(() => void renew(directory), Math.min(HEARTBEAT, 1000 * 2 ** count)),
    );
  }

  async function renew(directory: string) {
    if (disposed) return;
    const timer = retries.get(directory);
    if (timer !== undefined) clearTimer(timer);
    retries.delete(directory);
    const keys = [...(shown.get(directory) ?? [])];
    try {
      const result = await options.watch(directory, {
        clientID: options.clientID,
        keys,
        ...(visible?.directory === directory ? { visible: visible.key } : {}),
      });
      failures.delete(directory);
      enabled.set(directory, result.enabled);
      for (const [key, snapshot] of Object.entries(result.statuses)) {
        if (isShown({ directory, key })) apply({ directory, key }, snapshot as Snapshot);
      }
      options.onChange();
    } catch (error) {
      unavailable(directory, error);
      retryLater(directory);
    }
  }

  // Coalesces the renewals of one change, such as a session switch that
  // hides one footer and shows another.
  const due = new Set<string>();
  function renewSoon(directory: string) {
    if (due.has(directory)) return;
    due.add(directory);
    defer(() => {
      due.delete(directory);
      void renew(directory);
    });
  }

  return {
    snapshot: (place: Place): Snapshot => snapshots.get(placeID(place)) ?? { loading: false },
    // Unknown until the directory's server answers, and on by default.
    enabled: (directory: string) => enabled.get(directory) ?? true,
    // A session lives in one directory. When it moves, such as to another
    // worktree, its lease moves too, so the old directory's server stops
    // watching it.
    show(place: Place) {
      if (place.key !== HOME) {
        for (const [directory, keys] of shown) {
          if (directory === place.directory || !keys.delete(place.key)) continue;
          snapshots.delete(placeID({ directory, key: place.key }));
          if (visible && samePlace(visible, { directory, key: place.key })) visible = undefined;
          renewSoon(directory);
        }
      }
      const keys = shown.get(place.directory) ?? new Set<string>();
      shown.set(place.directory, keys);
      keys.add(place.key);
      visible = place;
      renewSoon(place.directory);
    },
    hide(place: Place) {
      if (visible && samePlace(visible, place)) visible = undefined;
      renewSoon(place.directory);
    },
    async refresh(place: Place) {
      const id = placeID(place);
      snapshots.set(id, { ...(snapshots.get(id) ?? {}), loading: true });
      options.onChange();
      try {
        const result = await options.refresh(place.directory, place.key);
        enabled.set(place.directory, result.enabled);
        apply(place, result.snapshot as Snapshot);
        options.onChange();
      } catch (error) {
        unavailable(place.directory, error);
      }
    },
    // Renews every lease. Call it every HEARTBEAT.
    heartbeat() {
      for (const directory of shown.keys()) void renew(directory);
    },
    // A `status` event from a directory's server.
    receive(directory: string, key: string, snapshot: Snapshot) {
      if (!isShown({ directory, key })) return;
      apply({ directory, key }, snapshot);
      options.onChange();
    },
    // Whether this CLI has shown the session, so its notices concern this CLI.
    hasShown: (sessionID: string) => [...shown.values()].some((keys) => keys.has(sessionID)),
    dispose() {
      disposed = true;
      for (const timer of retries.values()) clearTimer(timer);
      for (const directory of shown.keys())
        void options.release(directory, options.clientID).catch(() => {});
    },
  };
}
