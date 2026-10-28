import type { Plugin } from '@opencode/plugin';
import {
  automatedReview,
  createAutomatedReviewWatcher,
  reviewTitle,
  notificationKey,
  type PendingDeliveries,
  type PendingDelivery,
  type ReviewHistory,
} from './automated-review-watch';
import type { Exec } from './exec';
import { createRequestCache } from './request-cache';
import { createFeedbackSubscriptions, RECONCILE_INTERVAL } from './feedback-subscriptions';
import { createFeedbackInbox, type InboxState } from './feedback-inbox';
import { createFeedbackDiscovery, DISCOVERY_INTERVAL } from './feedback-discovery';
import type { FeedbackSnapshot, ReviewComment, ReviewRequest } from './forge';
import { parseUrl, reference, traits, traitsOf, type ForgeCatalog } from './forges';
import {
  applyFeedback,
  FETCH_INTERVAL,
  createFeedbackWatcher,
  isExpired,
  type FeedbackRecord,
} from './human-review-watch';
import { locate } from './locate';
import type { StatusOptions } from './options';
import type { Notice } from './rpc';
import { createStatusService, HOME } from './status-service';
import type { Snapshot } from './store';
import { classifyTargets, targetOutput, type Target } from './target';

// Running automated reviews poll at most this often, so a finished review is
// noticed promptly.
const REVIEW_POLL_SECONDS = 30;

export interface StatusDependencies {
  // Forges and commands for status lookups and feedback, which share one
  // concurrency limit.
  forges: ForgeCatalog;
  exec: Exec;
  // Reads a PR/MR's review comments. Defaults to its forge's feedback reader.
  feedback?: (request: ReviewRequest, directory: string) => Promise<FeedbackSnapshot | undefined>;
  now?: () => number;
}

// How long cleanup waits for running review checks before giving up. They
// can't send or write anything after cleanup starts, so this only bounds how
// long a stopped plugin keeps work around.
const DRAIN_TIME = 5_000;

export interface StatusHost {
  // The session's stored targets, and the title prefix this plugin wrote.
  state: (sessionID: string) => Promise<{ targets: Target[]; prefix?: string }>;
  isTarget: (sessionID: string, url: string) => boolean;
  publish: (key: string, snapshot: Snapshot) => void;
  notice: (notice: Notice) => void;
  feedbackChanged?: () => void;
}

// Storage keys. Every checkout's instance shares this plugin's storage, so
// each record has its own key, and instances never overwrite each other's
// records. Encoding keeps IDs and URLs from adding path separators.
const PENDING_PREFIX = 'status/pending/';
const FEEDBACK_PREFIX = 'status/feedback/';
const pendingPrefix = (sessionID: string) => `${PENDING_PREFIX}${encodeURIComponent(sessionID)}/`;
const pendingKey = (sessionID: string, url: string) =>
  `${pendingPrefix(sessionID)}${encodeURIComponent(url)}`;
