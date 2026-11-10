import type { Plugin } from '@opencode/plugin';
import { automatedReview } from './automated-review-watch';
import { createRequestCache } from './request-cache';
import { createFeedbackSubscriptions, RECONCILE_INTERVAL } from './feedback-subscriptions';
import { createFeedbackInbox, type FeedbackItem, type InboxState } from './feedback-inbox';
import { closedFeedback, resolvedFeedback, settledFeedback } from './feedback-cleanup';
import { createSummaryDelivery, type SummaryDependencies } from './summary-delivery';
import { createFeedbackDiscovery, DISCOVERY_INTERVAL } from './feedback-discovery';
import { createLifecycleNotifications } from './lifecycle-notifications';
import { createReviewMonitoring } from './review-monitoring';
import {
  automationReviewers,
  createReviewAutomation,
  modelKey,
  modelRefusal,
} from './review-automation';
import { createAutomationHost, type AutomationDependencies } from './review-automation-host';
import type { FeedbackSnapshot, ReviewRequest } from './forge';
import { parseUrl, traitsOf, type ForgeCatalog } from './forges';
import { FETCH_INTERVAL } from './human-review-watch';
import { investigatesJobs, isJobFailure } from './job-investigation';
import { locate } from './locate';
import type { StatusOptions } from './options';
import type { Notice } from './rpc';
import type { MonitoringStatus } from './monitoring-status';
import { createStatusService, HOME } from './status-service';
import type { Snapshot } from './store';
import { classifyTargets, includesRequest, targetOutput, type Target } from './target';

// Running automated reviews poll at most this often, so a finished review is
// noticed promptly.
const REVIEW_POLL_SECONDS = 30;

export interface StatusDependencies extends SummaryDependencies, AutomationDependencies {
  // Forges and commands for status lookups and feedback, which share one
  // concurrency limit.
  forges: ForgeCatalog;
  // Reads a PR/MR's review comments. Defaults to its forge's feedback reader.
  feedback?: (request: ReviewRequest, directory: string) => Promise<FeedbackSnapshot | undefined>;
}

// How long cleanup waits for running review checks before giving up. They
// can't send or write anything after cleanup starts, so this only bounds how
// long a stopped plugin keeps work around.
const DRAIN_TIME = 5_000;

// Waits for the tasks, or for `limit` milliseconds, whichever comes first.
async function drain(tasks: ReadonlySet<Promise<unknown>>, limit: number) {
  if (!tasks.size) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled([...tasks]),
    new Promise<void>((resolve) => (timer = setTimeout(resolve, limit))),
  ]);
  clearTimeout(timer);
}

export interface StatusHost {
  // The session's stored targets, and the title prefix this plugin wrote.
  state: (sessionID: string) => Promise<{ targets: Target[]; prefix?: string }>;
  // The stored targets, without updating what `isTarget` knows, for reads
  // that must not change monitoring, such as diagnostics.
  storedTargets: (sessionID: string) => Promise<Target[]>;
  isTarget: (sessionID: string, url: string) => boolean;
  publish: (key: string, snapshot: Snapshot) => void;
  notice: (notice: Notice) => void;
  feedbackChanged?: () => void;
}

