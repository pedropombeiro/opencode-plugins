// Lifecycle events for a session's PRs/MRs: one that starts to conflict with
// its target branch, and one that merges. Each comes from a change between two
// lookups, never from the state alone, so the first lookup of a PR/MR only
// records it, and nothing old is announced after a restart.
//
// Events wait in their PR/MR's record until they reach the inbox. The record
// and its new events are one storage write, so a crash neither loses an
// event nor repeats it, and a merged PR/MR that nothing polls anymore still
// gets its event delivered.
import type { ReviewRequest } from './forge';
import type { EventPolicy, FeedbackDelivery } from './options';

export type LifecycleKind = 'conflict' | 'merged';

export interface LifecycleEvent {
  kind: LifecycleKind;
  // Stable across retries, so the inbox records each event once.
  id: string;
  detectedAt: number;
  // The policy when the event happened. Execution uses the stricter of this
  // and the current one, so enabling execution never acts on old events.
  policy?: EventPolicy;
  // How the event reaches its session, as the mode was when it happened.
  // Absent in inbox mode, so enabling summaries never starts turns for it.
  delivery?: 'passive' | 'summary';
}

export interface LifecycleRecord {
  sessionID: string;
  url: string;
  reference: string;
  state: string;
  // The last known mergeability; unknown results keep it.
  conflicts?: boolean;
  // How many times the PR/MR started to conflict, for distinct event IDs.
  cycles: number;
  targetProject: string;
  targetBranch: string;
  sourceProject?: string;
  sourceBranch?: string;
  // The session target this one builds on: its target branch is that one's
  // source branch. Kept once that one stops being open, since forges may
  // retarget or delete branches when it merges.
  parent?: string;
  pending: LifecycleEvent[];
  at: number;
}

const host = (url: string) => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
};

const same = (a: string | undefined, b: string | undefined) =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

