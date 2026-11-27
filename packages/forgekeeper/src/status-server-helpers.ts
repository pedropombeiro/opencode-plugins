import type { Plugin } from '@opencode/plugin';
import { approvalDetails, matchesApproval } from './approval-watch';
import type { Exec } from './exec';
import { settledFeedback } from './feedback-cleanup';
import { isApproval, sessionItems, type FeedbackItem, type InboxState } from './feedback-inbox';
import {
  approvalsComplete,
  approversOf,
  type ForgeKind,
  type ReviewerApproval,
  type ReviewRequest,
} from './forge';
import { parseUrl, traitsOf, type ForgeCatalog } from './forges';
import { isJobFailure } from './job-investigation';
import { matchesReviewBot, type StatusOptions } from './options';
import { matchesApprovalRule } from './review-automation';
import type { CleanupProgress } from './rpc';
import {
  cleanupCandidates as scanCleanupCandidates,
  cleanupSessions as runCleanupSessions,
  listProjectSessions,
  pruneForeignInboxSession,
  type CleanupProgressEvent,
  type CleanupResult,
  type CleanupScanResult,
  type ListedSession,
  type SessionPage,
} from './session-cleanup';
import type { Target } from './target';

// Running automated reviews poll at most this often, so a finished review is
// noticed promptly.
export const REVIEW_POLL_SECONDS = 30;

// How long cleanup waits for running review checks before giving up. They
// can't send or write anything after cleanup starts, so this only bounds how
// long a stopped plugin keeps work around.
export const DRAIN_TIME = 5_000;

// Waits for the tasks, or for `limit` milliseconds, whichever comes first.
export async function drain(tasks: ReadonlySet<Promise<unknown>>, limit: number) {
  if (!tasks.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...tasks]),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, limit))),
  ]);
  clearTimeout(timer);
}

export const requestKey = (ref: { forge: string; host: string; project: string; iid: string }) =>
  JSON.stringify([ref.forge, ref.host, ref.project.toLowerCase(), ref.iid]);

// Whether an error says the session doesn't exist, which ends its delivery.
export const missingSession = (error: unknown) =>
  (error as { _tag?: unknown } | null)?._tag === 'SessionNotFoundError' ||
  /session not found/i.test(error instanceof Error ? error.message : String(error));

export async function scanAll(storage: Plugin.Context['storage'], prefix: string) {
  const entries: { key: string; value: unknown }[] = [];
  let after: string | undefined;
  do {
    const page = await storage.scan({ prefix, ...(after ? { after } : {}) });
    entries.push(...page.entries);
    after = page.next;
  } while (after);
  return entries;
}

export function buildStoredTargetsMap(entries: Array<{ key: string; value: unknown }>) {
  const map = new Map<string, readonly Target[]>();
  for (const { key, value } of entries) {
    const sessionID = key.slice('sessions/'.length);
    const record = value as { targets?: Target[] } | undefined;
    map.set(sessionID, Array.isArray(record?.targets) ? record.targets : []);
  }
  return map;
}

export async function readSession(
  ctx: Plugin.Context,
  sessionID: string,
): Promise<ListedSession | undefined> {
  try {
    return (await ctx.session.get({ sessionID })) as ListedSession | undefined;
  } catch (error) {
    if (missingSession(error)) return undefined;
    throw error;
  }
}

export async function sessionOwnership(
  ctx: Plugin.Context,
  directory: string,
  sessionIDs: readonly string[],
) {
  const here: string[] = [];
  const deleted: string[] = [];
  await Promise.all(
    sessionIDs.map(async (sessionID) => {
      try {
        const session = await ctx.session.get({ sessionID });
        if (!session) deleted.push(sessionID);
        else if (session.location.directory === directory) here.push(sessionID);
      } catch (error) {
        if (missingSession(error)) deleted.push(sessionID);
      }
    }),
  );
  return { here, deleted };
}

