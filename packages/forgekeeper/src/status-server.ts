import type { Plugin } from '@opencode/plugin';
import { createHash } from 'node:crypto';
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
import {
  createFeedbackInbox,
  feedbackLinks,
  feedbackTime,
  type FeedbackItem,
  type InboxState,
} from './feedback-inbox';
import {
  findingsText,
  MAX_FINDINGS,
  MESSAGE_PREFIX,
  messageTag,
  NOTICE_KIND,
  noticeText,
  taggedInput,
  superseded,
  SUMMARY_KIND,
  SUMMARY_MAX_TOKENS,
  SUMMARY_PREFIX,
  SUMMARY_SYSTEM,
  turnInput,
} from './review-summary';
import { createFeedbackDiscovery, DISCOVERY_INTERVAL } from './feedback-discovery';
import type { CommentDetail, FeedbackSnapshot, ReviewComment, ReviewRequest } from './forge';
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
import type { MonitoringStatus } from './monitoring-status';
import { createStatusService, HOME } from './status-service';
import type { Snapshot } from './store';
import { classifyTargets, includesRequest, targetOutput, type Target } from './target';

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
  // Reads comment text for summaries. Defaults to its forge's detail reader.
  details?: (request: ReviewRequest, ids: string[]) => Promise<CommentDetail[]>;
  now?: () => number;
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

// Storage keys. Every checkout's instance shares this plugin's storage, so
// each record has its own key, and instances never overwrite each other's
// records. Encoding keeps IDs and URLs from adding path separators.
const PENDING_PREFIX = 'status/pending/';
const FEEDBACK_PREFIX = 'status/feedback/';
const pendingPrefix = (sessionID: string) => `${PENDING_PREFIX}${encodeURIComponent(sessionID)}/`;
const pendingKey = (sessionID: string, url: string) =>
  `${pendingPrefix(sessionID)}${encodeURIComponent(url)}`;
const feedbackRecordKey = (key: string) => `${FEEDBACK_PREFIX}${encodeURIComponent(key)}`;
// The review text of summary turns, which must not enter session history.
const SUMMARY_STORE = 'status/summaries/';
// Summary records outlive their turn only until a user prompt follows, or
// until this age.
const SUMMARY_RETENTION = 7 * 24 * 60 * 60_000;

interface SummaryRecord {
  sessionID: string;
  messageID: string;
  findings: string;
  at: number;
}

