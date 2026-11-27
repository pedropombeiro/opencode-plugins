import type { Plugin } from '@opencode/plugin';
import { automatedReview } from './automated-review-watch';
import { closedFeedback, resolvedFeedback, settledFeedback } from './feedback-cleanup';
import { createFeedbackDiscovery, DISCOVERY_INTERVAL } from './feedback-discovery';
import {
  createFeedbackInbox,
  isApproval,
  isLifecycle,
  type FeedbackItem,
  type InboxState,
} from './feedback-inbox';
import { createFeedbackSubscriptions, RECONCILE_INTERVAL } from './feedback-subscriptions';
import type {
  FeedbackSnapshot,
  ForgeKind,
  IssueSnapshot,
  ReviewRequest,
  ReviewRequestHistory,
} from './forge';
import {
  forgeScope,
  parseReference,
  parseUrl,
  requestFullNoun,
  requestNoun,
  traitsOf,
  type ForgeCatalog,
} from './forges';
import { FETCH_INTERVAL } from './human-review-watch';
import { investigatesJobs, isJobFailure } from './job-investigation';
import { createLifecycleNotifications } from './lifecycle-notifications';
import {
  linkedOwner,
  PRESENCE_INTERVAL,
  presenceKey,
  type DirectorySession,
  type Presence,
} from './linked-session';
import { locate } from './locate';
import type { MonitoringStatus } from './monitoring-status';
import type { StatusOptions } from './options';
import { createRequestCache } from './request-cache';
import {
  automationReviewers,
  createReviewAutomation,
  matchesApprovalRule,
  modelKey,
} from './review-automation';
import {
  createAutomationHost,
  type AutomationDependencies,
  type MarkReadyInvocation,
} from './review-automation-host';
import { createReviewMonitoring } from './review-monitoring';
import { APPROVAL_TOOLS } from './review-preparation';
import { REQUEST_INTERVAL } from './review-request-watch';
import type { CleanupProgress, Notice } from './rpc';
import {
  cleanupWatchKey,
  createCleanupWatch,
  resolveLookupCleanupReady,
  splitCleanupTargets,
  type CleanupResult,
  type CleanupScanResult,
  type CleanupWatchRecord,
} from './session-cleanup';
import {
  createApprovalRevalidator,
  createViewerIDLookup,
  drain,
  DRAIN_TIME,
  missingSession,
  requestKey,
  REVIEW_POLL_SECONDS,
  runSessionCleanup,
  runSessionCleanupCandidates,
  scanAll,
  sessionOwnership,
} from './status-server-helpers';
import { createStatusService, HOME } from './status-service';
import type { Snapshot } from './store';
import { createSummaryDelivery, type SummaryDependencies } from './summary-delivery';
import { classifyTargets, includesRequest, targetOutput, type Target } from './target';

export interface StatusDependencies extends SummaryDependencies, AutomationDependencies {
  // Forges and commands for status lookups and feedback, which share one
  // concurrency limit.
  forges: ForgeCatalog;
  // Reads a PR/MR's review comments. Defaults to its forge's feedback reader.
  feedback?: (request: ReviewRequest, directory: string) => Promise<FeedbackSnapshot | undefined>;
  // Reads the requests for your review in a PR/MR's history. Defaults to its
  // forge's reader.
  reviewRequests?: (
    request: ReviewRequest,
    directory: string,
  ) => Promise<ReviewRequestHistory | undefined>;
}

export interface StatusHost {
  state: (sessionID: string) => Promise<{ targets: Target[] }>;
  // The stored targets, without updating what `isTarget` knows, for reads
  // that must not change monitoring, such as diagnostics.
  storedTargets: (sessionID: string) => Promise<Target[]>;
  isTarget: (sessionID: string, url: string) => boolean;
  publish: (key: string, snapshot: Snapshot) => void;
  notice: (notice: Notice) => void;
  forge?: () => Promise<ForgeKind | undefined>;
  feedbackChanged?: (directory?: string) => void;
  sessionsCleanedUp?: (sessionIDs: string[], options?: { archive?: boolean }) => void;
  cleanupProgress?: (progress: CleanupProgress) => void;
}

