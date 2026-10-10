import type { Plugin } from '@opencode/plugin';
import {
  automatedReview,
  createAutomatedReviewWatcher,
  reviewMessage,
  reviewTitle,
  reviewToast,
  notificationKey,
  type PendingDeliveries,
  type PendingDelivery,
} from './automated-review-watch';
import type { Exec } from './exec';
import type { FeedbackSnapshot, ReviewComment, ReviewRequest } from './forge';
import { reference, traitsOf, type ForgeCatalog } from './forges';
import {
  applyFeedback,
  createFeedbackWatcher,
  feedbackMessage,
  feedbackToast,
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

  // Whether this instance still owns the session. It reads the session again,
  // because the session may have moved while a lookup or fetch ran. A session
  // that moved is left to its new checkout's instance.
  // A failed read rejects, so the delivery stays pending and is retried: only
  // a session that was read and is elsewhere counts as moved.
  async function owns(sessionID: string) {
    const session = await ctx.session.get({ sessionID });
    if (session.location.directory === directory) return true;
    markForeign(sessionID);
    return false;
  }

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
    compose: (requests: ReviewRequest[]) => { text: string; description: string },
  ): Promise<ReviewRequest[]> {
    if (closing) throw new Error('The plugin stopped');
    if (!(await owns(sessionID))) return [];
    if (closing) throw new Error('The plugin stopped');
    const current = requests.filter((request) => isTarget(sessionID, request.url));
    if (current.length === 0) return [];
    const { text, description } = compose(current);
    await ctx.session.synthetic({
      sessionID,
      text,
      description,
      delivery: 'queue',
      resume: settings.resumeSession,
    });
    return current;
  }

  const readFeedback =
    deps.feedback ??
    (async (request: ReviewRequest, cwd: string) =>
      traitsOf(request).feedback?.fetch(deps.exec, cwd, request));

  const automated = settings.notifyAutomatedReviews
    ? createAutomatedReviewWatcher({
        isTarget,
        now: deps.now,
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
          const sent = await tell(sessionID, requests, (current) => ({
            text: reviewMessage(current),
            description: reviewTitle(current),
          }));
          if (sent.length > 0) notice({ sessionID, ...reviewToast(sent), variant: 'info' });
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

  const human = settings.notifyHumanReviews
    ? createFeedbackWatcher({
        record: async (key) =>
          (await ctx.storage.get(feedbackRecordKey(key))) as FeedbackRecord | undefined,
        now: deps.now,
        persist: (key, change, at) =>
          write(async () => {
            const stored = (await ctx.storage.get(feedbackRecordKey(key))) as
              | FeedbackRecord
              | undefined;
            await ctx.storage.set(
              feedbackRecordKey(key),
              applyFeedback(stored, change, at) as never,
            );
          }),
        fetch: async (_sessionID, request) =>
          closing ? undefined : readFeedback(request, directory),
        current: (sessionID, request) => isTarget(sessionID, request.url),
        async send(sessionID: string, request: ReviewRequest, comments: ReviewComment[]) {
          const sent = await tell(sessionID, [request], () => ({
            text: feedbackMessage(request, comments),
            description: `New review feedback on ${reference(request)}`,
          }));
          if (sent.length > 0)
            notice({ sessionID, ...feedbackToast(request, comments), variant: 'info' });
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
      })
    : undefined;

  const service = createStatusService({
    async load(key, previous) {
      if (key === HOME) return locate(deps.forges, { directory });
      const session = await ctx.session.get({ sessionID: key });
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
      });
    },
    isTarget,
    owns: (sessionID) => !foreign.has(sessionID),
    publish: host.publish,
    automated,
    human,
    onWatchError: (error) => reportOnce('watch', 'PR/MR status watcher failed', error),
    interval: settings.pollSeconds * 1000,
    activeInterval: Math.min(settings.pollSeconds, REVIEW_POLL_SECONDS) * 1000,
    now: deps.now,
  });
  invalidate = (sessionID) => service.invalidate(sessionID);

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
    },
    // A title reference only counts without targets.
    async titleChanged(sessionID: string) {
      if (!service.keys().includes(sessionID)) return;
      if ((await host.state(sessionID)).targets.length === 0) service.invalidate(sessionID);
    },
    // A turn may have pushed a branch or opened a PR/MR.
    turnEnded() {
      for (const key of service.keys()) service.notify(key);
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
      await service.dispose(DRAIN_TIME);
      closed = true;
      await writes;
    },
  };
}

export type Status = Awaited<ReturnType<typeof setupStatus>>;
