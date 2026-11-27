import type { Plugin } from '@opencode/plugin';
import {
  APPROVAL_RETENTION,
  approvalDetails,
  approverKey,
  approverKind,
  createApprovalWatcher,
  matchesApproverEvent,
  type ApprovalRecord,
} from './approval-watch';
import {
  automatedReview,
  createAutomatedReviewWatcher,
  reviewTitle,
  notificationKey,
  type PendingDeliveries,
  type PendingDelivery,
  type ReviewHistory,
} from './automated-review-watch';
import type { FeedbackItem } from './feedback-inbox';
import {
  approvalsComplete,
  approversOf,
  type FeedbackSnapshot,
  type ReviewerApproval,
  type ReviewComment,
  type ReviewRequest,
  type ReviewRequestEvent,
  type ReviewRequestHistory,
} from './forge';
import {
  authorReplies,
  createReviewRequestWatcher,
  isRequestRecordExpired,
  repliesLine,
  REPLIES_UNAVAILABLE,
  type RequestRecord,
  type RequestWindow,
} from './review-request-watch';
import { parseUrl, reference, traits, traitsOf } from './forges';
import {
  applyFeedback,
  createFeedbackWatcher,
  isExpired,
  type Counts,
  type FeedbackRecord,
} from './human-review-watch';
import { matchesReviewBot, type StatusOptions } from './options';
import type { Notice } from './rpc';
import { includesRequest, type Target } from './target';

const PENDING_PREFIX = 'status/pending/';
const FEEDBACK_PREFIX = 'status/feedback/';
const pendingPrefix = (sessionID: string) => `${PENDING_PREFIX}${encodeURIComponent(sessionID)}/`;
const pendingKey = (sessionID: string, url: string) =>
  `${pendingPrefix(sessionID)}${encodeURIComponent(url)}`;
const feedbackRecordKey = (key: string) => `${FEEDBACK_PREFIX}${encodeURIComponent(key)}`;
const REQUEST_PREFIX = 'status/review-requests/';
const requestRecordKey = (key: string) => `${REQUEST_PREFIX}${encodeURIComponent(key)}`;
const APPROVAL_PREFIX = 'status/approvals/';
const approvalPrefix = (sessionID: string) => `${APPROVAL_PREFIX}${encodeURIComponent(sessionID)}/`;
const approvalKey = (sessionID: string, url: string) =>
  `${approvalPrefix(sessionID)}${encodeURIComponent(url)}`;
const reviewHistoryKey = (sessionID: string, url: string) =>
  `status/reviews/${encodeURIComponent(sessionID)}/${encodeURIComponent(url)}`;

interface ReviewHost {
  current: (sessionID: string, requests: ReviewRequest[]) => Promise<ReviewRequest[]>;
  isTarget: (sessionID: string, url: string) => boolean;
  targets?: (sessionID: string, url: string) => Promise<Target[] | undefined>;
  storedTargets?: (sessionID: string) => Promise<Target[]>;
  sessionOwnership?: (
    sessionIDs: readonly string[],
  ) => Promise<{ here: string[]; deleted: string[] }>;
  onSessionsDeleted?: (sessionIDs: readonly string[]) => Promise<void>;
  receipts?: () => Promise<string[]>;
  releaseReceipts?: (ids: readonly string[]) => Promise<void>;
  retainReceipts?: (known: ReadonlySet<string>, pending: ReadonlySet<string>) => Promise<void>;
  fresh?: (url: string) => Promise<ReviewRequest | undefined>;
  closing?: () => boolean;
  viewerID?: (url: string) => Promise<string | undefined>;
  fetch: (request: ReviewRequest) => Promise<FeedbackSnapshot | undefined>;
  reviewRequests: (request: ReviewRequest) => Promise<ReviewRequestHistory | undefined>;
  interval: (request: ReviewRequest) => number;
  accepted: (url: string, snapshot: FeedbackSnapshot | undefined) => void;
  scan: (prefix: string) => Promise<{ key: string; value: unknown }[]>;
  write: (task: () => Promise<void>) => void;
  record: (
    item: FeedbackItem,
    supersedes?: (entry: FeedbackItem) => boolean,
    accept?: () => boolean,
  ) => Promise<boolean | void>;
  notice: (notice: Notice) => void;
  error: (error: unknown) => void;
  approvalError?: (error: unknown) => void;
}

