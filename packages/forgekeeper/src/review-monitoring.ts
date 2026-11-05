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
import type { FeedbackItem } from './feedback-inbox';
import type { FeedbackSnapshot, ReviewComment, ReviewRequest } from './forge';
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

const PENDING_PREFIX = 'status/pending/';
const FEEDBACK_PREFIX = 'status/feedback/';
const pendingPrefix = (sessionID: string) => `${PENDING_PREFIX}${encodeURIComponent(sessionID)}/`;
const pendingKey = (sessionID: string, url: string) =>
  `${pendingPrefix(sessionID)}${encodeURIComponent(url)}`;
const feedbackRecordKey = (key: string) => `${FEEDBACK_PREFIX}${encodeURIComponent(key)}`;
const reviewHistoryKey = (sessionID: string, url: string) =>
  `status/reviews/${encodeURIComponent(sessionID)}/${encodeURIComponent(url)}`;

interface ReviewHost {
  current: (sessionID: string, requests: ReviewRequest[]) => Promise<ReviewRequest[]>;
  isTarget: (sessionID: string, url: string) => boolean;
  fetch: (request: ReviewRequest) => Promise<FeedbackSnapshot | undefined>;
  interval: (request: ReviewRequest) => number;
  accepted: (url: string, snapshot: FeedbackSnapshot | undefined) => void;
  scan: (prefix: string) => Promise<{ key: string; value: unknown }[]>;
  write: (task: () => Promise<void>) => void;
  record: (item: FeedbackItem) => Promise<void>;
  notice: (notice: Notice) => void;
  error: (error: unknown) => void;
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
    comments: { identity?: string; ids?: string[]; postedAt?: number } = {},
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
        ...(comments.postedAt !== undefined ? { postedAt: comments.postedAt } : {}),
        ...(settings.delivery.reviews !== 'inbox' ? { delivery: settings.delivery.reviews } : {}),
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
          | FeedbackRecord
          | undefined,
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

  return {
    automated,
    feedback:
      human || publishedFeedback
        ? {
            watches: (request: ReviewRequest) =>
              !!human || !!traitsOf(request).automatedReview?.publishedFeedback,
            async check(sessionID: string, request: ReviewRequest) {
              await Promise.all([
                human?.check(sessionID, request),
                traitsOf(request).automatedReview?.publishedFeedback
                  ? publishedFeedback?.check(sessionID, request)
                  : undefined,
              ]);
            },
          }
        : undefined,
    invalidate(sessionID: string, request: ReviewRequest) {
      human?.invalidate(sessionID, request);
      publishedFeedback?.invalidate(sessionID, request);
    },
    forget: (sessionID: string) => automated?.forget(sessionID),
    async prune() {
      const at = now();
      for (const { key, value } of await host.scan(FEEDBACK_PREFIX)) {
        if (isExpired(value as FeedbackRecord, at)) await storage.remove(key);
      }
    },
  };
}
