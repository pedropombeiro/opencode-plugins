import type { FeedbackItem, InboxState } from './feedback-inbox';
import type {
  ForgeKind,
  IssueSnapshot,
  IssueStateSnapshot,
  RequestStateSnapshot,
  ReviewRef,
} from './forge';
import { parseReference, traits, type ForgeCatalog } from './forges';
import { CONCURRENCY, mapLimit } from './limit';
import {
  freshPresence,
  isBusy,
  linkedOwner,
  presenceKey,
  type DirectorySession,
} from './linked-session';
import type { CleanupReady, Lookup, Snapshot } from './store';
import type { Target } from './target';

export type { CleanupReady } from './store';

export type CleanupPhase = 'sessions' | 'targets' | 'verifying' | 'archiving';

export interface CleanupProgressEvent {
  phase: CleanupPhase;
  checked: number;
  total: number;
}

export interface CleanupTarget {
  kind: 'merge-request' | 'issue';
  url: string;
  reference: string;
  title?: string;
  project: string;
}

export interface CleanupCandidate {
  sessionID: string;
  title: string;
  directory: string;
  updatedAt?: number;
  reason: CleanupReady['kind'];
  targets: CleanupTarget[];
  pendingFeedback: number;
}

export interface CleanupScanResult {
  enabled: boolean;
  candidates: CleanupCandidate[];
  skippedErrors: number;
}

export interface CleanupFailure {
  sessionID: string;
  reason: string;
}

export interface CleanupResult {
  archived: string[];
  alreadyArchived: string[];
  failed: CleanupFailure[];
}

export interface ListedSession extends DirectorySession {
  title?: string;
  projectID?: string;
  fork?: { sessionID?: string | null } | null;
  time: DirectorySession['time'] & { updated?: number };
  location: { directory: string };
}

export interface SessionPage {
  data: ListedSession[];
  cursor?: { next?: string | null };
}

export interface ParsedTarget {
  url: string;
  ref: ReviewRef;
}

const refIdentity = (kind: 'merge-request' | 'issue', ref: ReviewRef) =>
  JSON.stringify([kind, ref.forge, ref.host, ref.project.toLowerCase(), ref.iid]);

