import type { ReviewRequest } from './forge';
import { reference, traitsOf } from './forges';
import type { Lookup } from './store';

const requests = (lookup: Lookup | undefined) => (lookup?.kind === 'found' ? lookup.requests : []);

// The request's automated review, from its forge's `automatedReview` capability.
export function automatedReview(request: ReviewRequest) {
  const reviewer = traitsOf(request).automatedReview;
  const status = reviewer?.status(request);
  return reviewer && status ? { name: reviewer.name, ...status } : undefined;
}

export const isReviewRunning = (lookup: Lookup | undefined) =>
  requests(lookup).some((request) => automatedReview(request)?.state === 'running');

// Requests whose automated review was running in `previous` and finished with
// feedback in `next`.
export function finishedReviews(previous: Lookup | undefined, next: Lookup): ReviewRequest[] {
  const running = new Set(
    requests(previous)
      .filter((request) => automatedReview(request)?.state === 'running')
      .map((request) => request.url),
  );
  return requests(next).filter(
    (request) => running.has(request.url) && automatedReview(request)?.state === 'feedback',
  );
}

const reviewer = (request: ReviewRequest) =>
  automatedReview(request)?.name ?? 'The automated reviewer';

// The one value that every request shares, or `fallback` when they differ.
const shared = (
  requests: ReviewRequest[],
  value: (request: ReviewRequest) => string,
  fallback: string,
) => {
  const values = new Set(requests.map(value));
  return values.size === 1 ? [...values][0] : fallback;
};

const reviewers = (requests: ReviewRequest[]) => shared(requests, reviewer, 'Automated reviewers');
const nouns = (requests: ReviewRequest[]) =>
  shared(requests, (request) => `${traitsOf(request).noun}s`, 'PRs/MRs');