// The parts of a model request that a summary turn replaces.
export interface SummaryRequest {
  readonly sessionID: string;
  system: Array<{ type: 'text'; text: string }>;
  messages: unknown[];
  tools: Record<string, unknown>;
  options: { maxTokens?: number } & Record<string, unknown>;
}
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
    // the mode affects only later updates. Turning delivery off stops retries.
    ...(settings.feedbackDelivery === 'inbox'
      ? {}
      : { notify: async (item) => void (await deliver(item)) }),
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

  // Messages Forgekeeper posted whose turns may not have finished, by session.
  // A session in this map has its context read before each model request.
  // Messages are also tagged, so missing bookkeeping, such as a failed restore
  // or an expired record, never lets one run as an ordinary request.
  const summaries = new Map<string, Set<string>>();
  // Sessions whose latest model request was a Forgekeeper request, for the
  // tool and permission backstops.
  const requesting = new Set<string>();
  const summaryKey = (sessionID: string, messageID: string) =>
    `${SUMMARY_STORE}${encodeURIComponent(sessionID)}/${messageID}`;
  const track = (sessionID: string, messageID: string) =>
    summaries.set(sessionID, (summaries.get(sessionID) ?? new Set()).add(messageID));
  let restoring: Promise<void> | undefined;
  // Restores the records, retrying after a failure on the next request.
  const restore = () =>
    (restoring ??= scanAll(SUMMARY_STORE).then(
      (entries) => {
        for (const { value } of entries) {
          const record = value as SummaryRecord;
          track(record.sessionID, record.messageID);
        }
      },
      (error) => {
        restoring = undefined;
        reportOnce('summary', 'Could not restore review summary turns', error);
      },
    ));
  void restore();
  const readRecord = async (sessionID: string, messageID: string) =>
    (await ctx.storage.get(summaryKey(sessionID, messageID)).catch(() => undefined)) as
      | SummaryRecord
      | undefined;

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
    const targets = (await host.state(item.sessionID)).targets;
    if (closing) throw new Error('The plugin stopped');
    return includesRequest(targets, item.url);
  }

  // The request an update is about. The adapters only read its URL.
  const requestOf = (item: Pick<FeedbackItem, 'url'>) => {
    const ref = parseUrl(item.url);
    return ref && ({ forge: ref.forge, url: item.url } as ReviewRequest);
  };

  // The comments an update announced. Updates stored before they kept their
  // IDs name them only in links, which some forges can read IDs from.
  const commentIDsOf = (item: FeedbackItem) => {
    const request = requestOf(item);
    const capability = request && traitsOf(request).feedback;
    return item.commentIDs ?? item.links.flatMap((link) => capability?.commentID?.(link) ?? []);
  };

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
    const resolved = new Set(
      snapshot.comments.filter((comment) => comment.resolved).map((comment) => comment.id),
    );
    void inbox
      .prune((item) => {
        if (item.url !== url) return false;
        const ids = commentIDsOf(item);
        return ids.length > 0 && ids.every((id) => resolved.has(id));
      })
      .catch((error) => reportOnce('inbox', 'Could not clear resolved review updates', error));
  }

  // Clears a session's updates for PRs/MRs that merged or closed, or that it no
  // longer targets. Only a finished lookup in this instance says so: before
  // one, such as right after a reload, the targets aren't known yet.
  function clearStale(sessionID: string, snapshot: Snapshot) {
    if (closing || sessionID === HOME || foreign.has(sessionID)) return;
    if (snapshot.loading || snapshot.fetchedAt === undefined || !snapshot.lookup) return;
    const lookup = snapshot.lookup;
    const closed = new Set(
      lookup.kind === 'found'
        ? lookup.requests
            .filter((request) => request.state !== 'opened')
            .map((request) => request.url)
        : [],
    );
    void inbox
      .prune(
        (item) =>
          item.sessionID === sessionID &&
          (closed.has(item.url) || !host.isTarget(sessionID, item.url)),
      )
      .catch((error) => reportOnce('inbox', 'Could not clear stale review updates', error));
  }

  // Posts an update to its session, as the delivery mode says, or as a summary
  // when the user asks for one. Returns whether the session still takes it.
  // Explicit requests run outside the inbox's queue, so they also check that
  // the update is still in the inbox and monitoring isn't paused.
  async function deliver(item: FeedbackItem, requested = false): Promise<boolean> {
    const mode = requested ? 'summary' : item.delivery;
    if (!mode) return false;
    if (!(await deliverable(item))) return false;
    // Automatic deliveries reuse the update's ID, so retries queue nothing new.
    // A requested summary is a new request each time.
    const hash = createHash('sha256')
      .update(requested ? `${item.id} ${(deps.now ?? Date.now)()}` : item.id)
      .digest('hex');
    const links = feedbackLinks(item);
    const request = requestOf(item);
    const reader = request && traitsOf(request).feedback?.details;
    const details =
      deps.details ??
      (reader &&
        ((target: ReviewRequest, ids: string[]) => reader(deps.exec, directory, target, ids)));
    const commentIDs = commentIDsOf(item);
    const summary = mode === 'summary' && request && details && commentIDs.length;
    if (requested && !summary)
      throw new Error('This update has no comments that can be summarized');
    const messageID = `${summary ? SUMMARY_PREFIX : MESSAGE_PREFIX}${hash}`;
    // The time lets the model say how recent the feedback is.
    const described = `${item.title} (${feedbackTime(item)})`;
    const findings = summary
      ? findingsText(
          described,
          item.url,
          await details(request, commentIDs.slice(0, MAX_FINDINGS * 2)),
        )
      : noticeText(described, links);
    // Reading the comments can take a while. The session, its targets, or the
    // update itself may have changed meanwhile.
    if (!(await deliverable(item))) return false;
    if (requested) {
      const state = await inbox.list();
      if (state.paused) throw new Error('Feedback monitoring is paused');
      if (!state.items.some((entry) => entry.id === item.id)) return false;
    }
    // The record is stored before the message, so whichever step delivers the
    // message finds it, even right after a reload.
    const record: SummaryRecord = {
      sessionID: item.sessionID,
      messageID,
      findings,
      at: (deps.now ?? Date.now)(),
    };
    await ctx.storage.set(summaryKey(item.sessionID, messageID), record as never);
    track(item.sessionID, messageID);
    if (closing) throw new Error('The plugin stopped');
    await ctx.session.synthetic({
      sessionID: item.sessionID,
      id: messageID,
      text: [
        item.title,
        feedbackTime(item),
        ...links,
        summary
          ? 'Forgekeeper summarizes this review feedback without tools.'
          : 'Review update only. No action requested.',
        messageTag(messageID),
      ].join('\n\n'),
      description: item.title,
      metadata: { forgekeeper: summary ? SUMMARY_KIND : NOTICE_KIND },
      delivery: 'queue',
      resume: !!summary,
    });
    return true;
  }

  // The summary record of the session's current turn, `failed` when the turn
  // can't be read, or undefined for an ordinary turn. A failed read counts as a
  // summary turn, so an unreadable session never gets its tools back early.
  async function summaryTurn(sessionID: string): Promise<SummaryRecord | 'failed' | undefined> {
    await restore();
    const pending = summaries.get(sessionID);
    if (!pending?.size) return undefined;
    let messages;
    try {
      messages = await ctx.session.context({ sessionID });
    } catch {
      return 'failed';
    }
    // A record ends only once a user prompt follows its delivered message. One
    // still queued stays, even while an earlier step runs.
    for (const messageID of [...pending]) {
      if (!superseded(messages, messageID)) continue;
      pending.delete(messageID);
      write(() => ctx.storage.remove(summaryKey(sessionID, messageID)));
    }
    const input = turnInput(messages);
    if (!pending.size) summaries.delete(sessionID);
    // With messages pending but no input in the context, such as after a
    // compaction, the step can't be told apart from a Forgekeeper step.
    if (!input) return pending.size ? 'failed' : undefined;
    if (input.type === 'user') return undefined;
    return (await readRecord(sessionID, input.id)) ?? 'failed';
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
    comments: { identity?: string; ids?: string[]; postedAt?: number } = {},
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
          comments.identity ??
            automatedReview(request)?.completed?.id ??
            (links.length ? [...links].sort() : description),
        ]),
        sessionID,
        url: request.url,
        title: description,
        links: links.length ? links : [request.url],
        ...(comments.ids?.length ? { commentIDs: comments.ids } : {}),
        ...(comments.postedAt !== undefined ? { postedAt: comments.postedAt } : {}),
        // Recorded with the update, so changing the mode affects later updates
        // only, and an update stored in inbox mode never starts a turn.
        ...(settings.feedbackDelivery !== 'inbox' ? { delivery: settings.feedbackDelivery } : {}),
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
      // Only a fetch the watcher accepts, one that no later change made
      // obsolete, may clear updates.
      accepted: (request, snapshot) => clearResolved(request.url, snapshot),
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
            {
              identity: automatedFeedback
                ? JSON.stringify([
                    group[0].automated?.runID ?? 'unlinked',
                    group.map((comment) => comment.id).sort(),
                  ])
                : JSON.stringify(['human', group.map((comment) => comment.id).sort()]),
              ids: group.map((comment) => comment.id),
              postedAt: Math.max(...group.map((comment) => comment.editedAt)),
            },
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
    publish: (key, snapshot) => {
      host.publish(key, snapshot);
      clearStale(key, snapshot);
    },
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
      await notifyPending();
      return discovery.refresh();
    })
    .catch((error) => reportOnce('discovery', 'Could not restore feedback monitoring', error));
  const discoveryTimer = setInterval(() => void discovery.refresh(), DISCOVERY_INTERVAL);
  const notificationTimer = setInterval(() => {
    if (!closing) void notifyPending();
  }, FETCH_INTERVAL);

  // Housekeeping, on the write queue so it doesn't hold up setup: removes
  // feedback records not seen for a long time.
  write(async () => {
    const at = (deps.now ?? Date.now)();
    for (const { key, value } of await scanAll(FEEDBACK_PREFIX)) {
      if (isExpired(value as FeedbackRecord, at)) await ctx.storage.remove(key);
    }
    for (const { key, value } of await scanAll(SUMMARY_STORE)) {
      const record = value as SummaryRecord;
      if (at - record.at < SUMMARY_RETENTION) continue;
      await ctx.storage.remove(key);
      summaries.get(record.sessionID)?.delete(record.messageID);
    }
  });

  return {
    service,
    inbox,
    discovery,
    // Turns a summary turn's model request into a tool-free request that sees
    // only the summary instructions and the review text. Returns whether it
    // did. Without a message to copy, only the links are summarized.
    async prepareSummary(event: SummaryRequest): Promise<boolean> {
      // Either the context or the request itself can show a Forgekeeper step.
      // Each covers a gap in the other, such as bookkeeping lost to a failed
      // restore, or a reminder sent after the message.
      const tagged = taggedInput(event.messages);
      let record = await summaryTurn(event.sessionID);
      if (!record && tagged) record = (await readRecord(event.sessionID, tagged)) ?? 'failed';
      if (!record) {
        requesting.delete(event.sessionID);
        return false;
      }
      requesting.add(event.sessionID);
      for (const name of Object.keys(event.tools)) delete event.tools[name];
      event.system.splice(0, event.system.length, { type: 'text', text: SUMMARY_SYSTEM });
      event.options.maxTokens = SUMMARY_MAX_TOKENS;
      const text =
        record === 'failed'
          ? 'The review text is unavailable. Reply that it could not be read.'
          : record.findings;
      // The hook's messages are instances of OpenCode's message class, which
      // validates its fields. The plugin can't import it, so it reuses the
      // constructor of a message in the request. Without one, the request
      // fails rather than keeping any of the session's messages.
      const Message = (event.messages.at(-1) as { constructor?: unknown } | undefined)
        ?.constructor as (new (input: unknown) => unknown) | undefined;
      if (!Message || Message === Object)
        throw new Error('Forgekeeper could not build a tool-free review request');
      const message = new Message({ role: 'user', content: [{ type: 'text', text }] });
      event.messages.splice(0, event.messages.length, message);
      return true;
    },
    // Starts a summary turn for an update on request, in any delivery mode.
    summarize: (id: string): Promise<InboxState> =>
      tracked(
        (async () => {
          const state = await inbox.list();
          const item = state.items.find((entry) => entry.id === id);
          if (!item) throw new Error('The update is no longer in the feedback inbox');
          if (state.paused) throw new Error('Feedback monitoring is paused');
          if (!(await deliver(item, true)))
            throw new Error("The update's session no longer targets this PR/MR here");
          return inbox.list();
        })(),
      ),
    // Whether the session's current step is Forgekeeper's, whose tools and
    // permissions are refused. Tools come from a model response, so a session
    // whose latest request was Forgekeeper's counts too.
    async summarizing(sessionID: string): Promise<boolean> {
      return requesting.has(sessionID) || (await summaryTurn(sessionID)) !== undefined;
    },
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
        humanFeedback: settings.notifyHumanReviews,
        automatedFeedback: settings.notifyAutomatedReviews,
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
      clearInterval(notificationTimer);
      discovery.stop();
      await Promise.all([service.dispose(DRAIN_TIME), drain(deliveries, DRAIN_TIME)]);
      closed = true;
      await writes;
    },
  };
}

export type Status = Awaited<ReturnType<typeof setupStatus>>;