export function createReviewMonitoring(
  storage: Plugin.Context['storage'],
  settings: StatusOptions,
  host: ReviewHost,
  now = Date.now,
) {
  async function tell(
    sessionID: string,
    requests: ReviewRequest[],
    title: (requests: ReviewRequest[]) => string,
    links: string[] = [],
    comments: {
      identity?: string;
      ids?: string[];
      postedAt?: number;
      humanApprovalOnly?: boolean;
    } = {},
  ): Promise<ReviewRequest[]> {
    const current = await host.current(sessionID, requests);
    if (current.length === 0) return [];
    const description = title(current);
    for (const request of current) {
      await host.record({
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
        ...(comments.postedAt === undefined ? {} : { postedAt: comments.postedAt }),
        ...(comments.humanApprovalOnly ? { humanApprovalOnly: true } : {}),
        ...(settings.delivery.reviews === 'inbox' ? {} : { delivery: settings.delivery.reviews }),
        at: now(),
      });
    }
    return current;
  }

  const automated = settings.watch.automatedReviews
    ? createAutomatedReviewWatcher({
        isTarget: (sessionID, url) => {
          const ref = parseUrl(url);
          return (
            host.isTarget(sessionID, url) &&
            !(ref && traits(ref.forge).automatedReview?.publishedFeedback)
          );
        },
        now,
        readHistory: async (sessionID, url) =>
          (await storage.get(reviewHistoryKey(sessionID, url))) as ReviewHistory | undefined,
        writeHistory: (sessionID, url, history) => {
          const snapshot = { observed: [...history.observed], delivered: [...history.delivered] };
          host.write(() => storage.set(reviewHistoryKey(sessionID, url), snapshot));
        },
        async read(sessionID) {
          const deliveries: PendingDeliveries = {};
          for (const { value } of await host.scan(pendingPrefix(sessionID))) {
            const delivery = value as PendingDelivery;
            deliveries[notificationKey(sessionID, delivery)] = delivery;
          }
          return deliveries;
        },
        write: (sessionID, url, delivery) =>
          host.write(() =>
            delivery
              ? storage.set(pendingKey(sessionID, url), delivery as never)
              : storage.remove(pendingKey(sessionID, url)),
          ),
        async send(sessionID, requests) {
          const sent = await tell(sessionID, requests, reviewTitle);
          if (sent.length > 0)
            host.notice({
              sessionID,
              title: reviewTitle(sent),
              message: 'New feedback in /forge-feedback.',
              variant: 'info',
            });
        },
        onSendError(error, sessionID, requests) {
          const reason = error instanceof Error ? error.message : String(error);
          const name = automatedReview(requests[0])?.name ?? 'the automated reviewer';
          host.notice({
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

  const feedbackWatcher = (automatedFeedback: boolean, counts?: Counts) =>
    createFeedbackWatcher({
      ...(counts ? { counts } : {}),
      ...(automatedFeedback
        ? {
            select: (snapshot: FeedbackSnapshot, request: ReviewRequest) =>
              traitsOf(request).automatedReview?.publishedFeedback?.select(snapshot) ?? snapshot,
            ready: (snapshot: FeedbackSnapshot, now: number, request: ReviewRequest) =>
              traitsOf(request).automatedReview?.publishedFeedback?.ready(snapshot, now) ?? false,
          }
        : {}),
      interval: host.interval,
      record: async (key) =>
        (await storage.get(feedbackRecordKey(recordKey(key, automatedFeedback)))) as
          FeedbackRecord | undefined,
      now,
      persist: (key, change, at) =>
        host.write(async () => {
          key = recordKey(key, automatedFeedback);
          const stored = (await storage.get(feedbackRecordKey(key))) as FeedbackRecord | undefined;
          await storage.set(feedbackRecordKey(key), applyFeedback(stored, change, at) as never);
        }),
      fetch: (_sessionID, request) => host.fetch(request),
      accepted: (request, snapshot) => host.accepted(request.url, snapshot),
      current: (sessionID, request) => host.isTarget(sessionID, request.url),
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
              ...(group.length > 0 &&
              group.every((comment) => !comment.bot && comment.reviewState === 'APPROVED')
                ? { humanApprovalOnly: true }
                : {}),
            },
          );
          if (sent.length > 0)
            host.notice({
              sessionID,
              title,
              message: 'New feedback in /forge-feedback.',
              variant: 'info',
            });
        }
      },
      onFetchError: host.error,
      onSendError: (error, sessionID) => {
        const reason = error instanceof Error ? error.message : String(error);
        host.notice({
          sessionID,
          message: `Could not tell the session about review feedback: ${reason}. Retrying in 10 minutes.`,
          variant: 'error',
        });
      },
    });

  const reviewBots = settings.watch.reviewBots ? settings.reviewBots : {};
  const commentHost = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return undefined;
    }
  };
  const human =
    settings.watch.humanReviews || Object.values(reviewBots).some((names) => names.length)
      ? feedbackWatcher(false, {
          humans: settings.watch.humanReviews,
          reviewBot: (comment) => {
            const host = commentHost(comment.url);
            return !!host && matchesReviewBot(reviewBots, host, comment.username);
          },
        })
      : undefined;
  const publishedFeedback = settings.watch.automatedReviews ? feedbackWatcher(true) : undefined;

  // Tells the session about a request for the viewer's review, with the
  // author's replies since the previous request as context. The replies are
  // optional, so a failure to read them doesn't hold the request back.
  async function sendRequest(
    sessionID: string,
    request: ReviewRequest,
    event: ReviewRequestEvent,
    window: RequestWindow,
  ) {
    const [current] = await host.current(sessionID, [request]);
    if (!current) return;
    const fetched = await host.fetch(current).catch(() => undefined);
    const snapshot = fetched?.complete ? fetched : undefined;
    // The session may have stopped targeting the PR/MR, or been archived or
    // moved, while the replies were read.
    if (!(await host.current(sessionID, [current])).length) return;
    const viewerID = window.viewerID ?? snapshot?.viewerID;
    const authors = new Set(
      [current.authorID, event.requester?.id].filter((id): id is string => !!id && id !== viewerID),
    );
    const context = authorReplies(snapshot, authors, window.after, viewerID);
    const again = !!window.previous;
    const who = event.requester ? `@${event.requester.username}` : 'Someone';
    const title = `${who} requested your review${again ? ' again' : ''} on ${reference(current)}`;
    const line = snapshot ? repliesLine(context, again) : REPLIES_UNAVAILABLE;
    await host.record({
      id: JSON.stringify([sessionID, current.url, 'review-request', event.id]),
      kind: 'review-request',
      sessionID,
      url: current.url,
      title,
      links: [event.url, ...context.replies.map((comment) => comment.url)],
      // Always set, so the request's own note isn't taken for a reply.
      commentIDs: context.replies.map((comment) => comment.id),
      postedAt: event.at,
      ...(line ? { details: [line] } : {}),
      ...(settings.delivery.reviews === 'inbox' ? {} : { delivery: settings.delivery.reviews }),
      at: now(),
    });
    host.notice({
      sessionID,
      title,
      message: 'New review request in /forge-feedback.',
      variant: 'info',
    });
  }

  const requests = settings.watch.reviewRequests
    ? createReviewRequestWatcher({
        record: async (key) =>
          (await storage.get(requestRecordKey(key))) as RequestRecord | undefined,
        persist: (key, record) =>
          host.write(() => storage.set(requestRecordKey(key), record as never)),
        fetch: (_sessionID, request) => host.reviewRequests(request),
        current: (sessionID, request) => host.isTarget(sessionID, request.url),
        send: sendRequest,
        onFetchError: (error) => host.error(error),
        onSendError: (error, sessionID) => {
          const reason = error instanceof Error ? error.message : String(error);
          host.notice({
            sessionID,
            message: `Could not tell the session about a review request: ${reason}. Retrying in 10 minutes.`,
            variant: 'error',
          });
        },
        now,
      })
    : undefined;
  const asksForReviews = (request: ReviewRequest) =>
    !!requests && !!traitsOf(request).feedback?.reviewRequests;

  const watchesApprovals =
    settings.watch.automatedReviews ||
    settings.watch.humanReviews ||
    Object.values(reviewBots).some((names) => names.length);
  const watchesApprover = (url: string, approver: ReviewerApproval) => {
    if (approver.automated) return settings.watch.automatedReviews;
    if (approver.bot) {
      const hostName = commentHost(url);
      return !!hostName && matchesReviewBot(reviewBots, hostName, approver.username);
    }
    return settings.watch.humanReviews;
  };
  const readApprovals = async (prefix: string) =>
    (await host.scan(prefix)).map(({ value }) => value as ApprovalRecord);
  const removeApprovalSession = async (sessionID: string) => {
    const retiredIDs: string[] = [];
    for (const { key, value } of await host.scan(approvalPrefix(sessionID))) {
      for (const event of (value as ApprovalRecord).pending) retiredIDs.push(event.id);
      await storage.remove(key);
    }
    if (retiredIDs.length) await host.releaseReceipts?.(retiredIDs).catch(() => {});
  };
  const approvals = watchesApprovals
    ? createApprovalWatcher({
        records: (sessionID) => readApprovals(approvalPrefix(sessionID)),
        write: async (record) => {
          if (host.closing?.()) throw new Error('The plugin stopped');
          await storage.set(approvalKey(record.sessionID, record.url), record as never);
        },
        remove: async (record) => {
          if (host.closing?.()) throw new Error('The plugin stopped');
          await storage.remove(approvalKey(record.sessionID, record.url));
        },
        retired: (ids) => host.releaseReceipts?.(ids) ?? Promise.resolve(),
        waiting: async () => {
          const waiting = (await readApprovals(APPROVAL_PREFIX)).filter(
            (record) => record.pending.length,
          );
          if (!host.sessionOwnership || !waiting.length) return waiting;
          const { here, deleted } = await host.sessionOwnership([
            ...new Set(waiting.map((record) => record.sessionID)),
          ]);
          if (deleted.length) {
            for (const sessionID of deleted) await removeApprovalSession(sessionID);
            await host.onSessionsDeleted?.(deleted).catch(() => {});
          }
          return waiting.filter((record) => here.includes(record.sessionID));
        },
        deliver: async (record, event, freshRequest) => {
          if (host.targets) {
            const targets = await host.targets(record.sessionID, record.url);
            if (!targets) return;
          } else if (!host.isTarget(record.sessionID, record.url)) {
            return;
          }
          if (!watchesApprover(record.url, event.approver)) return;
          const reviewerLower = event.approver.username.toLowerCase();
          let live = freshRequest;
          if (!live && host.fresh) {
            live = await host.fresh(record.url);
            if (!live) return;
          }
          if (live) {
            if (live.state !== 'opened') return { reconcile: live };
            if (!approvalsComplete(live)) return 'defer';
            const matched = approversOf(live).find((approver) =>
              matchesApproverEvent(event.approver, approver),
            );
            if (!matched) return { reconcile: live };
            if (!watchesApprover(live.url, matched)) return;
          } else if (
            record.state !== 'opened' ||
            (!record.approvers.includes(approverKey(event.approver)) &&
              !record.approvers.includes(reviewerLower))
          ) {
            return;
          }
          const kind = approverKind(event.approver);
          if (kind === 'human' && event.approver.id && host.viewerID) {
            const viewer = await host.viewerID(record.url);
            if (viewer && event.approver.id === viewer) return;
            if (host.targets) {
              const latestTargets = await host.targets(record.sessionID, record.url);
              if (!latestTargets) return;
            } else if (!host.isTarget(record.sessionID, record.url)) {
              return;
            }
          }
          const details = live ? approvalDetails(live) : (event.details ?? []);
          const item: FeedbackItem = {
            id: event.id,
            kind: 'approval',
            sessionID: record.sessionID,
            url: record.url,
            title: event.title,
            links: [record.url],
            reviewers: [event.approver.username],
            approverKind: kind,
            ...(event.approver.id ? { approverID: event.approver.id } : {}),
            ...(event.approver.reviewID ? { approvalToken: event.approver.reviewID } : {}),
            ...(event.cycle === undefined ? {} : { approvalCycle: event.cycle }),
            ...(details.length ? { details } : {}),
            ...(event.delivery ? { delivery: event.delivery } : {}),
            at: event.detectedAt,
          };
          const sameApprover = (entry: FeedbackItem) =>
            entry.kind === 'approval' &&
            entry.sessionID === item.sessionID &&
            entry.url === item.url &&
            (item.approverID && entry.approverID
              ? entry.approverID === item.approverID
              : !!entry.reviewers?.some((name) => name.toLowerCase() === reviewerLower));
          const recorded = await host.record(item, sameApprover, () =>
            host.isTarget(record.sessionID, record.url),
          );
          if (recorded === false) return;
          host.notice({
            sessionID: record.sessionID,
            title: event.title,
            message: 'New review approval in /forge-feedback.',
            variant: 'info',
          });
        },
        reference,
        watches: (request, approver) => watchesApprover(request.url, approver),
        delivery: () => settings.delivery.reviews,
        onError: host.approvalError ?? host.error,
        now,
      })
    : undefined;

  return {
    automated,
    approvals,
    watchesApprover,
    reconcileApproval: (sessionID: string, live: ReviewRequest, fetchedAt: number) =>
      approvals ? approvals.reconcile(sessionID, live, fetchedAt) : Promise.resolve(),
    retireApprovals: async (sessionID: string, keep?: (url: string) => boolean) => {
      if (approvals) {
        await approvals.retire(sessionID, keep);
        return;
      }
      const retiredIDs: string[] = [];
      for (const { key, value } of await host.scan(approvalPrefix(sessionID))) {
        const record = value as ApprovalRecord;
        if (keep?.(record.url)) continue;
        for (const event of record.pending) retiredIDs.push(event.id);
        await storage.remove(key);
      }
      if (retiredIDs.length) await host.releaseReceipts?.(retiredIDs).catch(() => {});
    },
    feedback:
      human || publishedFeedback || requests
        ? {
            watches: (request: ReviewRequest) =>
              !!human ||
              !!traitsOf(request).automatedReview?.publishedFeedback ||
              asksForReviews(request),
            settling: (sessionID: string, requests: readonly ReviewRequest[]) =>
              !!human?.settling(sessionID, requests) ||
              !!publishedFeedback?.settling(sessionID, requests),
            async check(sessionID: string, request: ReviewRequest) {
              await Promise.all([
                human?.check(sessionID, request),
                traitsOf(request).automatedReview?.publishedFeedback
                  ? publishedFeedback?.check(sessionID, request)
                  : undefined,
                asksForReviews(request) ? requests?.check(sessionID, request) : undefined,
              ]);
            },
          }
        : undefined,
    invalidate(sessionID: string, request: ReviewRequest) {
      human?.invalidate(sessionID, request);
      publishedFeedback?.invalidate(sessionID, request);
      requests?.invalidate(sessionID, request);
    },
    forget: (sessionID: string) => {
      automated?.forget(sessionID);
      requests?.forget(sessionID);
    },
    async prune() {
      const at = now();
      for (const { key, value } of await host.scan(FEEDBACK_PREFIX)) {
        if (isExpired(value as FeedbackRecord, at)) await storage.remove(key);
      }
      for (const { key, value } of await host.scan(REQUEST_PREFIX)) {
        if (isRequestRecordExpired(value as RequestRecord, at)) await storage.remove(key);
      }
      const knownReceipts = new Set((await host.receipts?.().catch(() => [])) ?? []);
      const approvalEntries = await host.scan(APPROVAL_PREFIX);
      const deletedList =
        host.sessionOwnership && approvalEntries.length
          ? (
              await host.sessionOwnership([
                ...new Set(approvalEntries.map(({ value }) => (value as ApprovalRecord).sessionID)),
              ])
            ).deleted
          : [];
      const deletedSessions = new Set(deletedList);
      const remainingPending = new Set<string>();
      for (const { key, value } of approvalEntries) {
        const record = value as ApprovalRecord;
        if (deletedSessions.has(record.sessionID)) {
          await storage.remove(key);
          continue;
        }
        if (record.pending.length) {
          for (const event of record.pending) remainingPending.add(event.id);
          continue;
        }
        if (at - record.at < APPROVAL_RETENTION) continue;
        if (!host.storedTargets) {
          await storage.remove(key);
          continue;
        }
        const targets = await host.storedTargets(record.sessionID).catch(() => undefined);
        if (targets && !includesRequest(targets, record.url)) await storage.remove(key);
      }
      if (deletedList.length) await host.onSessionsDeleted?.(deletedList).catch(() => {});
      await host.retainReceipts?.(knownReceipts, remainingPending).catch(() => {});
    },
  };
}