// A short sentence-case outcome for notifications, such as "Requested changes".
export function reviewOutcome(request: ReviewRequest): string {
  const label = automatedReview(request)?.label ?? '';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function reviewTitle(requests: ReviewRequest[]): string {
  if (requests.length === 1)
    return `${reviewer(requests[0])} finished reviewing ${reference(requests[0])}`;
  return `${reviewers(requests)} finished reviewing ${requests.length} ${nouns(requests)}`;
}

// Reviews that finish in the same poll share one message, so the agent
// works through them in one turn.
export function reviewMessage(requests: ReviewRequest[]): string {
  const state = (request: ReviewRequest) => `the state "${automatedReview(request)?.label ?? ''}"`;
  if (requests.length === 1) {
    const [request] = requests;
    const name = reviewer(request);
    return [
      `${name} finished reviewing ${reference(request)} (${request.url}) with ${state(request)}.`,
      `Fetch ${name}'s new comments and discussion threads on the ${traitsOf(request).noun}, then work through its feedback.`,
    ].join(' ');
  }
  const name = reviewers(requests);
  return [
    `${name} finished reviewing ${requests.length} ${nouns(requests)}:`,
    ...requests.map((request) => `- ${reference(request)} (${request.url}) with ${state(request)}`),
    "For each one, fetch the reviewer's new comments and discussion threads, then work through its feedback.",
  ].join('\n');
}

export function reviewToast(requests: ReviewRequest[]) {
  const outcome =
    requests.length === 1
      ? reviewOutcome(requests[0])
      : requests
          .map((request) => `${reference(request)}: ${automatedReview(request)?.label ?? ''}`)
          .join(', ');
  return { title: reviewTitle(requests), message: `${outcome}. Sent to the agent.` };
}

// A failed send is retried after this long, while the review still has feedback.
export const RETRY_DELAY = 10 * 60_000;
// A delivery that keeps failing is dropped after this long.
const PENDING_RETENTION = 24 * 60 * 60_000;

export const notificationKey = (sessionID: string, request: { url: string }) =>
  `${sessionID} ${request.url}`;

// A review that finished with feedback but couldn't be sent yet.
export interface PendingDelivery {
  sessionID: string;
  url: string;
  since: number;
  retryAt: number;
}

// Pending deliveries keyed by `notificationKey`.
export type PendingDeliveries = Record<string, PendingDelivery>;

export interface AutomatedReviewWatcherOptions {
  // Whether the PR/MR is one of the session's targets right now.
  isTarget: (sessionID: string, url: string) => boolean;
  // Rejects when the session couldn't be told.
  send: (sessionID: string, requests: ReviewRequest[]) => Promise<void>;
  onSendError?: (error: unknown, sessionID: string, requests: ReviewRequest[]) => void;
  // The session's stored pending deliveries, read the first time this
  // instance observes the session, which may have moved here from another
  // checkout. From then on this instance is their only writer.
  read?: (sessionID: string) => Promise<PendingDeliveries>;
  // Stores one delivery, or removes it when `delivery` is undefined. Each
  // delivery is its own record, so instances that share storage never
  // overwrite each other's.
  write?: (sessionID: string, url: string, delivery: PendingDelivery | undefined) => void;
  now?: () => number;
}

export type AutomatedReviewWatcher = ReturnType<typeof createAutomatedReviewWatcher>;

const isOpen = (request: ReviewRequest) => request.state === 'opened';

// Notifies a session when automated reviews of its open targets finish with
// feedback. Reviews that finish in the same poll share one message. A failed
// send stays pending and is retried while the review still has feedback,
// because the review won't finish again to trigger another notification.
export function createAutomatedReviewWatcher(options: AutomatedReviewWatcherOptions) {
  const now = options.now ?? Date.now;
  // The pending deliveries of each session this instance has observed.
  const known = new Map<string, PendingDeliveries>();
  const sending = new Set<string>();

  const write = (sessionID: string, url: string, delivery?: PendingDelivery) =>
    options.write?.(sessionID, url, delivery);

  return {
    async observe(sessionID: string, previous: Lookup | undefined, next: Lookup): Promise<void> {
      const pending = known.get(sessionID) ?? { ...(await options.read?.(sessionID)) };
      known.set(sessionID, pending);
      const at = now();
      // Merged or closed PRs/MRs need no more work, even with feedback.
      const targets = requests(next).filter(
        (request) => isOpen(request) && options.isTarget(sessionID, request.url),
      );

      // A pending delivery ends once its PR/MR is no longer an open target,
      // its review no longer has feedback, such as when a new review starts,
      // or it has failed for too long.
      for (const [key, entry] of Object.entries(pending)) {
        const request = targets.find((target) => target.url === entry.url);
        if (
          request &&
          automatedReview(request)?.state === 'feedback' &&
          at - entry.since < PENDING_RETENTION
        )
          continue;
        if (sending.has(key)) continue;
        delete pending[key];
        write(sessionID, entry.url);
      }

      const finished = finishedReviews(previous, next).filter(
        (request) => isOpen(request) && options.isTarget(sessionID, request.url),
      );
      const due = targets.filter(
        (request) => (pending[notificationKey(sessionID, request)]?.retryAt ?? Infinity) <= at,
      );
      const batch = [
        ...new Map([...finished, ...due].map((request) => [request.url, request])).values(),
      ].filter((request) => !sending.has(notificationKey(sessionID, request)));
      if (batch.length === 0) return;

      const keys = batch.map((request) => notificationKey(sessionID, request));
      for (const key of keys) sending.add(key);
      try {
        await options.send(sessionID, batch);
        batch.forEach((request, index) => {
          delete pending[keys[index]];
          write(sessionID, request.url);
        });
      } catch (error) {
        const retryAt = now() + RETRY_DELAY;
        batch.forEach((request, index) => {
          const key = keys[index];
          pending[key] = { sessionID, url: request.url, since: pending[key]?.since ?? at, retryAt };
          write(sessionID, request.url, pending[key]);
        });
        options.onSendError?.(error, sessionID, batch);
      } finally {
        for (const key of keys) sending.delete(key);
      }
    },
    // Whether the session has a delivery to retry, so its status keeps polling.
    hasPending: (sessionID: string) => Object.keys(known.get(sessionID) ?? {}).length > 0,
    // Drops what this instance knows about a session that moved away, so its
    // deliveries are read again if it comes back.
    forget: (sessionID: string) => void known.delete(sessionID),
  };
}