export function createViewerIDLookup(
  deps: {
    exec: Exec;
    viewerID?: (ref: NonNullable<ReturnType<typeof parseUrl>>) => Promise<string | undefined>;
  },
  directory: string,
) {
  const viewerIDs = new Map<string, Promise<string | undefined>>();
  return (url: string) => {
    const ref = parseUrl(url);
    if (!ref) return Promise.resolve(undefined);
    const key = `${ref.forge}:${ref.host}`;
    const existing = viewerIDs.get(key);
    if (existing) return existing;
    const task = Promise.resolve()
      .then(() =>
        deps.viewerID
          ? deps.viewerID(ref)
          : traitsOf(ref).feedback?.viewerID?.(deps.exec, directory, ref.host),
      )
      .then((id) => {
        if (!id) viewerIDs.delete(key);
        return id;
      })
      .catch((error) => {
        viewerIDs.delete(key);
        throw error;
      });
    viewerIDs.set(key, task);
    return task;
  };
}

export type FreshLookup = { live: ReviewRequest | undefined; fetchedAt: number };

export function createApprovalRevalidator(options: {
  settings: StatusOptions;
  forges: ForgeCatalog;
  directory: string;
  now?: () => number;
  reconcileApproval: (sessionID: string, live: ReviewRequest, fetchedAt: number) => Promise<void>;
  pruneInbox: (predicate: (entry: FeedbackItem) => boolean) => Promise<unknown>;
}) {
  const { settings, forges, directory, now = Date.now, reconcileApproval, pruneInbox } = options;
  const automationRules = settings.automation.rules;
  const activeReviewBots = settings.watch.reviewBots ? settings.reviewBots : {};

  const watchesApprover = (url: string, approver: ReviewerApproval) => {
    if (approver.automated) return settings.watch.automatedReviews;
    if (approver.bot) {
      const hostName = parseUrl(url)?.host;
      return !!hostName && matchesReviewBot(activeReviewBots, hostName, approver.username);
    }
    return settings.watch.humanReviews;
  };

  const watchesApprovalItem = (item: FeedbackItem) => {
    if (item.approverKind === 'automated') return settings.watch.automatedReviews;
    if (item.approverKind === 'bot') {
      const hostName = parseUrl(item.url)?.host;
      return (
        !!hostName &&
        !!item.reviewers?.some((name) => matchesReviewBot(activeReviewBots, hostName, name))
      );
    }
    if (item.approverKind === 'human') return settings.watch.humanReviews;
    return false;
  };

  async function freshRequest(url: string): Promise<ReviewRequest | undefined> {
    const ref = parseUrl(url);
    const forge = ref && forges.forHost(ref.host, directory);
    if (!ref || !forge) return undefined;
    return forge.findByNumber([{ host: ref.host, path: ref.project }], ref.iid);
  }

  let freshBatch: Map<string, Promise<FreshLookup>> | undefined;
  const recentSelectionFresh = new Map<string, FreshLookup>();

  async function loadFreshApproval(item: FeedbackItem, shareBatch: boolean): Promise<FreshLookup> {
    if (shareBatch) {
      const reused = recentSelectionFresh.get(item.id);
      if (reused) {
        recentSelectionFresh.delete(item.id);
        return reused;
      }
      const ref = parseUrl(item.url);
      if (freshBatch && ref) {
        const key = requestKey(ref);
        let pending = freshBatch.get(key);
        if (!pending) {
          const fetchedAt = now();
          pending = freshRequest(item.url).then((live) => ({ live, fetchedAt }));
          freshBatch.set(key, pending);
        }
        return pending;
      }
    }
    const fetchedAt = now();
    return { live: await freshRequest(item.url), fetchedAt };
  }

  const mayAutomateApproval = (item: FeedbackItem): boolean => {
    if (item.approverKind === 'human') return false;
    if (!item.automationAllowed) return false;
    if (item.automation) return false;
    if (!watchesApprovalItem(item)) return false;
    const ref = parseUrl(item.url);
    return !!ref && matchesApprovalRule(automationRules, ref, item.reviewers);
  };

  // Revalidates an approval item against live uncached forge state before
  // delivery, automation, or manual summary. Revoked approvals or closed
  // PRs/MRs reconcile the watcher baseline and are pruned immediately.
  async function revalidateApproval(
    item: FeedbackItem,
    {
      checkWatch = true,
      shareBatch = false,
      stashForNotify = false,
    }: { checkWatch?: boolean; shareBatch?: boolean; stashForNotify?: boolean } = {},
  ): Promise<
    | { state: 'valid'; item: FeedbackItem; fresh?: FreshLookup }
    | { state: 'stale' | 'defer' | 'unwatched' }
  > {
    if (checkWatch && !watchesApprovalItem(item)) return { state: 'unwatched' };
    const fresh = await loadFreshApproval(item, shareBatch);
    const { live, fetchedAt } = fresh;
    if (!live || settledFeedback(item, { kind: 'found', requests: [live] })) {
      if (live) await reconcileApproval(item.sessionID, live, fetchedAt).catch(() => {});
      await pruneInbox((entry) => entry.id === item.id);
      return { state: 'stale' };
    }
    if (!approvalsComplete(live)) return { state: 'defer' };
    const matching = approversOf(live).filter((approver) => matchesApproval(item, approver));
    if (checkWatch && !matching.some((approver) => watchesApprover(live.url, approver)))
      return { state: 'unwatched' };
    const details = approvalDetails(live);
    return {
      state: 'valid',
      item: { ...item, ...(details.length ? { details } : { details: undefined }) },
      ...(stashForNotify ? { fresh } : {}),
    };
  }

  const canActItem = (item: FeedbackItem): boolean => {
    if (item.humanApprovalOnly) return false;
    if (isApproval(item)) {
      if (item.approverKind === 'human') return false;
      if (!watchesApprovalItem(item)) return false;
      const ref = parseUrl(item.url);
      return !!ref && matchesApprovalRule(automationRules, ref, item.reviewers);
    }
    if (item.kind && !isJobFailure(item)) return false;
    return true;
  };

  const decorateInbox = (state: InboxState): InboxState => ({
    ...state,
    items: state.items.map((item) => ({ ...item, canAct: canActItem(item) })),
  });

  async function withFreshBatch<T>(work: () => Promise<T>): Promise<T> {
    const ownsBatch = !freshBatch;
    if (ownsBatch) freshBatch = new Map();
    try {
      return await work();
    } finally {
      if (ownsBatch) {
        freshBatch = undefined;
        recentSelectionFresh.clear();
      }
    }
  }

  function stashFreshSelection(item: FeedbackItem, fresh: FreshLookup | undefined) {
    if (
      fresh &&
      item.notifiedAt === undefined &&
      item.delivery &&
      settings.delivery.reviews !== 'inbox'
    ) {
      recentSelectionFresh.set(item.id, fresh);
    }
  }

  return {
    watchesApprover,
    watchesApprovalItem,
    freshRequest,
    mayAutomateApproval,
    revalidateApproval,
    decorateInbox,
    withFreshBatch,
    stashFreshSelection,
  };
}