// The open request that `child` builds on, when exactly one does.
function parentOf(child: ReviewRequest, requests: readonly ReviewRequest[]) {
  const candidates = requests.filter(
    (request) =>
      request.url !== child.url &&
      host(request.url) === host(child.url) &&
      request.sourceBranch !== undefined &&
      same(request.sourceProject, child.targetProject) &&
      request.sourceBranch === child.targetBranch,
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

// The session's records after a lookup of its targets. Returns a record for
// each request. A request without a record gets one without events.
export function observe(
  sessionID: string,
  requests: readonly ReviewRequest[],
  records: ReadonlyMap<string, LifecycleRecord>,
  reference: (request: ReviewRequest) => string,
  now: number,
  policy: (kind: LifecycleKind) => EventPolicy | undefined = () => undefined,
  delivery: () => FeedbackDelivery = () => 'inbox',
): LifecycleRecord[] {
  return requests.map((request) => {
    const previous = records.get(request.url);
    const conflicts = request.conflictsKnown ? request.conflicts : previous?.conflicts;
    // A parent is known only while it's open; once it isn't, the last one
    // stays, unless that PR/MR is no longer a target.
    const found = parentOf(
      request,
      requests.filter((entry) => entry.state === 'opened'),
    );
    const kept =
      previous?.parent &&
      requests.some((entry) => entry.url === previous.parent && entry.state !== 'opened')
        ? previous.parent
        : undefined;
    const parent = found?.url ?? kept;
    let cycles = previous?.cycles ?? 0;
    const pending = [...(previous?.pending ?? [])];
    const add = (kind: LifecycleKind, id: string) => {
      if (pending.some((event) => event.id === id)) return;
      const rule = policy(kind);
      const mode = delivery();
      pending.push({
        kind,
        id,
        detectedAt: now,
        ...(rule ? { policy: rule } : {}),
        ...(mode !== 'inbox' ? { delivery: mode } : {}),
      });
    };
    if (previous) {
      if (
        request.state === 'opened' &&
        request.conflictsKnown &&
        request.conflicts &&
        previous.conflicts === false
      ) {
        cycles++;
        add('conflict', JSON.stringify([sessionID, request.url, 'conflict', cycles]));
      }
      if (previous.state === 'opened' && request.state === 'merged')
        add('merged', JSON.stringify([sessionID, request.url, 'merged']));
    }
    return {
      sessionID,
      url: request.url,
      reference: reference(request),
      state: request.state,
      ...(conflicts !== undefined ? { conflicts } : {}),
      cycles,
      targetProject: request.targetProject,
      targetBranch: request.targetBranch,
      ...(request.sourceProject ? { sourceProject: request.sourceProject } : {}),
      ...(request.sourceBranch ? { sourceBranch: request.sourceBranch } : {}),
      ...(parent ? { parent } : {}),
      pending,
      at: now,
    };
  });
}

// Records equal apart from when they were written, so unchanged lookups
// don't write.
export const unchanged = (a: LifecycleRecord | undefined, b: LifecycleRecord) =>
  a !== undefined && JSON.stringify({ ...a, at: 0 }) === JSON.stringify({ ...b, at: 0 });

export interface LifecycleWatcherOptions {
  // The session's stored records.
  records: (sessionID: string) => Promise<LifecycleRecord[]>;
  write: (record: LifecycleRecord) => Promise<void>;
  // Every record that has events waiting, for retries.
  waiting: () => Promise<LifecycleRecord[]>;
  // Takes an event to the inbox. Resolves `false` to drop it, such as when
  // the session no longer targets the PR/MR, and `retry` to keep it for
  // another attempt without an error, such as while a retarget is retried.
  // Rejects to retry it later.
  deliver: (
    record: LifecycleRecord,
    event: LifecycleEvent,
    records: readonly LifecycleRecord[],
  ) => Promise<boolean | 'retry'>;
  reference: (request: ReviewRequest) => string;
  policy?: (kind: LifecycleKind) => EventPolicy | undefined;
  delivery?: () => FeedbackDelivery;
  onError?: (error: unknown) => void;
  now?: () => number;
}

export function createLifecycleWatcher(options: LifecycleWatcherOptions) {
  const now = options.now ?? Date.now;
  // One session's work at a time, so a lookup and a retry can't both write
  // its records.
  const queues = new Map<string, Promise<unknown>>();
  const serialized = <T>(sessionID: string, task: () => Promise<T>): Promise<T> => {
    const next = (queues.get(sessionID) ?? Promise.resolve()).then(task, task);
    const settled = next.catch(() => {});
    queues.set(sessionID, settled);
    void settled.then(() => {
      if (queues.get(sessionID) === settled) queues.delete(sessionID);
    });
    return next;
  };

  // Delivers the session's waiting events, oldest first. A failed event
  // stays for the next retry; the others still go.
  async function flush(sessionID: string) {
    let failure: { error: unknown } | undefined;
    const records = await options.records(sessionID);
    for (const record of records) {
      let current = record;
      for (const event of record.pending) {
        try {
          if ((await options.deliver(current, event, records)) === 'retry') continue;
        } catch (error) {
          failure ??= { error };
          continue;
        }
        current = { ...current, pending: current.pending.filter((entry) => entry.id !== event.id) };
        await options.write(current);
      }
    }
    if (failure) throw failure.error;
  }

  return {
    // Records a lookup of the session's targets, then delivers what it found.
    observe: (sessionID: string, requests: readonly ReviewRequest[]) =>
      serialized(sessionID, async () => {
        if (requests.length === 0) return;
        const stored = new Map(
          (await options.records(sessionID)).map((record) => [record.url, record]),
        );
        for (const record of observe(
          sessionID,
          requests,
          stored,
          options.reference,
          now(),
          options.policy,
          options.delivery,
        )) {
          if (!unchanged(stored.get(record.url), record)) await options.write(record);
        }
        await flush(sessionID);
      }),
    // Retries every waiting event, such as after a reload or a failure.
    retry: async () => {
      const sessions = new Set((await options.waiting()).map((record) => record.sessionID));
      for (const sessionID of sessions)
        await serialized(sessionID, () => flush(sessionID)).catch((error) =>
          options.onError?.(error),
        );
    },
  };
}