// The title without the prefix this plugin wrote.
export function userTitle(
  title: string | undefined,
  prefix: string | undefined,
): string | undefined {
  if (!title || !prefix) return title;
  if (title === prefix) return '';
  return title.startsWith(`${prefix} `) ? title.slice(prefix.length + 1) : title;
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
  const requestKey = (ref: { forge: string; host: string; project: string; iid: string }) =>
    JSON.stringify([ref.forge, ref.host, ref.project, ref.iid]);
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
  const feedbackCache = createRequestCache<FeedbackSnapshot | undefined>({
    now: deps.now,
    ttl: (snapshot) => (snapshot?.complete ? FETCH_INTERVAL : 0),
    classify: (snapshot) =>
      !snapshot ? 'unavailable' : snapshot.complete ? 'usable' : 'incomplete',
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
  const inbox = createFeedbackInbox({
    select: (item) => automation.selectAutomatic(item),
    read: async () =>
      (await ctx.storage.get(`feedback-inbox/${encodeURIComponent(directory)}`)) as
        | InboxState
        | undefined,
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
          notify: async (item) => void (await summaries.deliver(item)),
          enabled: (item) =>
            (item.kind ? settings.delivery.lifecycle : settings.delivery.reviews) !== 'inbox',
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

  // Whether the session's latest lookup says a conflict or a failed pipeline
  // announced for the PR/MR is over: it no longer conflicts, its pipeline no
  // longer fails or another one replaced it, or it merged or closed. Without
  // a lookup of it, the update counts as current, and merges always do.
  function settled(item: Pick<FeedbackItem, 'sessionID' | 'url' | 'kind' | 'pipeline'>): boolean {
    return settledFeedback(item, service.get(item.sessionID).lookup);
  }

  // Whether an error says the session doesn't exist, which ends its delivery.
  const missingSession = (error: unknown) =>
    (error as { _tag?: unknown } | null)?._tag === 'SessionNotFoundError' ||
    /session not found/i.test(error instanceof Error ? error.message : String(error));

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
    if (settled(item)) return false;
    const targets = (await host.state(item.sessionID)).targets;
    if (closing) throw new Error('The plugin stopped');
    return includesRequest(targets, item.url);
  }

  // Retries the updates that haven't reached their sessions.
  const notifyPending = () =>
    tracked(
      inbox
        .notifyPending()
        .then(() => {})
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
  // longer targets, and conflicts and failed pipelines that are over. A merge
  // event stays until it's
  // acknowledged, since the merge is its news. Only a finished lookup in this
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

  async function scanAll(prefix: string) {
    const entries: { key: string; value: unknown }[] = [];
    let after: string | undefined;
    do {
      const page = await ctx.storage.scan({ prefix, ...(after ? { after } : {}) });
      entries.push(...page.entries);
      after = page.next;
    } while (after);
    return entries;
  }

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
    scan: scanAll,
    write,
    report: (error) => reportOnce('summary', 'Could not restore review summary turns', error),
  });

  const automationRules = settings.automation.rules;
  const automationController = new AbortController();
  const automationHost = createAutomationHost(ctx, deps, {
    rules: automationRules,
    closing: () => closing,
    inbox,
    deliverable,
    readFeedback: (request, cwd) => readFeedback(request, cwd),
    scan: scanAll,
    missingSession,
    redeliver: () => void notifyPending(),
    report: (error) =>
      reportOnce('review-automation', 'Could not coordinate review automation', error),
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

  const record = async (item: FeedbackItem, supersedes?: (entry: FeedbackItem) => boolean) => {
    const ref = parseUrl(item.url);
    if (
      ref &&
      (item.kind
        ? isJobFailure(item) && investigatesJobs(automationRules, ref)
        : automationReviewers(automationRules, ref).length)
    )
      item = { ...item, automationAllowed: true };
    const { delivery } = await inbox.record(item, supersedes);
    void tracked(delivery.catch((error) => deliveryFailed(item.sessionID, error)));
  };

  const readFeedback =
    deps.feedback ??
    (async (request: ReviewRequest, cwd: string) =>
      traitsOf(request).feedback?.fetch(deps.exec, cwd, request));

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
          if (ref) feedbackCache.invalidate(requestKey(ref));
          service.checkFeedback(url, reviews.invalidate);
        }, 1000),
      );
    },
  });

  const reviews = createReviewMonitoring(
    ctx.storage,
    settings,
    {
      current: currentReviews,
      isTarget,
      fetch: async (request) => {
        if (closing) return undefined;
        const ref = parseUrl(request.url);
        return ref
          ? feedbackCache.get(requestKey(ref), () => readFeedback(request, directory))
          : readFeedback(request, directory);
      },
      interval: (request) =>
        subscriptions.connected(request.url) ? RECONCILE_INTERVAL : FETCH_INTERVAL,
      accepted: clearResolved,
      scan: scanAll,
      write,
      record,
      notice,
      error: (error) =>
        reportOnce('feedback-fetch', 'Could not check PR/MR review feedback', error),
    },
    deps.now,
  );

  const lifecycle = createLifecycleNotifications(ctx, settings, deps, {
    async targets(sessionID, url) {
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
    },
    storedTargets: host.storedTargets,
    closing: () => closing,
    scan: scanAll,
    record,
    notice,
    error: (error) => reportOnce('lifecycle', 'Could not record merge request changes', error),
  });
  const retryLifecycle = () =>
    lifecycle.watcher ? tracked(lifecycle.watcher.retry()) : Promise.resolve();

  const service = createStatusService({
    async load(key, previous) {
      if (key === HOME) return locate(deps.forges, { directory });
      const session = await ctx.session.get({ sessionID: key });
      if (session.time?.archived !== undefined)
        return { kind: 'none', reason: 'The session is archived' };
      if (session.location.directory !== directory) {
        // Not `markForeign`: invalidating would discard this very lookup.
        foreign.add(key);
        reviews.forget(key);
        return { kind: 'none', reason: 'The session moved to another checkout' };
      }
      foreign.delete(key);
      const state = await host.state(key);
      return locate(deps.forges, {
        directory,
        targets: classifyTargets(targetOutput(state.targets)),
        title: userTitle(session.title, state.prefix),
        previous,
        request: (ref, load) => statusCache.get(requestKey(ref), load),
      });
    },
    isTarget,
    owns: (sessionID) => !foreign.has(sessionID),
    publish: (key, snapshot) => {
      host.publish(key, snapshot);
      clearStale(key, snapshot);
    },
    automated: reviews.automated,
    human: reviews.feedback,
    feedbackTargets: (sessionID, requests) => subscriptions.update(sessionID, requests),
    ...(lifecycle.watcher ? { lifecycle: lifecycle.watcher } : {}),
    onWatchError: (error) => reportOnce('watch', 'PR/MR status watcher failed', error),
    interval: settings.pollSeconds * 1000,
    activeInterval: Math.min(settings.pollSeconds, REVIEW_POLL_SECONDS) * 1000,
    now: deps.now,
  });
  invalidate = (sessionID) => service.invalidate(sessionID);
  const discovery = createFeedbackDiscovery({
    directory,
    candidates: async () =>
      (await scanAll('sessions/')).flatMap(({ key, value }) => {
        const targets = (value as { targets?: Target[] }).targets ?? [];
        return classifyTargets(targetOutput(targets))?.some(
          (target) => target.kind === 'merge-request',
        )
          ? [key.slice('sessions/'.length)]
          : [];
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
  void inbox
    .list()
    .then(async (state) => {
      if (closing) return;
      service.pauseFeedback(state.paused);
      automation.restore(await automationHost.restorable());
      await notifyPending();
      // Events found before a reload or a failure, such as a merge, which
      // ends polling, still go.
      if (!state.paused) await retryLifecycle();
      return discovery.refresh();
    })
    .catch((error) => reportOnce('discovery', 'Could not restore feedback monitoring', error));
  const discoveryTimer = setInterval(() => void discovery.refresh(), DISCOVERY_INTERVAL);
  const notificationTimer = setInterval(() => {
    if (closing) return;
    void notifyPending();
    void retryLifecycle();
  }, FETCH_INTERVAL);
  // Housekeeping, on the write queue so it doesn't hold up setup: removes
  // feedback records not seen for a long time.
  write(async () => {
    await reviews.prune();
    await summaries.prune();
    await lifecycle.prune();
  });

  return {
    service,
    inbox,
    discovery,
    // Acts on an update on request, or retries one that already ran.
    async act(id: string, retry = false): Promise<InboxState> {
      const item = (await inbox.list()).items.find((item) => item.id === id);
      if (!item) throw new Error('The update is no longer in the feedback inbox');
      await automation.act(item, retry);
      return inbox.list();
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
      const record = await automationHost.preparationFor(event.sessionID);
      if (!record) return false;
      const model = modelKey(event.model);
      if (record.startedAt === undefined) {
        try {
          await automationHost.authorizeStart(record, model);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          await automation.abandon(record, reason).catch(() => {});
          throw error;
        }
      } else {
        const refusal = modelRefusal(record.models, model, 'inspect');
        if (refusal) throw new Error(refusal);
      }
      event.system.push({ type: 'text', text: automationHost.instructions(record) });
      return true;
    },
    prepareSummary: summaries.prepare,
    // Starts a summary turn for an update on request, in any delivery mode.
    summarize: (id: string): Promise<InboxState> =>
      tracked(
        (async () => {
          const state = await inbox.list();
          const item = state.items.find((entry) => entry.id === id);
          if (!item) throw new Error('The update is no longer in the feedback inbox');
          if (state.paused) throw new Error('Feedback monitoring is paused');
          if (!(await summaries.deliver(item, true)))
            throw new Error("The update's session no longer targets this PR/MR here");
          return inbox.list();
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
          ...(snapshot.fetchedAt !== undefined ? { fetchedAt: snapshot.fetchedAt } : {}),
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
        const ref = parseUrl(target.url);
        if (!ref) continue;
        statusCache.invalidate(requestKey(ref));
        feedbackCache.invalidate(requestKey(ref));
      }
      return service.refresh(sessionID);
    },
    // Discards lookups of the old targets and looks the session up again.
    // Whether the new targets include a PR/MR is known now, so the footer
    // doesn't depend on that lookup succeeding.
    targetsChanged(sessionID: string, targets: readonly Target[]) {
      const classified = classifyTargets(targetOutput(targets)) ?? [];
      service.setTargeted(
        sessionID,
        classified.some((target) => target.kind === 'merge-request'),
      );
      service.invalidate(sessionID);
      // Updates for dropped targets go now, even for a session that nothing
      // polls, whose lookups would never report the change.
      void inbox
        .prune((item) => item.sessionID === sessionID && !includesRequest(targets, item.url))
        .catch((error) => reportOnce('inbox', 'Could not clear stale review updates', error));
      void discovery.refresh();
    },
    // A title reference only counts without targets.
    async titleChanged(sessionID: string) {
      if (!service.keys().includes(sessionID)) return;
      if ((await host.state(sessionID)).targets.length === 0) service.invalidate(sessionID);
    },
    // A turn may have pushed a branch or opened a PR/MR.
    turnEnded() {
      statusCache.clear();
      feedbackCache.clear();
      for (const key of service.keys()) {
        const lookup = service.get(key).lookup;
        if (lookup?.kind === 'found')
          for (const request of lookup.requests) reviews.invalidate(key, request);
        service.notify(key);
      }
      void discovery.refresh();
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
    // Sessions without targets follow the checked-out branch.
    async branchChanged() {
      for (const key of service.keys()) {
        if (key === HOME || (await host.state(key)).targets.length === 0) service.invalidate(key);
      }
    },
    // A lookup that started before the move describes the old checkout, so
    // it's discarded. The next lookup finds out which instance owns the
    // session. Deliveries check again before they send.
    sessionMoved(sessionID: string) {
      if (service.keys().includes(sessionID)) service.invalidate(sessionID);
    },
    // Stops new work, lets started deliveries store their outcome, then stops
    // writing. A delivery that outlasts DRAIN_TIME can't store its outcome,
    // so the replacement instance may send it again.
    async dispose() {
      closing = true;
      automationController.abort();
      subscriptions.dispose();
      for (const timer of feedbackEvents.values()) clearTimeout(timer);
      feedbackEvents.clear();
      statusCache.clear();
      feedbackCache.clear();
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