// Watches the PRs/MRs of the sessions that CLIs show, and tells sessions
// about reviews of their targets.
export async function setupStatus(
  ctx: Plugin.Context,
  settings: StatusOptions,
  deps: StatusDependencies,
  host: StatusHost,
) {
  const directory = ctx.location.directory;
  const projectID = (ctx.location as { project?: { id?: string } }).project?.id;
  const statusCache = createRequestCache<ReviewRequest | undefined>({
    now: deps.now,
    classify: (request) => (request ? 'usable' : 'unavailable'),
    ttl: (request) =>
      Math.min(
        settings.pollSeconds,
        request && automatedReview(request)?.state === 'running'
          ? REVIEW_POLL_SECONDS
          : settings.pollSeconds,
      ) * 1000,
  });
  const issueCache = createRequestCache<IssueSnapshot | undefined>({
    now: deps.now,
    classify: (issue) => (issue ? 'usable' : 'unavailable'),
    ttl: () => settings.pollSeconds * 1000,
  });
  const feedbackCache = createRequestCache<FeedbackSnapshot | undefined>({
    now: deps.now,
    ttl: (snapshot) => (snapshot?.complete ? FETCH_INTERVAL : 0),
    classify: (snapshot) => {
      if (!snapshot) return 'unavailable';
      return snapshot.complete ? 'usable' : 'incomplete';
    },
  });
  const requestCache = createRequestCache<ReviewRequestHistory | undefined>({
    now: deps.now,
    ttl: (history) => (history?.complete ? REQUEST_INTERVAL : 0),
    classify: (history) => {
      if (!history) return 'unavailable';
      return history.complete ? 'usable' : 'incomplete';
    },
  });
  // Cleanup runs in two steps. `closing` is set first: no new fetch or
  // delivery starts, so a check that finishes later, such as a feedback
  // fetch, can't tell a session anything. Deliveries that already started
  // can still finish and store their outcome, so the replacement instance
  // doesn't send them again. `closed` is set once those have drained, and
  // stops every write and toast.
  let closing = false;
  let closed = false;
  // Sessions that moved to another checkout. That checkout's instance
  // watches them, even if a CLI still leases them here.
  const foreign = new Set<string>();
  let invalidate: (sessionID: string) => void = () => {};

  const approvalRevalidator = createApprovalRevalidator({
    settings,
    forges: deps.forges,
    directory,
    now: deps.now,
    reconcileApproval: (sessionID, live, fetchedAt) =>
      reviews.reconcileApproval(sessionID, live, fetchedAt),
    pruneInbox: (predicate) => inbox.prune(predicate),
  });
  const {
    watchesApprover,
    watchesApprovalItem,
    freshRequest,
    mayAutomateApproval,
    revalidateApproval,
    decorateInbox,
  } = approvalRevalidator;

  const inbox = createFeedbackInbox({
    initiallyPaused: !settings.inbox && !settings.automation.rules.length,
    select: async (item) => {
      if (isApproval(item)) {
        if (item.automation) return item.automation.state !== 'skipped';
        if (!mayAutomateApproval(item)) return false;
        const checked = await revalidateApproval(item, {
          checkWatch: true,
          shareBatch: true,
          stashForNotify: true,
        });
        if (checked.state !== 'valid') return true;
        const selected = await automation.selectAutomatic(checked.item);
        if (!selected) approvalRevalidator.stashFreshSelection(item, checked.fresh);
        return selected;
      }
      return automation.selectAutomatic(item);
    },
    read: async () =>
      (await ctx.storage.get(`feedback-inbox/${encodeURIComponent(directory)}`)) as
        InboxState | undefined,
    write: async (state) => {
      if (closed) throw new Error('The plugin stopped');
      await ctx.storage.set(`feedback-inbox/${encodeURIComponent(directory)}`, state as never);
    },
    changed: () => host.feedbackChanged?.(),
    now: deps.now,
    // An update reaches its session in the mode it was recorded in, so changing
    // the mode affects only later updates. Turning a kind's delivery off stops
    // its retries, and leaves the other kind's alone.
    ...(settings.delivery.reviews === 'inbox' && settings.delivery.lifecycle === 'inbox'
      ? {}
      : {
          notify: async (item) => {
            if (isApproval(item)) {
              const checked = await revalidateApproval(item, {
                checkWatch: true,
                shareBatch: true,
              });
              if (checked.state === 'stale' || checked.state === 'unwatched') return;
              if (checked.state === 'defer')
                throw new Error('Approval status is incomplete; will retry');
              if (checked.state === 'valid') await summaries.deliver(checked.item);
              return;
            }
            await summaries.deliver(item);
          },
          enabled: (item) =>
            (isLifecycle(item) ? settings.delivery.lifecycle : settings.delivery.reviews) !==
            'inbox',
        }),
  });

  // Delivery work in progress, which cleanup waits for like watcher work, so
  // it can't overlap the replacement instance.
  const deliveries = new Set<Promise<unknown>>();
  const tracked = <T>(task: Promise<T>): Promise<T> => {
    deliveries.add(task);
    void task.then(
      () => deliveries.delete(task),
      () => deliveries.delete(task),
    );
    return task;
  };

  // Whether the session's latest lookup says a conflict, failed pipeline,
  // request for changes, or approval no longer stands. Without a lookup of
  // the PR/MR, the update counts as current, and merge updates always do.
  function settled(
    item: Pick<
      FeedbackItem,
      | 'sessionID'
      | 'url'
      | 'kind'
      | 'pipeline'
      | 'reviewers'
      | 'approverID'
      | 'approvalToken'
      | 'approverKind'
    >,
  ): boolean {
    return settledFeedback(item, service.get(item.sessionID).lookup);
  }

  // Whether the update may still reach its session: the session exists here,
  // isn't archived, and still targets the PR/MR. Rejects only for failures
  // worth retrying, such as a session that can't be read right now.
  async function deliverable(item: FeedbackItem): Promise<boolean> {
    if (closing) throw new Error('The plugin stopped');
    let session;
    try {
      session = await ctx.session.get({ sessionID: item.sessionID });
    } catch (error) {
      if (missingSession(error)) return false;
      throw error;
    }
    if (!session || session.time?.archived !== undefined) return false;
    if (session.location.directory !== directory) return false;
    // A linked session runs turns for its owner, which gets the updates.
    if (linkedOwner(session as DirectorySession)) return false;
    if (settled(item)) return false;
    const targets = (await host.state(item.sessionID)).targets;
    if (closing) throw new Error('The plugin stopped');
    return includesRequest(targets, item.url);
  }

  // Retries the updates that haven't reached their sessions, sharing one fresh
  // forge lookup per target across items handled in the same pass.
  const notifyPending = () =>
    tracked(
      approvalRevalidator
        .withFreshBatch(() => inbox.notifyPending())
        .catch((error) =>
          reportOnce('notification', 'Could not post review updates to sessions', error),
        ),
    );

  // Clears the PR/MR's updates whose comments are all resolved. A comment the
  // snapshot doesn't list, such as one outside its window, isn't resolved.
  function clearResolved(url: string, snapshot: FeedbackSnapshot | undefined) {
    if (closing || !snapshot?.complete) return;
    void inbox
      .prune(resolvedFeedback(url, snapshot))
      .catch((error) => reportOnce('inbox', 'Could not clear resolved review updates', error));
  }

  // Clears a session's updates for PRs/MRs that merged or closed, or that it no
  // longer targets, and updates that no longer stand. A merge event stays
  // until it's acknowledged, since the merge is its news. Only a finished lookup in this
  // instance says so: before one, such as right after a reload, the targets
  // aren't known yet.
  function clearStale(sessionID: string, snapshot: Snapshot) {
    if (closing || sessionID === HOME || foreign.has(sessionID)) return;
    if (snapshot.loading || snapshot.fetchedAt === undefined || !snapshot.lookup) return;
    const closed = closedFeedback(snapshot.lookup);
    void inbox
      .prune(
        (item) =>
          item.sessionID === sessionID &&
          (!host.isTarget(sessionID, item.url) || closed(item) || settled(item)),
      )
      .catch((error) => reportOnce('inbox', 'Could not clear stale review updates', error));
  }

  // Storage writes run one at a time, so a record's read and write can't
  // interleave with another change to it. A failed write only risks a
  // repeated notification, so it's reported once and otherwise ignored.
  let writes = Promise.resolve();
  const write = (task: () => Promise<void>) => {
    if (closed) return;
    writes = writes
      .then(task)
      .catch((error) => reportOnce('storage', 'Could not store review state', error));
  };

  const scanStorage = (prefix: string) => scanAll(ctx.storage, prefix);

  // While closing, a delivery that finishes still toasts, but failures, such
  // as deliveries that cleanup stopped, don't.
  const notice = (value: Notice) => {
    if (closed || (closing && value.variant === 'error')) return;
    host.notice(value);
  };

  const isTarget = (sessionID: string, url: string) =>
    !closing && !foreign.has(sessionID) && host.isTarget(sessionID, url);

  function markForeign(sessionID: string) {
    if (foreign.has(sessionID)) return;
    foreign.add(sessionID);
    reviews.forget(sessionID);
    invalidate(sessionID);
  }

  // Reports a failure once per kind, so a persistent problem doesn't toast on every poll.
  const reported = new Set<string>();
  const reportOnce = (kind: string, prefix: string, error: unknown) => {
    if (reported.has(kind)) return;
    reported.add(kind);
    const reason = error instanceof Error ? error.message : String(error);
    notice({ message: `${prefix}: ${reason}`, variant: 'error' });
  };

  const summaries = createSummaryDelivery(ctx, deps, {
    closing: () => closing,
    inbox: inbox.list,
    deliverable,
    scan: scanStorage,
    write,
    report: (error) => reportOnce('summary', 'Could not restore review summary turns', error),
  });

  const automationRules = settings.automation.rules;
  const automationController = new AbortController();
  const automationHost = createAutomationHost(ctx, deps, {
    rules: automationRules,
    relay: summaries.relay,
    closing: () => closing,
    inbox,
    deliverable,
    readFeedback: (request, cwd) => readFeedback(request, cwd),
    scan: scanStorage,
    missingSession,
    redeliver: () => void notifyPending(),
    report: (error) =>
      reportOnce('review-automation', 'Could not coordinate review automation', error),
    warn: (message) => notice({ message, variant: 'error' }),
    watchesApprover,
    watchesApprovalItem,
    markedReady: (ref) => statusCache.invalidate(requestKey(ref)),
    sessionsCleanedUp: (sessionIDs, options) => host.sessionsCleanedUp?.(sessionIDs, options),
    signal: automationController.signal,
  });
  const automation = createReviewAutomation(automationHost.host);

  async function currentReviews(
    sessionID: string,
    requests: ReviewRequest[],
  ): Promise<ReviewRequest[]> {
    if (closing) throw new Error('The plugin stopped');
    const session = await ctx.session.get({ sessionID });
    if (session.location.directory !== directory) {
      markForeign(sessionID);
      return [];
    }
    if (session.time?.archived !== undefined) return [];
    if ((await inbox.list()).paused) throw new Error('Feedback monitoring is paused');
    if (closing) throw new Error('The plugin stopped');
    return requests.filter((request) => isTarget(sessionID, request.url));
  }

  // An update the inbox has, but couldn't post to its session. The inbox
  // retries it with the other pending updates. One that a pause holds back
  // waits for monitoring to resume, which isn't a failure.
  const deliveryFailed = async (sessionID: string, error: unknown) => {
    if (
      await inbox.list().then(
        (state) => state.paused,
        () => false,
      )
    )
      return;
    const reason = error instanceof Error ? error.message : String(error);
    notice({
      sessionID,
      message: `Could not post an update to the session: ${reason}. It stays in /forge-feedback, and is retried every minute.`,
      variant: 'error',
    });
  };

  const record = async (
    item: FeedbackItem,
    supersedes?: (entry: FeedbackItem) => boolean,
    accept?: () => boolean,
  ): Promise<boolean> => {
    const ref = parseUrl(item.url);
    if (
      ref &&
      !item.humanApprovalOnly &&
      (item.kind
        ? (isJobFailure(item) && investigatesJobs(automationRules, ref)) ||
          (isApproval(item) &&
            item.approverKind !== 'human' &&
            matchesApprovalRule(automationRules, ref, item.reviewers))
        : automationReviewers(automationRules, ref).length)
    )
      item = { ...item, automationAllowed: true };
    const { recorded, delivery } = await inbox.record(
      item,
      supersedes,
      accept ? () => accept() && !settled(item) : undefined,
    );
    void tracked(delivery.catch((error) => deliveryFailed(item.sessionID, error)));
    return recorded;
  };

  const readFeedback =
    deps.feedback ??
    (async (request: ReviewRequest, cwd: string) =>
      traitsOf(request).feedback?.fetch(deps.exec, cwd, request));
  const readRequests =
    deps.reviewRequests ??
    (async (request: ReviewRequest, cwd: string) =>
      traitsOf(request).feedback?.reviewRequests?.(deps.exec, cwd, request));

  const feedbackEvents = new Map<string, ReturnType<typeof setTimeout>>();
  const subscriptions = createFeedbackSubscriptions({
    exec: deps.exec,
    directory,
    changed(url) {
      if (closing || feedbackEvents.has(url)) return;
      feedbackEvents.set(
        url,
        setTimeout(() => {
          feedbackEvents.delete(url);
          if (closing) return;
          const ref = parseUrl(url);
          if (ref) {
            feedbackCache.invalidate(requestKey(ref));
            requestCache.invalidate(requestKey(ref));
          }
          service.checkFeedback(url, reviews.invalidate);
        }, 1000),
      );
    },
  });

  async function sessionTargets(sessionID: string, url: string) {
    if (closing) throw new Error('The plugin stopped');
    let session;
    try {
      session = await ctx.session.get({ sessionID });
    } catch (error) {
      if (missingSession(error)) return undefined;
      throw error;
    }
    if (!session || session.time?.archived !== undefined) return undefined;
    if (session.location.directory !== directory)
      throw new Error('The session moved to another checkout');
    if ((await inbox.list()).paused) throw new Error('Feedback monitoring is paused');
    const targets = (await host.state(sessionID)).targets;
    return includesRequest(targets, url) ? targets : undefined;
  }

  const checkSessionOwnership = (sessionIDs: readonly string[]) =>
    sessionOwnership(ctx, directory, sessionIDs);

  const viewerIDFor = createViewerIDLookup(deps, directory);

  const pruneDeletedSessions = async (sessionIDs: readonly string[]) => {
    if (!sessionIDs.length) return;
    const deleted = new Set(sessionIDs);
    await inbox.prune((item) => deleted.has(item.sessionID));
  };

  const reviews = createReviewMonitoring(
    ctx.storage,
    settings,
    {
      current: currentReviews,
      isTarget,
      targets: sessionTargets,
      storedTargets: host.storedTargets,
      sessionOwnership: checkSessionOwnership,
      onSessionsDeleted: pruneDeletedSessions,
      receipts: inbox.receipts,
      releaseReceipts: inbox.releaseReceipts,
      retainReceipts: inbox.retainReceipts,
      fresh: freshRequest,
      closing: () => closing,
      viewerID: viewerIDFor,
      fetch: async (request) => {
        if (closing) return undefined;
        const ref = parseUrl(request.url);
        return ref
          ? feedbackCache.get(requestKey(ref), () => readFeedback(request, directory))
          : readFeedback(request, directory);
      },
      reviewRequests: async (request) => {
        if (closing) return undefined;
        const ref = parseUrl(request.url);
        return ref
          ? requestCache.get(requestKey(ref), () => readRequests(request, directory))
          : readRequests(request, directory);
      },
      interval: (request) =>
        subscriptions.connected(request.url) ? RECONCILE_INTERVAL : FETCH_INTERVAL,
      accepted: clearResolved,
      scan: scanStorage,
      write,
      record,
      notice,
      error: (error) =>
        void Promise.resolve(host.forge?.()).then((forge) =>
          reportOnce(
            'feedback-fetch',
            `Could not check ${requestNoun(forge)} review feedback`,
            error,
          ),
        ),
      approvalError: (error) => reportOnce('approvals', 'Could not record review approvals', error),
    },
    deps.now,
  );
  const retryApprovals = () =>
    reviews.approvals ? tracked(reviews.approvals.retry()) : Promise.resolve();

  const lifecycle = createLifecycleNotifications(ctx, settings, deps, {
    targets: sessionTargets,
    storedTargets: host.storedTargets,
    closing: () => closing,
    scan: scanStorage,
    record: async (item, supersedes) => {
      await record(item, supersedes);
    },
    notice,
    error: (error) =>
      void Promise.resolve(host.forge?.()).then((forge) =>
        reportOnce('lifecycle', `Could not record ${requestFullNoun(forge)} changes`, error),
      ),
  });
  const retryLifecycle = () =>
    lifecycle.watcher ? tracked(lifecycle.watcher.retry()) : Promise.resolve();
  const retryEvents = () =>
    tracked(
      inbox
        .list()
        .then((state) => {
          if (closing || state.paused) return;
          return Promise.all([retryLifecycle(), retryApprovals()]).then(() => {});
        })
        .catch(() => {}),
    );

  const cleanupWatch = createCleanupWatch({
    read: async (sessionID) =>
      (await ctx.storage.get(cleanupWatchKey(sessionID))) as CleanupWatchRecord | undefined,
    write: async (record) => {
      if (closed) throw new Error('The plugin stopped');
      await ctx.storage.set(cleanupWatchKey(record.sessionID), record as never);
    },
    remove: async (sessionID) => {
      if (closed) return;
      await ctx.storage.remove(cleanupWatchKey(sessionID));
    },
    scan: scanStorage,
    hasTargets: async (sessionID) => {
      const raw = await host.storedTargets(sessionID);
      const { mergeRequests, issues } = splitCleanupTargets(raw);
      return mergeRequests.length > 0 || issues.length > 0;
    },
    onReady: (sessionID, ready) =>
      notice({
        sessionID,
        title: `${ready.reason} — ready to archive`,
        message: 'Run /forge-cleanup to archive this session and close its tab.',
        variant: 'info',
        openTab: false,
      }),
    now: deps.now,
  });

  const pendingCleanupMeta = new WeakMap<object, { targetKey?: string; complete: boolean }>();

  const service = createStatusService({
    async load(key, previous) {
      if (key === HOME) return { kind: 'none', reason: 'No session is open' };
      const session = await ctx.session.get({ sessionID: key });
      if (session.time?.archived !== undefined)
        return { kind: 'none', reason: 'The session is archived' };
      if (linkedOwner(session as DirectorySession))
        return { kind: 'none', reason: 'The session runs a Forgekeeper task for another session' };
      if (session.location.directory !== directory) {
        // Not `markForeign`: invalidating would discard this very lookup.
        foreign.add(key);
        reviews.forget(key);
        return { kind: 'none', reason: 'The session moved to another checkout' };
      }
      foreign.delete(key);
      const state = await host.state(key);
      const located = await locate(deps.forges, {
        directory,
        targets: classifyTargets(targetOutput(state.targets)),
        previous,
        request: (ref, load) => statusCache.get(requestKey(ref), load),
      });
      const resolved = await resolveLookupCleanupReady(located, state.targets, (ref) => {
        const forge =
          deps.forges.kind(ref.host) === ref.forge
            ? deps.forges.forHost(ref.host, directory)
            : undefined;
        if (!forge?.issue) return Promise.resolve(undefined);
        return issueCache.get(requestKey(ref), () => forge.issue!(ref));
      });
      pendingCleanupMeta.set(resolved.lookup, {
        targetKey: resolved.targetKey,
        complete: resolved.complete,
      });
      return resolved.lookup;
    },
    isTarget,
    owns: (sessionID) => !foreign.has(sessionID),
    publish: (key, snapshot) => {
      host.publish(key, snapshot);
      clearStale(key, snapshot);
    },
    onLookup: (sessionID, lookup) => {
      if (closing || foreign.has(sessionID)) return;
      const meta = pendingCleanupMeta.get(lookup);
      if (!meta) return;
      return tracked(
        cleanupWatch
          .observe(sessionID, meta.targetKey, meta.complete, lookup.cleanupReady)
          .catch((error) =>
            reportOnce('cleanup-watch', 'Could not record session cleanup status', error),
          ),
      );
    },
    automated: reviews.automated,
    human: reviews.feedback,
    feedbackTargets: (sessionID, requests) => subscriptions.update(sessionID, requests),
    ...(lifecycle.watcher ? { lifecycle: lifecycle.watcher } : {}),
    ...(reviews.approvals ? { approvals: reviews.approvals } : {}),
    onWatchError: (error) =>
      void Promise.resolve(host.forge?.()).then((forge) =>
        reportOnce('watch', `${requestNoun(forge)} status watcher failed`, error),
      ),
    interval: settings.pollSeconds * 1000,
    activeInterval: Math.min(settings.pollSeconds, REVIEW_POLL_SECONDS) * 1000,
    now: deps.now,
  });
  invalidate = (sessionID) => service.invalidate(sessionID);
  const hasTarget = (targets: Target[]) =>
    !!classifyTargets(targetOutput(targets))?.some((target) => target.kind === 'merge-request');
  const discovery = createFeedbackDiscovery({
    directory,
    missing: missingSession,
    candidate: async (id) => hasTarget(await host.storedTargets(id)),
    candidates: async () =>
      (await scanStorage('sessions/')).flatMap(({ key, value }) => {
        const targets = (value as { targets?: Target[] }).targets ?? [];
        return hasTarget(targets) ? [key.slice('sessions/'.length)] : [];
      }),
    session: (sessionID) => ctx.session.get({ sessionID }),
    // The newest user prompt in the context. A compaction drops earlier
    // prompts from the context, so without one, the newest compaction stands
    // in: compaction runs only during a turn.
    activity: async (sessionID) => {
      const messages = await ctx.session.context({ sessionID });
      const latest = (type: string) =>
        messages.reduce<number | undefined>(
          (newest, message) =>
            message.type === type ? Math.max(newest ?? 0, message.time.created) : newest,
          undefined,
        );
      return latest('user') ?? latest('compaction');
    },
    paused: async () => (await inbox.list()).paused,
    watch: (ids) => service.discover(ids),
    error: (error) => reportOnce('discovery', 'Could not discover recent review sessions', error),
    now: deps.now,
  });
  let restored = false;
  let restoring = false;
  const restoreAutomation = async () => {
    if (restored || restoring || closing) return;
    restoring = true;
    try {
      const records = await automationHost.restorable();
      if (!closing) automation.restore(records);
      restored = true;
    } catch (error) {
      reportOnce('automation-restore', 'Could not restore automation attempts; will retry', error);
    } finally {
      restoring = false;
    }
  };
  void tracked(restoreAutomation());
  void inbox
    .list()
    .then(async (state) => {
      if (closing) return;
      service.pauseFeedback(state.paused);
      await notifyPending();
      // Events found before a reload or a failure, such as a merge, which
      // ends polling, still go.
      if (!state.paused) await Promise.all([retryLifecycle(), retryApprovals()]);
      return discovery.refresh();
    })
    .catch((error) => reportOnce('discovery', 'Could not restore feedback monitoring', error));
  // Announces that this checkout's instance checks the turns of linked
  // sessions here, so an owning session's instance submits them only then.
  // The rules let a worktree's instance check a linked turn under the rules
  // of the instance that owns it.
  const instance = crypto.randomUUID();
  const announce = () => {
    if (closing) return;
    const presence: Presence = {
      at: (deps.now ?? Date.now)(),
      instance,
      rules: automationRules,
    };
    void ctx.storage.set(presenceKey(directory), presence as never).catch(() => {});
  };
  announce();
  const presenceTimer = setInterval(announce, PRESENCE_INTERVAL);
  // Removes the worktrees Forgekeeper created once their PRs/MRs are over.
  const sweep = () => {
    if (closing) return;
    void tracked(
      automationHost
        .sweep()
        .catch((error) => reportOnce('worktree-cleanup', 'Could not clean up worktrees', error)),
    );
  };
  sweep();
  const discoveryTimer = setInterval(() => {
    void discovery.refresh();
    sweep();
  }, DISCOVERY_INTERVAL);
  const notificationTimer = setInterval(() => {
    if (closing) return;
    if (!restored) void tracked(restoreAutomation());
    void notifyPending();
    void retryEvents();
  }, FETCH_INTERVAL);
  // Housekeeping, on the write queue so it doesn't hold up setup: removes
  // feedback records not seen for a long time and inbox items for confirmed
  // deleted sessions.
  write(async () => {
    await reviews.prune();
    await summaries.prune();
    await lifecycle.prune();
    await cleanupWatch.prune();
    const state = await inbox.list();
    if (state.items.length) {
      const { deleted } = await checkSessionOwnership([
        ...new Set(state.items.map((item) => item.sessionID)),
      ]);
      if (deleted.length) await pruneDeletedSessions(deleted);
    }
  });

  const retireSessionState = (sessionID: string) => {
    service.invalidate(sessionID);
    reviews.forget(sessionID);
    void tracked(
      Promise.all([
        reviews.retireApprovals(sessionID),
        cleanupWatch.forget(sessionID),
        inbox.prune((item) => item.sessionID === sessionID),
      ]).catch(() => {}),
    );
  };

  return {
    service,
    inbox,
    decorateInbox,
    feedbackState: async () => decorateInbox(await inbox.list()),
    discovery,
    retryPending: () => {
      statusCache.clear();
      void notifyPending();
      void retryEvents();
    },
    // Acts on an update on request, or retries one that already ran.
    async act(id: string, retry = false): Promise<InboxState> {
      const item = (await inbox.list()).items.find((item) => item.id === id);
      if (!item) throw new Error('The update is no longer in the feedback inbox');
      await automation.act(item, retry);
      return decorateInbox(await inbox.list());
    },
    // Adds the task instructions to a preparation turn's model requests, and
    // returns whether the request is one. It's checked before summaries, so
    // a summary still queued can't take over a compacted preparation turn. A
    // turn whose checks fail before its first request ends without running.
    // Each request's model must be one the turn's findings allow, so
    // switching to another model mid-turn fails the turn.
    async prepareAutomation(
      event: Parameters<typeof summaries.prepare>[0] & {
        readonly model: { providerID: string; id: string };
      },
    ): Promise<boolean> {
      // A failed substitution in a later turn leaves the placeholder, which
      // holds no task.
      const record = await automationHost.preparationFor(event.sessionID);
      if (!record) {
        await automationHost.substitutePrompt(event).catch(() => {});
        return false;
      }
      const model = modelKey(event.model);
      let started = record;
      if (record.startedAt === undefined) {
        try {
          started = await automationHost.authorizeStart(record, model);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await automation.abandon(record, reason).catch(() => {});
          throw error;
        }
      } else {
        await automationHost.authorizeContinuation(record, model);
      }
      event.system.push({ type: 'text', text: automationHost.instructions(started) });
      if (isApproval(started.item)) {
        if (event.tools) {
          for (const name of Object.keys(event.tools)) {
            if (!APPROVAL_TOOLS.has(name)) delete event.tools[name];
          }
        }
      } else {
        if (event.tools) {
          for (const name of APPROVAL_TOOLS) delete event.tools[name];
        }
        if (started.execution && event.tools) {
          delete event.tools.question;
          delete event.tools.set_session_target;
        }
      }
      // The linked session's turn can't go on without its task.
      await automationHost.substitutePrompt(event, started);
      return true;
    },
    async approvalTurn(sessionID: string): Promise<boolean> {
      try {
        const record = await automationHost.preparationFor(sessionID);
        return !!record && isApproval(record.item);
      } catch {
        try {
          const active = (await automationHost.restorable()).some(
            (record) => record.item.sessionID === sessionID && isApproval(record.item),
          );
          return active;
        } catch {
          return true;
        }
      }
    },
    approvalStatus: (sessionID: string, signal?: AbortSignal): Promise<string> =>
      tracked(automationHost.approvalStatus(sessionID, signal)),
    markApprovalReady: (invocation: MarkReadyInvocation): Promise<string> =>
      tracked(automationHost.markApprovalReady(invocation)),
    // Keeps a linked session's task in its compaction, so the summary, and
    // the requests after it, still have the findings to act on.
    async prepareCompaction(event: { sessionID: string; messages: unknown[] }) {
      const record = await automationHost.preparationFor(event.sessionID).catch(() => undefined);
      await automationHost.substitutePrompt(event, record);
    },
    prepareSummary: summaries.prepare,
    // Shows a report, such as a command's answer, in a tool-free turn.
    relay: (sessionID: string, title: string, report: string): Promise<void> =>
      tracked(summaries.relay(sessionID, title, report)),
    // Starts a summary turn for an update on request, in any delivery mode.
    summarize: (id: string): Promise<InboxState> =>
      tracked(
        (async () => {
          const state = await inbox.list();
          const item = state.items.find((entry) => entry.id === id);
          if (!item) throw new Error('The update is no longer in the feedback inbox');
          if (state.paused) throw new Error('Feedback monitoring is paused');
          let current = item;
          if (isApproval(item)) {
            const checked = await revalidateApproval(item, { checkWatch: false });
            if (checked.state === 'stale')
              throw new Error('This reviewer approval is no longer current');
            if (checked.state === 'defer')
              throw new Error('Current approval status is incomplete; try again later');
            if (checked.state === 'valid') current = checked.item;
          }
          if (!(await summaries.deliver(current, true)))
            throw new Error(
              `The update's session no longer targets this ${requestNoun(parseReference(current.url)?.ref.forge)} here`,
            );
          return decorateInbox(await inbox.list());
        })(),
      ),
    // Whether the session's current step is Forgekeeper's, whose tools and
    // permissions are refused. Tools come from a model response, so a session
    // whose latest request was Forgekeeper's counts too.
    // A preparation turn isn't one, even when a queued summary is tracked and
    // a compaction removed the turn's prompt. When that can't be told, the
    // summary's restrictions apply.
    summarizing: async (sessionID: string): Promise<boolean> =>
      (await automationHost.preparationFor(sessionID).then(Boolean, () => false))
        ? false
        : summaries.summarizing(sessionID),
    // Reads a linked note for the summary of the session's latest model
    // request, and returns a receipt. The note's text goes to that summary's
    // record, and from there only into its next request, so it never enters
    // the session's history. Rejects any link the summary doesn't list, and
    // without a summary whose request it can identify, such as after a
    // reload, rejects everything. Cleanup waits for it, and it writes nothing
    // once cleanup starts, so a stopped instance can't overwrite the record
    // its replacement uses.
    fetchLinked: (sessionID: string, input: unknown): Promise<string> =>
      tracked(summaries.fetchLinked(sessionID, input)),
    async monitoringStatus(sessionID: string): Promise<MonitoringStatus> {
      const targets = await host.storedTargets(sessionID);
      const enrollment = service.inspect(sessionID);
      const snapshot = service.get(sessionID);
      const requests = snapshot.lookup?.kind === 'found' ? snapshot.lookup.requests : [];
      return {
        enabled: true,
        directory,
        sessionID,
        discovered: enrollment.discovered,
        leased: enrollment.leased,
        polling: enrollment.polling,
        paused: enrollment.paused,
        humanFeedback: settings.watch.humanReviews,
        automatedFeedback: settings.watch.automatedReviews,
        status: {
          loading: snapshot.loading,
          ...(snapshot.fetchedAt === undefined ? {} : { fetchedAt: snapshot.fetchedAt }),
          ...(snapshot.error ? { error: snapshot.error } : {}),
        },
        targets: targets.flatMap((target) => {
          const ref = parseUrl(target.url);
          if (!ref) return [];
          const request = requests.find((request) => request.url === target.url);
          const key = requestKey(ref);
          return [
            {
              url: target.url,
              ...(request ? { state: request.state } : {}),
              feedbackWatched: enrollment.feedbackTargets.includes(target.url),
              status: statusCache.inspect(key),
              feedback: feedbackCache.inspect(key),
              subscription: subscriptions.inspect(sessionID, target.url),
            },
          ];
        }),
      };
    },
    async refresh(sessionID: string) {
      const lookup = service.get(sessionID).lookup;
      if (lookup?.kind === 'found')
        for (const request of lookup.requests) reviews.invalidate(sessionID, request);
      for (const target of (await host.state(sessionID)).targets) {
        const parsed = parseReference(target.url);
        if (!parsed) continue;
        if (parsed.issue) {
          issueCache.invalidate(requestKey(parsed.ref));
          continue;
        }
        statusCache.invalidate(requestKey(parsed.ref));
        feedbackCache.invalidate(requestKey(parsed.ref));
        requestCache.invalidate(requestKey(parsed.ref));
      }
      return service.refresh(sessionID);
    },
    cleanupCandidates: (options?: {
      scanID?: string;
      signal?: AbortSignal;
    }): Promise<CleanupScanResult> =>
      runSessionCleanupCandidates({
        ctx,
        projectID,
        directory,
        forges: deps.forges,
        scanID: options?.scanID,
        signal: options?.signal,
        storedTargets: host.storedTargets,
        inboxList: inbox.list,
        cleanupProgress: host.cleanupProgress,
      }),
    cleanupSessions: (
      sessionIDs: readonly string[],
      options?: { scanID?: string; allowClientArchive?: boolean; finalizeArchived?: boolean },
    ): Promise<CleanupResult> =>
      runSessionCleanup({
        ctx,
        projectID,
        directory,
        forges: deps.forges,
        now: deps.now,
        sessionIDs,
        scanID: options?.scanID,
        allowClientArchive: options?.allowClientArchive,
        finalizeArchived: options?.finalizeArchived,
        forge: host.forge,
        storedTargets: host.storedTargets,
        invalidateService: (sessionID) => service.invalidate(sessionID),
        forgetReviews: (sessionID) => reviews.forget(sessionID),
        retireApprovals: (sessionID) => reviews.retireApprovals(sessionID),
        forgetCleanupWatch: (sessionID) => cleanupWatch.forget(sessionID),
        pruneInbox: (predicate) => inbox.prune(predicate),
        refreshDiscovery: (sessionID) => discovery.refresh(sessionID),
        feedbackChanged: host.feedbackChanged,
        sessionsCleanedUp: host.sessionsCleanedUp,
        cleanupProgress: host.cleanupProgress,
      }),
    // Discards lookups of the old targets and looks the session up again.
    // Whether the new targets include a PR/MR is known now, so the footer
    // doesn't depend on that lookup succeeding.
    targetsChanged(sessionID: string, targets: readonly Target[]) {
      const classified = classifyTargets(targetOutput(targets)) ?? [];
      const mergeRequests = classified.flatMap((target) =>
        target.kind === 'merge-request' ? [target] : [],
      );
      service.setTargeted(
        sessionID,
        mergeRequests.length > 0,
        forgeScope(mergeRequests.map((target) => target.ref.forge)),
      );
      if (targets.length === 0) void cleanupWatch.forget(sessionID);
      // Retire dropped targets and invalidate cached status BEFORE triggering a
      // fresh lookup so re-added targets always baseline from live forge state.
      void tracked(
        reviews
          .retireApprovals(sessionID, (url) => includesRequest(targets, url))
          .catch((error) =>
            reportOnce('approvals', 'Could not clear stale approval watches', error),
          ),
      );
      for (const target of targets) {
        const parsed = parseReference(target.url);
        if (!parsed) continue;
        if (parsed.issue) issueCache.invalidate(requestKey(parsed.ref));
        else statusCache.invalidate(requestKey(parsed.ref));
      }
      service.invalidate(sessionID);
      // Updates for dropped targets go now, even for a session that nothing
      // polls, whose lookups would never report the change.
      void inbox
        .prune((item) => item.sessionID === sessionID && !includesRequest(targets, item.url))
        .catch((error) => reportOnce('inbox', 'Could not clear stale review updates', error));
      void discovery.refresh(sessionID);
    },
    // Confirmed session deletion or archiving retires approval watches and prunes inbox items.
    sessionDeleted(sessionID: string) {
      retireSessionState(sessionID);
    },
    sessionArchived(sessionID: string) {
      retireSessionState(sessionID);
    },
    // A turn may have changed a targeted PR/MR.
    turnEnded(sessionID: string) {
      statusCache.clear();
      issueCache.clear();
      feedbackCache.clear();
      requestCache.clear();
      for (const key of service.keys()) {
        const lookup = service.get(key).lookup;
        if (lookup?.kind === 'found')
          for (const request of lookup.requests) reviews.invalidate(key, request);
        service.notify(key);
      }
      void discovery.refresh(sessionID);
    },
    // Records how a session's turn ended for its running review attempts.
    executionEnded(sessionID: string, outcome: 'succeeded' | 'failed', at: number) {
      if (closing) return;
      void tracked(
        automation
          .turnEnded(sessionID, outcome, at)
          .catch((error) =>
            reportOnce('review-automation', 'Could not coordinate review automation', error),
          ),
      );
    },
    // A lookup that started before the move describes the old checkout, so
    // it's discarded. The next lookup finds out which instance owns the
    // session. Deliveries check again before they send.
    sessionMoved(sessionID: string) {
      void discovery.refresh(sessionID);
      if (service.keys().includes(sessionID)) service.invalidate(sessionID);
    },
    // Stops new work, lets started deliveries store their outcome, then stops
    // writing. A delivery that outlasts DRAIN_TIME can't store its outcome,
    // so the replacement instance may send it again.
    async dispose() {
      closing = true;
      automationController.abort();
      clearInterval(presenceTimer);
      // The replacement instance may have announced itself already.
      await ctx.storage
        .get(presenceKey(directory))
        .then((value) =>
          (value as { instance?: string } | undefined)?.instance === instance
            ? ctx.storage.remove(presenceKey(directory))
            : undefined,
        )
        .catch(() => {});
      subscriptions.dispose();
      for (const timer of feedbackEvents.values()) clearTimeout(timer);
      feedbackEvents.clear();
      statusCache.clear();
      issueCache.clear();
      feedbackCache.clear();
      requestCache.clear();
      clearInterval(discoveryTimer);
      clearInterval(notificationTimer);
      discovery.stop();
      await Promise.all([service.dispose(DRAIN_TIME), drain(deliveries, DRAIN_TIME)]);
      await drain(new Set(automation.tasks()), DRAIN_TIME);
      automationHost.close();
      closed = true;
      await writes;
    },
  };
}

export type Status = Awaited<ReturnType<typeof setupStatus>>;