export async function runSessionCleanupCandidates(options: {
  ctx: Plugin.Context;
  projectID: string | undefined;
  directory: string;
  forges: ForgeCatalog;
  scanID?: string;
  signal?: AbortSignal;
  storedTargets: (sessionID: string) => Promise<Target[]>;
  inboxList: () => Promise<InboxState>;
  cleanupProgress?: (progress: CleanupProgress) => void;
}): Promise<CleanupScanResult> {
  const { ctx, projectID, directory, forges, scanID, signal, storedTargets, inboxList } = options;
  const foreignInboxes = new Map<string, Promise<InboxState | undefined>>();
  const listFn = (ctx.session as { list?: (input: unknown) => Promise<SessionPage> }).list?.bind(
    ctx.session,
  );
  const emitProgress = (progress: CleanupProgressEvent) => {
    options.cleanupProgress?.({
      ...(scanID ? { scanID } : {}),
      ...progress,
    });
  };
  let scannedSessionsPromise: Promise<Array<{ key: string; value: unknown }>> | undefined;
  const getScannedSessions = () => (scannedSessionsPromise ??= scanAll(ctx.storage, 'sessions/'));
  return scanCleanupCandidates({
    projectID,
    directory,
    forges,
    signal,
    onProgress: emitProgress,
    listSessions: () =>
      listProjectSessions({
        projectID,
        directory,
        list: listFn ? (input) => listFn(input) : undefined,
        scanTargets: async () =>
          (await getScannedSessions()).map(({ key }) => key.slice('sessions/'.length)),
        getSession: (sessionID) => readSession(ctx, sessionID),
        signal,
        onProgress: (checked) => emitProgress({ phase: 'sessions', checked, total: 0 }),
      }),
    storedTargets,
    storedTargetsMap: async () => buildStoredTargetsMap(await getScannedSessions()),
    pendingFeedbackCount: async (sessionDirectory, sessionID) => {
      if (sessionDirectory === directory) {
        return sessionItems(await inboxList(), sessionID).length;
      }
      let loading = foreignInboxes.get(sessionDirectory);
      if (!loading) {
        loading = ctx.storage.get(`feedback-inbox/${encodeURIComponent(sessionDirectory)}`).then(
          (value) => value as InboxState | undefined,
          () => undefined,
        );
        foreignInboxes.set(sessionDirectory, loading);
      }
      const state = await loading;
      return state ? sessionItems(state, sessionID).length : 0;
    },
  });
}

