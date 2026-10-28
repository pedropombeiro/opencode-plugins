// Lifecycle events for a session's PRs/MRs: one that starts to conflict with
// its target branch, one whose pipeline gets new failed jobs, even while the
// pipeline still runs, and one that merges. Each comes from a change
// between two lookups, never from the state alone, so the first lookup of a
// PR/MR only records it, and nothing old is announced after a restart.
//
// Events wait in their PR/MR's record until they reach the inbox. The record
// and its new events are one storage write, so a crash neither loses an
// event nor repeats it, and a merged PR/MR that nothing polls anymore still
// gets its event delivered.
import {
  jobKey,
  pipelineFails,
  pipelineRunning,
  unlistedFailure,
  type FailedJob,
  type ReviewRequest,
} from './forge';
import type { EventPolicy, FeedbackDelivery } from './options';

export type LifecycleKind = 'conflict' | 'merged' | 'ci-failed';

// The head pipeline as a lookup last saw it.
export interface PipelineState {
  // Absent while the PR/MR has no pipeline the forge identifies.
  id?: string;
  failed: boolean;
  running: boolean;
  // The read failed jobs that fail the pipeline.
  jobs: FailedJob[];
  // False when the pipeline has more failed jobs than the forge listed.
  complete: boolean;
  // Whether only the pipeline's status says that an unread job failed it.
  unlisted: boolean;
  // Every failed job attempt seen in this pipeline, by `jobKey`, newest
  // last, including ones the forge no longer lists, such as when newer
  // failures push them past the jobs it reads. Absent in older records.
  seen?: string[];
}

// The failure the pipeline's status reports when no read job explains it.
export const UNLISTED_FAILURE = 'unlisted';

// The failed job attempts a pipeline remembers. Older ones may count as new
// again if they return to the jobs the forge reads.
export const MAX_SEEN_FAILURES = 500;

// The pipeline's failures, by `jobKey`, and the status's own one.
export const failureKeys = (ci: PipelineState) => [
  ...ci.jobs.map(jobKey),
  ...(ci.unlisted ? [UNLISTED_FAILURE] : []),
];

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
  // The pipeline a `ci-failed` event is about, and the jobs that newly
  // failed in it, by `jobKey`.
  pipeline?: string;
  jobs?: string[];
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
  // Absent in records from before Forgekeeper watched pipelines, whose next
  // lookup only records the pipeline.
  ci?: PipelineState;
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

// What a lookup says of the request's head pipeline. A pipeline the forge
// doesn't identify counts as none.
function pipelineState(request: ReviewRequest): PipelineState {
  const pipeline = request.pipeline?.id ? request.pipeline : undefined;
  return {
    ...(pipeline ? { id: pipeline.id } : {}),
    failed: pipelineFails(pipeline),
    running: pipelineRunning(pipeline),
    jobs: pipeline?.failedJobs ?? [],
    complete: pipeline?.failedJobsComplete !== false,
    unlisted: unlistedFailure(pipeline),
  };
}

// The job attempts seen in the pipeline so far, after this lookup. Another
// pipeline starts afresh. The status's own failure isn't a job, so it counts
// again whenever it returns, such as after a retry.
function seenFailures(previous: PipelineState | undefined, current: PipelineState): string[] {
  const earlier =
    previous && previous.id === current.id ? (previous.seen ?? previous.jobs.map(jobKey)) : [];
  const now = current.jobs.map(jobKey).filter((key) => !earlier.includes(key));
  return [...earlier, ...now].slice(-MAX_SEEN_FAILURES);
}

// The failures since the previous lookup: every one in a pipeline the
// previous lookup didn't see, and in the same pipeline, the ones it never
// saw, such as a retry that failed again. A job attempt that comes back to
// the listed jobs isn't new.
function newFailures(previous: PipelineState, current: PipelineState): string[] {
  const known = new Set(
    previous.id === current.id ? [...failureKeys(previous), ...(previous.seen ?? [])] : [],
  );
  return failureKeys(current).filter((key) => !known.has(key));
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
    const add = (kind: LifecycleKind, id: string, extra: Partial<LifecycleEvent> = {}) => {
      if (pending.some((event) => event.id === id)) return;
      const rule = policy(kind);
      const mode = delivery();
      pending.push({
        kind,
        id,
        detectedAt: now,
        ...(rule ? { policy: rule } : {}),
        ...(mode !== 'inbox' ? { delivery: mode } : {}),
        ...extra,
      });
    };
    // Records from before Forgekeeper told job attempts apart lack
    // `unlisted`, and only record the jobs.
    const known = previous?.ci && 'unlisted' in previous.ci ? previous.ci : undefined;
    const current = pipelineState(request);
    const ci = current.id ? { ...current, seen: seenFailures(known, current) } : current;
    // Jobs that newly failed, whether the pipeline still runs or not, as one
    // event per lookup.
    const failures = known && request.state === 'opened' && ci.id ? newFailures(known, ci) : [];
    if (ci.id && failures.length) {
      const jobs = failures.sort();
      add('ci-failed', JSON.stringify([sessionID, request.url, 'ci-failed', ci.id, jobs]), {
        pipeline: ci.id,
        jobs,
      });
    }
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
      ci,
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