export function splitCleanupTargets(targets: readonly Target[]): {
  mergeRequests: ParsedTarget[];
  issues: ParsedTarget[];
  unknown: number;
} {
  const mergeRequests: ParsedTarget[] = [];
  const issues: ParsedTarget[] = [];
  const seen = new Set<string>();
  let unknown = 0;
  for (const target of targets) {
    const parsed = parseReference(target.url);
    if (!parsed) {
      unknown++;
      continue;
    }
    const kind = parsed.issue ? 'issue' : 'merge-request';
    const key = refIdentity(kind, parsed.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    if (parsed.issue) issues.push({ url: target.url, ref: parsed.ref });
    else mergeRequests.push({ url: target.url, ref: parsed.ref });
  }
  return { mergeRequests, issues, unknown };
}

export function allRequestsMerged(snapshot: Snapshot): boolean {
  const lookup = snapshot.lookup;
  return (
    lookup?.kind === 'found' &&
    lookup.explicitTarget === true &&
    lookup.requests.length > 0 &&
    !lookup.failed?.length &&
    lookup.requests.every((request) => request.state === 'merged')
  );
}

export function cleanupReadyOf(snapshot: Snapshot): CleanupReady | undefined {
  if (snapshot.lookup?.cleanupReady) return snapshot.lookup.cleanupReady;
  if (!allRequestsMerged(snapshot) || snapshot.lookup?.kind !== 'found') return undefined;
  return {
    kind: 'merged-requests',
    reason: snapshot.lookup.requests.length === 1 ? 'PR/MR merged' : 'All PRs/MRs merged',
  };
}

export function formatCleanupSubtitle(candidate: CleanupCandidate): string {
  const refs = candidate.targets.map((target) => target.reference).join(', ');
  const state = candidate.reason === 'merged-requests' ? 'merged' : 'closed';
  const summary = refs ? `${refs} ${state}` : state;
  if (candidate.pendingFeedback <= 0) return summary;
  return `${summary} · ${candidate.pendingFeedback} review update${candidate.pendingFeedback === 1 ? '' : 's'}`;
}

export function worktreeLabel(directory: string): string {
  const normalized = directory.replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? directory;
}

export function formatCleanupProgress(
  progress: CleanupProgressEvent | undefined,
  mode: 'scan' | 'cleanup' = 'scan',
): string {
  if (!progress) {
    return mode === 'cleanup'
      ? 'Verifying and archiving sessions…'
      : 'Checking sessions for merged PRs/MRs and closed issues…';
  }
  const counts = progress.total > 0 ? ` (${progress.checked}/${progress.total})` : '';
  if (progress.phase === 'sessions') {
    const scanned = progress.checked > 0 ? ` (${progress.checked} found)` : '';
    return `Scanning project sessions…${scanned}`;
  }
  if (progress.phase === 'targets') {
    return `Checking PRs/MRs and tracked issues…${counts}`;
  }
  if (progress.phase === 'verifying') {
    return `Verifying target status before archiving…${counts}`;
  }
  return `Archiving sessions…${counts}`;
}

const BATCH_SIZE = 25;
const SESSION_CONCURRENCY = 16;

const formatIssueRef = (ref: ReviewRef, multiProject: boolean) => {
  const short = traits(ref.forge).issueReference(ref.iid);
  return multiProject ? `${ref.project}${short}` : short;
};

const formatRequestRef = (
  forge: ForgeKind,
  request: RequestStateSnapshot,
  multiProject: boolean,
) => {
  const short = traits(forge).reference(request.iid);
  return multiProject ? `${request.targetProject}${short}` : short;
};

function chunkItems<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

type Evaluation =
  | {
      status: 'eligible';
      reason: CleanupReady['kind'];
      targets: CleanupTarget[];
    }
  | { status: 'ineligible'; reason: string }
  | { status: 'error'; reason: string };

interface EvaluateOptions {
  signal?: AbortSignal;
  phase?: 'targets' | 'verifying';
  onProgress?: (progress: CleanupProgressEvent) => void;
}

async function evaluateTargets(
  forges: ForgeCatalog,
  directory: string,
  entries: ReadonlyArray<{
    sessionID: string;
    directory: string;
    mergeRequests: ParsedTarget[];
    issues: ParsedTarget[];
  }>,
  options?: EvaluateOptions,
): Promise<Map<string, Evaluation>> {
  const mrLookups = new Map<string, { ref: ReviewRef; directory: string }>();
  const issueLookups = new Map<string, { ref: ReviewRef; directory: string }>();

  for (const entry of entries) {
    if (entry.mergeRequests.length > 0) {
      for (const target of entry.mergeRequests) {
        const key = refIdentity('merge-request', target.ref);
        if (!mrLookups.has(key))
          mrLookups.set(key, { ref: target.ref, directory: entry.directory });
      }
    } else if (entry.issues.length > 0) {
      for (const target of entry.issues) {
        const key = refIdentity('issue', target.ref);
        if (!issueLookups.has(key))
          issueLookups.set(key, { ref: target.ref, directory: entry.directory });
      }
    }
  }

  const totalLookups = mrLookups.size + issueLookups.size;
  let checkedLookups = 0;
  const phase = options?.phase ?? 'targets';
  const report = (delta: number) => {
    checkedLookups += delta;
    options?.onProgress?.({
      phase,
      checked: Math.min(checkedLookups, totalLookups),
      total: totalLookups,
    });
  };
  if (totalLookups > 0) {
    options?.onProgress?.({ phase, checked: 0, total: totalLookups });
  }

  type GroupItem = { key: string; ref: ReviewRef; directory: string };
  type BatchGroup = {
    kind: 'merge-request' | 'issue';
    forgeKind: ForgeKind;
    host: string;
    project: string;
    directory: string;
    items: GroupItem[];
  };

  const groupMap = new Map<string, BatchGroup>();
  const addGroupItem = (
    kind: 'merge-request' | 'issue',
    key: string,
    ref: ReviewRef,
    cwd: string,
  ) => {
    const groupKey = JSON.stringify([kind, ref.forge, ref.host, ref.project.toLowerCase()]);
    let group = groupMap.get(groupKey);
    if (!group) {
      group = {
        kind,
        forgeKind: ref.forge,
        host: ref.host,
        project: ref.project,
        directory: cwd || directory,
        items: [],
      };
      groupMap.set(groupKey, group);
    }
    group.items.push({ key, ref, directory: cwd || directory });
  };

  for (const [key, { ref, directory: cwd }] of mrLookups) {
    addGroupItem('merge-request', key, ref, cwd);
  }
  for (const [key, { ref, directory: cwd }] of issueLookups) {
    addGroupItem('issue', key, ref, cwd);
  }

  const mrResults = new Map<string, { request?: RequestStateSnapshot; error?: boolean }>();
  const issueResults = new Map<string, { issue?: IssueStateSnapshot; error?: boolean }>();

  const tasks: Array<() => Promise<void>> = [];
  for (const group of groupMap.values()) {
    for (const chunk of chunkItems(group.items, BATCH_SIZE)) {
      tasks.push(async () => {
        if (options?.signal?.aborted) return;
        const forge =
          forges.kind(group.host) === group.forgeKind
            ? forges.forHost(group.host, group.directory)
            : undefined;
        if (!forge) {
          for (const item of chunk) {
            if (group.kind === 'merge-request') mrResults.set(item.key, { error: true });
            else issueResults.set(item.key, { error: true });
          }
          report(chunk.length);
          return;
        }

        if (group.kind === 'merge-request') {
          if (forge.requestStates) {
            try {
              const states = await forge.requestStates(
                { host: group.host, path: group.project },
                chunk.map((item) => item.ref.iid),
              );
              for (const item of chunk) {
                const state = states.get(item.ref.iid);
                mrResults.set(item.key, state ? { request: state } : { error: true });
              }
            } catch {
              for (const item of chunk) mrResults.set(item.key, { error: true });
            }
            report(chunk.length);
            return;
          }
          for (const item of chunk) {
            if (options?.signal?.aborted) return;
            try {
              const request = await forge.findByNumber(
                [{ host: item.ref.host, path: item.ref.project }],
                item.ref.iid,
              );
              mrResults.set(
                item.key,
                request
                  ? {
                      request: {
                        iid: request.iid,
                        title: request.title,
                        url: request.url,
                        state: request.state,
                        targetProject: request.targetProject,
                      },
                    }
                  : { error: true },
              );
            } catch {
              mrResults.set(item.key, { error: true });
            }
            report(1);
          }
          return;
        }

        if (forge.issueStates) {
          try {
            const states = await forge.issueStates(
              { host: group.host, path: group.project },
              chunk.map((item) => item.ref.iid),
            );
            for (const item of chunk) {
              const state = states.get(item.ref.iid);
              issueResults.set(item.key, state ? { issue: state } : { error: true });
            }
          } catch {
            for (const item of chunk) issueResults.set(item.key, { error: true });
          }
          report(chunk.length);
          return;
        }

        for (const item of chunk) {
          if (options?.signal?.aborted) return;
          if (!forge.issue) {
            issueResults.set(item.key, { error: true });
            report(1);
            continue;
          }
          try {
            const issue = await forge.issue(item.ref);
            issueResults.set(
              item.key,
              issue ? { issue: { iid: item.ref.iid, open: issue.open } } : { error: true },
            );
          } catch {
            issueResults.set(item.key, { error: true });
          }
          report(1);
        }
      });
    }
  }

  await mapLimit(tasks, CONCURRENCY, (run) => run());

  const evaluations = new Map<string, Evaluation>();
  for (const entry of entries) {
    if (entry.mergeRequests.length > 0) {
      const projects = new Set(entry.mergeRequests.map((item) => item.ref.project.toLowerCase()));
      const multiProject = projects.size > 1;
      const targets: CleanupTarget[] = [];
      let hadError = false;
      let unmerged = false;
      for (const target of entry.mergeRequests) {
        const result = mrResults.get(refIdentity('merge-request', target.ref));
        if (!result?.request || result.error) {
          hadError = true;
          break;
        }
        if (result.request.state !== 'merged') {
          unmerged = true;
        }
        targets.push({
          kind: 'merge-request',
          url: result.request.url,
          reference: formatRequestRef(target.ref.forge, result.request, multiProject),
          title: result.request.title,
          project: result.request.targetProject,
        });
      }
      if (hadError) {
        evaluations.set(entry.sessionID, {
          status: 'error',
          reason: 'Could not verify PR/MR status',
        });
      } else if (unmerged) {
        evaluations.set(entry.sessionID, {
          status: 'ineligible',
          reason: 'Not all PRs/MRs are merged',
        });
      } else {
        evaluations.set(entry.sessionID, {
          status: 'eligible',
          reason: 'merged-requests',
          targets,
        });
      }
      continue;
    }

    const projects = new Set(entry.issues.map((item) => item.ref.project.toLowerCase()));
    const multiProject = projects.size > 1;
    const targets: CleanupTarget[] = [];
    let hadError = false;
    let openIssue = false;
    for (const target of entry.issues) {
      const result = issueResults.get(refIdentity('issue', target.ref));
      if (!result?.issue || result.error) {
        hadError = true;
        break;
      }
      if (result.issue.open) {
        openIssue = true;
      }
      targets.push({
        kind: 'issue',
        url: target.url,
        reference: formatIssueRef(target.ref, multiProject),
        project: target.ref.project,
      });
    }
    if (hadError) {
      evaluations.set(entry.sessionID, {
        status: 'error',
        reason: 'Could not verify tracked issue status',
      });
    } else if (openIssue) {
      evaluations.set(entry.sessionID, {
        status: 'ineligible',
        reason: 'Not all tracked issues are closed',
      });
    } else {
      evaluations.set(entry.sessionID, {
        status: 'eligible',
        reason: 'closed-issues',
        targets,
      });
    }
  }
  return evaluations;
}

const MAX_FORK_DEPTH = 5;

const inScope = (session: ListedSession, projectID: string | undefined, directory: string) => {
  if (projectID && projectID !== 'global') {
    return session.projectID === undefined || session.projectID === projectID;
  }
  return session.location.directory === directory;
};

export interface CleanupDependencies {
  projectID?: string;
  directory: string;
  forges: ForgeCatalog;
  listSessions: () => Promise<ListedSession[]>;
  getSession: (sessionID: string) => Promise<ListedSession | undefined>;
  archiveSession: (sessionID: string) => Promise<void>;
  storedTargets: (sessionID: string) => Promise<Target[]>;
  storedTargetsMap?: () => Promise<ReadonlyMap<string, readonly Target[]>>;
  pendingFeedbackCount: (directory: string, sessionID: string) => Promise<number>;
  onSessionCleaned: (sessionID: string, sessionDirectory: string) => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (progress: CleanupProgressEvent) => void;
}

export async function listProjectSessions(options: {
  projectID?: string;
  directory: string;
  list?: (input: {
    project?: string;
    directory?: string;
    parentID?: string | null;
    archived?: boolean;
    limit?: number;
    cursor?: string;
  }) => Promise<SessionPage>;
  scanTargets?: () => Promise<string[]>;
  getSession?: (sessionID: string) => Promise<ListedSession | undefined>;
  signal?: AbortSignal;
  onProgress?: (checked: number) => void;
}): Promise<ListedSession[]> {
  const { projectID, directory, list, scanTargets, getSession, signal, onProgress } = options;
  if (list) {
    const found: ListedSession[] = [];
    const seen = new Set<string>();
    const scope = projectID && projectID !== 'global' ? { project: projectID } : { directory };
    let page = await list({ ...scope, parentID: null, archived: false, limit: 200 });
    for (;;) {
      for (const session of page.data) {
        if (seen.has(session.id)) continue;
        seen.add(session.id);
        if (inScope(session, projectID, directory)) found.push(session);
      }
      onProgress?.(found.length);
      if (signal?.aborted) break;
      const next = page.cursor?.next;
      if (!next) break;
      page = await list({ cursor: next, limit: 200 });
    }
    return found;
  }
  if (!scanTargets || !getSession) return [];
  const ids = await scanTargets();
  const sessions = await mapLimit(ids, SESSION_CONCURRENCY, async (id) => {
    if (signal?.aborted) return undefined;
    return getSession(id);
  });
  return sessions.filter(
    (session): session is ListedSession =>
      session !== undefined && inScope(session, projectID, directory),
  );
}

async function resolveSessionTargets(
  session: ListedSession,
  byID: ReadonlyMap<string, ListedSession>,
  targetMap: ReadonlyMap<string, readonly Target[]> | undefined,
  storedTargets: (sessionID: string) => Promise<Target[]>,
): Promise<readonly Target[]> {
  if (!targetMap) return storedTargets(session.id);
  const visited = new Set<string>();
  let current: ListedSession | undefined = session;
  for (let depth = 0; depth <= MAX_FORK_DEPTH && current; depth++) {
    if (visited.has(current.id)) return [];
    visited.add(current.id);
    const direct = targetMap.get(current.id);
    if (direct !== undefined) return direct;
    const forkID = current.fork?.sessionID;
    if (!forkID || visited.has(forkID)) return [];
    const parent = byID.get(forkID);
    if (!parent) return storedTargets(session.id);
    current = parent;
  }
  return [];
}

export async function cleanupCandidates(
  deps: Pick<
    CleanupDependencies,
    | 'projectID'
    | 'directory'
    | 'forges'
    | 'listSessions'
    | 'storedTargets'
    | 'storedTargetsMap'
    | 'pendingFeedbackCount'
    | 'signal'
    | 'onProgress'
  >,
): Promise<CleanupScanResult> {
  deps.onProgress?.({ phase: 'sessions', checked: 0, total: 0 });
  const [sessions, targetMap] = await Promise.all([
    deps.listSessions(),
    deps.storedTargetsMap ? deps.storedTargetsMap() : Promise.resolve(undefined),
  ]);
  if (deps.signal?.aborted) {
    return { enabled: true, candidates: [], skippedErrors: 0 };
  }

  const byID = new Map(sessions.map((session) => [session.id, session]));
  const active = sessions.filter(
    (session) =>
      inScope(session, deps.projectID, deps.directory) &&
      !session.parentID &&
      session.time?.archived === undefined &&
      !linkedOwner(session) &&
      !isBusy(session),
  );

  const targeted = await mapLimit(active, SESSION_CONCURRENCY, async (session) => {
    if (deps.signal?.aborted) return undefined;
    const raw = await resolveSessionTargets(session, byID, targetMap, deps.storedTargets);
    const { mergeRequests, issues, unknown } = splitCleanupTargets(raw);
    if (mergeRequests.length === 0 && (unknown > 0 || issues.length === 0)) return undefined;
    return {
      session,
      sessionID: session.id,
      directory: session.location.directory,
      mergeRequests,
      issues,
    };
  });

  const inspectable = targeted.filter((entry): entry is NonNullable<typeof entry> => !!entry);
  if (inspectable.length === 0 || deps.signal?.aborted) {
    return { enabled: true, candidates: [], skippedErrors: 0 };
  }

  const evaluations = await evaluateTargets(deps.forges, deps.directory, inspectable, {
    signal: deps.signal,
    phase: 'targets',
    onProgress: deps.onProgress,
  });
  if (deps.signal?.aborted) {
    return { enabled: true, candidates: [], skippedErrors: 0 };
  }
  let skippedErrors = 0;
  const matched: Array<{
    session: ListedSession;
    reason: CleanupReady['kind'];
    targets: CleanupTarget[];
  }> = [];

  for (const entry of inspectable) {
    const evaluation = evaluations.get(entry.sessionID);
    if (!evaluation) continue;
    if (evaluation.status === 'error') {
      skippedErrors++;
      continue;
    }
    if (evaluation.status === 'eligible') {
      matched.push({
        session: entry.session,
        reason: evaluation.reason,
        targets: evaluation.targets,
      });
    }
  }

  const candidates = await Promise.all(
    matched.map(async ({ session, reason, targets }): Promise<CleanupCandidate> => ({
      sessionID: session.id,
      title: session.title || session.id,
      directory: session.location.directory,
      ...(session.time.updated === undefined ? {} : { updatedAt: session.time.updated }),
      reason,
      targets,
      pendingFeedback: await deps.pendingFeedbackCount(session.location.directory, session.id),
    })),
  );

  candidates.sort((a, b) => {
    const timeDiff = (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
    return timeDiff === 0 ? a.sessionID.localeCompare(b.sessionID) : timeDiff;
  });

  return { enabled: true, candidates, skippedErrors };
}

export async function cleanupSessions(
  sessionIDs: readonly string[],
  deps: Omit<CleanupDependencies, 'listSessions' | 'pendingFeedbackCount'>,
): Promise<CleanupResult> {
  const uniqueIDs = [...new Set(sessionIDs.filter(Boolean))];
  const archived: string[] = [];
  const alreadyArchived: string[] = [];
  const failed: CleanupFailure[] = [];

  const targetMap = deps.storedTargetsMap ? await deps.storedTargetsMap() : undefined;
  const loadedSessions = new Map<string, ListedSession>();

  const inspected = await mapLimit(uniqueIDs, SESSION_CONCURRENCY, async (sessionID) => {
    let session: ListedSession | undefined;
    try {
      session = await deps.getSession(sessionID);
    } catch (error) {
      return {
        kind: 'failed' as const,
        sessionID,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    if (!session || session.time?.archived !== undefined) {
      return { kind: 'alreadyArchived' as const, sessionID };
    }
    loadedSessions.set(sessionID, session);
    if (!inScope(session, deps.projectID, deps.directory)) {
      return {
        kind: 'failed' as const,
        sessionID,
        reason: 'Session belongs to another project',
      };
    }
    if (session.parentID || linkedOwner(session)) {
      return {
        kind: 'failed' as const,
        sessionID,
        reason: 'Only root sessions can be cleaned up',
      };
    }
    if (isBusy(session)) {
      return {
        kind: 'failed' as const,
        sessionID,
        reason: 'Session is currently running',
      };
    }
    const raw = await resolveSessionTargets(session, loadedSessions, targetMap, deps.storedTargets);
    const { mergeRequests, issues, unknown } = splitCleanupTargets(raw);
    if (mergeRequests.length === 0 && (unknown > 0 || issues.length === 0)) {
      return {
        kind: 'failed' as const,
        sessionID,
        reason: 'Session has no tracked PR/MR or issue targets',
      };
    }
    return {
      kind: 'verify' as const,
      sessionID,
      directory: session.location.directory,
      mergeRequests,
      issues,
    };
  });

  const toVerify: Array<{
    sessionID: string;
    directory: string;
    mergeRequests: ParsedTarget[];
    issues: ParsedTarget[];
  }> = [];

  for (const item of inspected) {
    if (item.kind === 'alreadyArchived') alreadyArchived.push(item.sessionID);
    else if (item.kind === 'failed')
      failed.push({ sessionID: item.sessionID, reason: item.reason });
    else toVerify.push(item);
  }

  if (toVerify.length > 0) {
    const evaluations = await evaluateTargets(deps.forges, deps.directory, toVerify, {
      phase: 'verifying',
      onProgress: deps.onProgress,
    });
    const eligibleEntries: typeof toVerify = [];
    for (const entry of toVerify) {
      const evaluation = evaluations.get(entry.sessionID);
      if (!evaluation || evaluation.status !== 'eligible') {
        failed.push({
          sessionID: entry.sessionID,
          reason: evaluation?.reason ?? 'Session is not eligible for cleanup',
        });
        continue;
      }
      eligibleEntries.push(entry);
    }

    if (eligibleEntries.length > 0) {
      let archivedCount = 0;
      deps.onProgress?.({ phase: 'archiving', checked: 0, total: eligibleEntries.length });
      const outcomes = await mapLimit(eligibleEntries, SESSION_CONCURRENCY, async (entry) => {
        try {
          await deps.archiveSession(entry.sessionID);
          await deps.onSessionCleaned(entry.sessionID, entry.directory);
          archivedCount++;
          deps.onProgress?.({
            phase: 'archiving',
            checked: archivedCount,
            total: eligibleEntries.length,
          });
          return { ok: true as const, sessionID: entry.sessionID };
        } catch (error) {
          archivedCount++;
          deps.onProgress?.({
            phase: 'archiving',
            checked: archivedCount,
            total: eligibleEntries.length,
          });
          return {
            ok: false as const,
            sessionID: entry.sessionID,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      });
      for (const outcome of outcomes) {
        if (outcome.ok) archived.push(outcome.sessionID);
        else failed.push({ sessionID: outcome.sessionID, reason: outcome.reason });
      }
    }
  }

  return { archived, alreadyArchived, failed };
}

export async function resolveLookupCleanupReady(
  lookup: Lookup,
  targets: readonly Target[],
  loadIssue: (ref: ReviewRef) => Promise<IssueSnapshot | undefined>,
): Promise<{ lookup: Lookup; targetKey?: string; complete: boolean }> {
  const { mergeRequests, issues, unknown } = splitCleanupTargets(targets);

  if (mergeRequests.length > 0) {
    const targetKey = JSON.stringify(
      mergeRequests.map((entry) => refIdentity('merge-request', entry.ref)).sort(),
    );
    if (lookup.kind !== 'found' || !lookup.explicitTarget) {
      return { lookup, targetKey, complete: false };
    }
    const complete = !lookup.failed?.length && lookup.requests.length === mergeRequests.length;
    if (complete && lookup.requests.every((request) => request.state === 'merged')) {
      const cleanupReady: CleanupReady = {
        kind: 'merged-requests',
        reason: lookup.requests.length === 1 ? 'PR/MR merged' : 'All PRs/MRs merged',
      };
      return {
        lookup: { ...lookup, cleanupReady },
        targetKey,
        complete: true,
      };
    }
    const next = { ...lookup };
    delete next.cleanupReady;
    return { lookup: next, targetKey, complete };
  }

  if (unknown > 0) return { lookup, complete: true };

  if (issues.length > 0 && lookup.kind === 'none' && !lookup.explicitTarget) {
    const targetKey = JSON.stringify(issues.map((entry) => refIdentity('issue', entry.ref)).sort());
    const settled = await Promise.all(
      issues.map(async ({ ref }) => {
        try {
          return await loadIssue(ref);
        } catch {
          return undefined;
        }
      }),
    );
    const complete = settled.every((issue) => issue !== undefined);
    if (complete && settled.every((issue) => issue?.open === false)) {
      const cleanupReady: CleanupReady = {
        kind: 'closed-issues',
        reason: issues.length === 1 ? 'Tracked issue closed' : 'All tracked issues closed',
      };
      return {
        lookup: { ...lookup, cleanupReady },
        targetKey,
        complete: true,
      };
    }
    const next = { ...lookup };
    delete next.cleanupReady;
    return { lookup: next, targetKey, complete };
  }

  return { lookup, complete: true };
}

const CLEANUP_WATCH_STORE = 'status/cleanup-watch/';
const CLEANUP_WATCH_RETENTION = 30 * 24 * 60 * 60_000;
export const cleanupWatchKey = (sessionID: string) =>
  `${CLEANUP_WATCH_STORE}${encodeURIComponent(sessionID)}`;

export interface CleanupWatchRecord {
  sessionID: string;
  targetKey: string;
  ready: boolean;
  notified: boolean;
  at: number;
}

export function createCleanupWatch(options: {
  read: (sessionID: string) => Promise<CleanupWatchRecord | undefined>;
  write: (record: CleanupWatchRecord) => Promise<void>;
  remove: (sessionID: string) => Promise<void>;
  scan: (prefix: string) => Promise<Array<{ key: string; value: unknown }>>;
  hasTargets: (sessionID: string) => Promise<boolean>;
  onReady: (sessionID: string, ready: CleanupReady) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  return {
    async observe(
      sessionID: string,
      targetKey: string | undefined,
      complete: boolean,
      cleanupReady: CleanupReady | undefined,
    ): Promise<void> {
      if (!targetKey) {
        await options.remove(sessionID).catch(() => {});
        return;
      }
      if (!complete) return;
      const ready = cleanupReady !== undefined;
      const previous = await options.read(sessionID).catch(() => undefined);
      const at = now();
      if (!previous || previous.targetKey !== targetKey) {
        // Baseline on first sight of this target set: never notify on startup/reload
        // for sessions that were already merged or closed.
        await options.write({
          sessionID,
          targetKey,
          ready,
          notified: ready,
          at,
        });
        return;
      }
      if (!ready) {
        if (previous.ready || previous.notified) {
          await options.write({
            sessionID,
            targetKey,
            ready: false,
            notified: false,
            at,
          });
        }
        return;
      }
      if (!previous.ready && !previous.notified && cleanupReady) {
        await options.write({
          sessionID,
          targetKey,
          ready: true,
          notified: true,
          at,
        });
        options.onReady(sessionID, cleanupReady);
      }
    },
    async forget(sessionID: string): Promise<void> {
      await options.remove(sessionID).catch(() => {});
    },
    async prune(): Promise<void> {
      const cutoff = now() - CLEANUP_WATCH_RETENTION;
      for (const { value } of await options.scan(CLEANUP_WATCH_STORE)) {
        const record = value as CleanupWatchRecord | undefined;
        if (!record?.sessionID || record.at >= cutoff) continue;
        const active = await options.hasTargets(record.sessionID).catch(() => true);
        if (!active) await options.remove(record.sessionID).catch(() => {});
      }
    },
  };
}

function resolveForeignSessionIDs(
  sessionIDs: ReadonlySet<string> | readonly string[] | undefined,
  sessionID: string | undefined,
): ReadonlySet<string> {
  if (sessionIDs instanceof Set) return sessionIDs;
  if (sessionIDs) return new Set(sessionIDs);
  if (sessionID === undefined) return new Set();
  return new Set([sessionID]);
}

export async function pruneForeignInboxSession(options: {
  storage: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: never) => Promise<void>;
  };
  directory: string;
  sessionID?: string;
  sessionIDs?: ReadonlySet<string> | readonly string[];
  now?: () => number;
  changed?: (directory: string) => void;
}): Promise<void> {
  const { storage, directory } = options;
  const ids = resolveForeignSessionIDs(options.sessionIDs, options.sessionID);
  if (ids.size === 0) return;
  const at = (options.now ?? Date.now)();
  const presence = await storage.get(presenceKey(directory)).catch(() => undefined);
  if (freshPresence(presence, at)) return;
  const inboxKey = `feedback-inbox/${encodeURIComponent(directory)}`;
  const state = (await storage.get(inboxKey).catch(() => undefined)) as InboxState | undefined;
  if (!state?.items?.length) return;
  const items = state.items.filter((item: FeedbackItem) => !ids.has(item.sessionID));
  if (items.length === state.items.length) return;
  await storage.set(inboxKey, { ...state, items } as never);
  options.changed?.(directory);
}