export async function runSessionCleanup(options: {
  ctx: Plugin.Context;
  projectID: string | undefined;
  directory: string;
  forges: ForgeCatalog;
  now?: () => number;
  sessionIDs: readonly string[];
  scanID?: string;
  allowClientArchive?: boolean;
  finalizeArchived?: boolean;
  forge?: () => Promise<ForgeKind | undefined>;
  storedTargets: (sessionID: string) => Promise<Target[]>;
  invalidateService: (sessionID: string) => void;
  forgetReviews: (sessionID: string) => void;
  retireApprovals: (sessionID: string) => Promise<void>;
  forgetCleanupWatch: (sessionID: string) => Promise<void>;
  pruneInbox: (predicate: (item: FeedbackItem) => boolean) => Promise<unknown>;
  refreshDiscovery: (sessionID: string) => Promise<void>;
  feedbackChanged?: (directory?: string) => void;
  sessionsCleanedUp?: (sessionIDs: string[], options?: { archive?: boolean }) => void;
  cleanupProgress?: (progress: CleanupProgress) => void;
}): Promise<CleanupResult> {
  const { ctx, projectID, directory, forges, sessionIDs, scanID } = options;
  const emitProgress = (progress: CleanupProgressEvent) => {
    options.cleanupProgress?.({
      ...(scanID ? { scanID } : {}),
      ...progress,
    });
  };
  const cleanedLocal = new Set<string>();
  const cleanedForeign = new Map<string, Set<string>>();
  const defaultForge = await options.forge?.();
  const result = await runCleanupSessions(sessionIDs, {
    projectID,
    directory,
    forges,
    ...(defaultForge ? { defaultForge } : {}),
    getSession: (sessionID) => readSession(ctx, sessionID),
    archiveSession: async (sessionID) => {
      const updated = (await ctx.session.update({ sessionID, archived: true })) as
        ListedSession | undefined;
      if (updated?.time?.archived !== undefined) return 'archived';
      const verified = await readSession(ctx, sessionID);
      if (verified?.time?.archived !== undefined) return 'archived';
      return 'unsupported';
    },
    storedTargets: options.storedTargets,
    storedTargetsMap: async () => buildStoredTargetsMap(await scanAll(ctx.storage, 'sessions/')),
    allowClientArchive: options.allowClientArchive,
    finalizeArchived: options.finalizeArchived,
    onProgress: emitProgress,
    onSessionCleaned: async (sessionID, sessionDirectory) => {
      options.invalidateService(sessionID);
      options.forgetReviews(sessionID);
      cleanedLocal.add(sessionID);
      if (sessionDirectory !== directory) {
        let set = cleanedForeign.get(sessionDirectory);
        if (!set) {
          set = new Set();
          cleanedForeign.set(sessionDirectory, set);
        }
        set.add(sessionID);
      }
      await Promise.all([
        options.retireApprovals(sessionID).catch(() => {}),
        options.forgetCleanupWatch(sessionID),
      ]);
    },
  });
  if (cleanedLocal.size > 0) {
    await Promise.all([
      options.pruneInbox((item) => cleanedLocal.has(item.sessionID)).catch(() => {}),
      ...[...cleanedForeign.entries()].map(([foreignDirectory, ids]) =>
        pruneForeignInboxSession({
          storage: ctx.storage,
          directory: foreignDirectory,
          sessionIDs: ids,
          now: options.now,
          changed: (dir) => options.feedbackChanged?.(dir),
        }).catch(() => {}),
      ),
    ]);
    for (const sessionID of cleanedLocal) {
      void options.refreshDiscovery(sessionID);
    }
  }
  if (result.archived.length) options.sessionsCleanedUp?.(result.archived);
  return result;
}