const feedbackRecordKey = (key: string) => `${FEEDBACK_PREFIX}${encodeURIComponent(key)}`;
const reviewHistoryKey = (sessionID: string, url: string) =>
  `status/reviews/${encodeURIComponent(sessionID)}/${encodeURIComponent(url)}`;

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
    read: async () =>
      (await ctx.storage.get(`feedback-inbox/${encodeURIComponent(directory)}`)) as
        | InboxState
        | undefined,
    write: async (state) => {
      if (closed) throw new Error('The plugin stopped');
      await ctx.storage.set(`feedback-inbox/${encodeURIComponent(directory)}`, state as never);
    },
    changed: () => host.feedbackChanged?.(),
  });

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
    automated?.forget(sessionID);
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

  // Tells the session about the requests that are still its targets, and
  // returns them. The message is composed from those requests only, right
  // before sending, because the targets can change while ownership is read.
  // A request that is no longer a target, or a session that moved to another
  // checkout, ends the delivery without a retry. Rejects when the session
  // can't be read or cleanup stopped the delivery, so it stays pending.
  async function tell(
    sessionID: string,
    requests: ReviewRequest[],
    title: (requests: ReviewRequest[]) => string,
    links: string[] = [],
    identity?: string,
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
    const current = requests.filter((request) => isTarget(sessionID, request.url));
    if (current.length === 0) return [];
    const description = title(current);
    for (const request of current) {
      await inbox.add({
        id: JSON.stringify([
          sessionID,
          request.url,
          identity ??
            automatedReview(request)?.completed?.id ??
            (links.length ? [...links].sort() : description),
        ]),
        sessionID,
        url: request.url,
        title: description,
        links: links.length ? links : [request.url],
        at: (deps.now ?? Date.now)(),
      });
    }
    return current;
  }

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
          service.checkFeedback(url, (sessionID, request) => {
            human?.invalidate(sessionID, request);
            publishedFeedback?.invalidate(sessionID, request);
          });
        }, 1000),
      );
    },
  });

  const automated = settings.notifyAutomatedReviews
    ? createAutomatedReviewWatcher({
        isTarget: (sessionID, url) => {
          const ref = parseUrl(url);
          return (
            isTarget(sessionID, url) &&
            !(ref && traits(ref.forge).automatedReview?.publishedFeedback)
          );
        },
        now: deps.now,
        readHistory: async (sessionID, url) =>
          (await ctx.storage.get(reviewHistoryKey(sessionID, url))) as ReviewHistory | undefined,
        writeHistory: (sessionID, url, history) => {
          const snapshot = { observed: [...history.observed], delivered: [...history.delivered] };
          write(() => ctx.storage.set(reviewHistoryKey(sessionID, url), snapshot));
        },
        async read(sessionID) {
          const deliveries: PendingDeliveries = {};
          for (const { value } of await scanAll(pendingPrefix(sessionID))) {
            const delivery = value as PendingDelivery;
            deliveries[notificationKey(sessionID, delivery)] = delivery;
          }
          return deliveries;
        },
        write: (sessionID, url, delivery) =>
          write(() =>
            delivery
              ? ctx.storage.set(pendingKey(sessionID, url), delivery as never)
              : ctx.storage.remove(pendingKey(sessionID, url)),
          ),
        async send(sessionID, requests) {
          const sent = await tell(sessionID, requests, reviewTitle);
          if (sent.length > 0)
            notice({
              sessionID,
              title: reviewTitle(sent),
              message: 'New feedback in /forge-feedback.',
              variant: 'info',
            });
        },
        onSendError(error, sessionID, requests) {
          const reason = error instanceof Error ? error.message : String(error);
          const name = automatedReview(requests[0])?.name ?? 'the automated reviewer';
          notice({
            sessionID,
            message: `Could not tell the session about ${name}'s review: ${reason}. Retrying in 10 minutes.`,
            variant: 'error',
          });
        },
      })
    : undefined;

  const recordKey = (key: string, automatedFeedback: boolean) => {
    if (!automatedFeedback) return key;
    const ref = parseUrl(key.slice(key.indexOf(' ') + 1));
    const namespace = ref && traits(ref.forge).automatedReview?.publishedFeedback?.storageKey;
    return `${namespace ?? 'automated'} ${key}`;
  };

  const feedbackWatcher = (automatedFeedback: boolean) =>
    createFeedbackWatcher({
      ...(automatedFeedback
        ? {
            select: (snapshot: FeedbackSnapshot, request: ReviewRequest) =>
              traitsOf(request).automatedReview?.publishedFeedback?.select(snapshot) ?? snapshot,
            ready: (snapshot: FeedbackSnapshot, now: number, request: ReviewRequest) =>
              traitsOf(request).automatedReview?.publishedFeedback?.ready(snapshot, now) ?? false,
          }
        : {}),
      interval: (request) =>
        subscriptions.connected(request.url) ? RECONCILE_INTERVAL : FETCH_INTERVAL,
      record: async (key) =>
        (await ctx.storage.get(feedbackRecordKey(recordKey(key, automatedFeedback)))) as
          | FeedbackRecord
          | undefined,
      now: deps.now,
      persist: (key, change, at) =>
        write(async () => {
          key = recordKey(key, automatedFeedback);
          const stored = (await ctx.storage.get(feedbackRecordKey(key))) as
            | FeedbackRecord
            | undefined;
          await ctx.storage.set(feedbackRecordKey(key), applyFeedback(stored, change, at) as never);
        }),
      fetch: async (_sessionID, request) => {
        if (closing) return undefined;
        const ref = parseUrl(request.url);
        return ref
          ? feedbackCache.get(requestKey(ref), () => readFeedback(request, directory))
          : readFeedback(request, directory);
      },
      current: (sessionID, request) => isTarget(sessionID, request.url),
      async send(sessionID: string, request: ReviewRequest, comments: ReviewComment[]) {
        const title = automatedFeedback
          ? `New ${traitsOf(request).automatedReview?.name ?? 'automated'} review feedback on ${reference(request)}`
          : `New review feedback on ${reference(request)}`;
        const groups = automatedFeedback
          ? [...new Set(comments.map((comment) => comment.automated?.runID ?? 'unlinked'))].map(
              (runID) =>
                comments.filter((comment) => (comment.automated?.runID ?? 'unlinked') === runID),
            )
          : [comments];
        for (const group of groups) {
          const sent = await tell(
            sessionID,
            [request],
            () => title,
            group.map((comment) => comment.url),
            automatedFeedback
              ? JSON.stringify([
                  group[0].automated?.runID ?? 'unlinked',
                  group.map((comment) => comment.id).sort(),
                ])
              : JSON.stringify(['human', group.map((comment) => comment.id).sort()]),
          );
          if (sent.length > 0)
            notice({
              sessionID,
              title,
              message: 'New feedback in /forge-feedback.',
              variant: 'info',
            });
        }
      },
      onFetchError: (error) =>
        reportOnce('feedback-fetch', 'Could not check PR/MR review feedback', error),
      onSendError: (error) => {
        const reason = error instanceof Error ? error.message : String(error);
        notice({
          message: `Could not tell the session about review feedback: ${reason}`,
          variant: 'error',
        });
      },
    });

  const human = settings.notifyHumanReviews ? feedbackWatcher(false) : undefined;
  const publishedFeedback = settings.notifyAutomatedReviews ? feedbackWatcher(true) : undefined;

  const service = createStatusService({
    async load(key, previous) {
      if (key === HOME) return locate(deps.forges, { directory });
      const session = await ctx.session.get({ sessionID: key });
      if (session.time?.archived !== undefined)
        return { kind: 'none', reason: 'The session is archived' };
      if (session.location.directory !== directory) {
        // Not `markForeign`: invalidating would discard this very lookup.
        foreign.add(key);
        automated?.forget(key);
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
    publish: host.publish,
    automated,
    human:
      human || publishedFeedback
        ? {
            watches: (request) => !!human || !!traitsOf(request).automatedReview?.publishedFeedback,
            async check(sessionID, request) {
              await Promise.all([
                human?.check(sessionID, request),
                traitsOf(request).automatedReview?.publishedFeedback
                  ? publishedFeedback?.check(sessionID, request)
                  : undefined,
              ]);
            },
          }
        : undefined,
    feedbackTargets: (sessionID, requests) => subscriptions.update(sessionID, requests),
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
    activity: async (sessionID) => {
      const messages = await ctx.session.context({ sessionID });
      return messages.reduce<number | undefined>(
        (latest, message) =>
          message.type === 'user' ? Math.max(latest ?? 0, message.time.created) : latest,
        undefined,
      );
    },
    paused: async () => (await inbox.list()).paused,
    watch: (ids) => service.discover(ids),
    error: (error) => reportOnce('discovery', 'Could not discover recent review sessions', error),
    now: deps.now,
  });
  void inbox
    .list()
    .then((state) => {
      if (closing) return;
      service.pauseFeedback(state.paused);
      return discovery.refresh();
    })
    .catch((error) => reportOnce('discovery', 'Could not restore feedback monitoring', error));
  const discoveryTimer = setInterval(() => void discovery.refresh(), DISCOVERY_INTERVAL);

  // Housekeeping, on the write queue so it doesn't hold up setup: removes
  // feedback records not seen for a long time.
  write(async () => {
    const at = (deps.now ?? Date.now)();
    for (const { key, value } of await scanAll(FEEDBACK_PREFIX)) {
      if (isExpired(value as FeedbackRecord, at)) await ctx.storage.remove(key);
    }
  });

  return {
    service,
    inbox,
    discovery,
    async refresh(sessionID: string) {
      const lookup = service.get(sessionID).lookup;
      if (lookup?.kind === 'found')
        for (const request of lookup.requests) {
          human?.invalidate(sessionID, request);
          publishedFeedback?.invalidate(sessionID, request);
        }
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
          for (const request of lookup.requests) {
            human?.invalidate(key, request);
            publishedFeedback?.invalidate(key, request);
          }
        service.notify(key);
      }
      void discovery.refresh();
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
      subscriptions.dispose();
      for (const timer of feedbackEvents.values()) clearTimeout(timer);
      feedbackEvents.clear();
      statusCache.clear();
      feedbackCache.clear();
      clearInterval(discoveryTimer);
      discovery.stop();
      await service.dispose(DRAIN_TIME);
      closed = true;
      await writes;
    },
  };
}

export type Status = Awaited<ReturnType<typeof setupStatus>>;
