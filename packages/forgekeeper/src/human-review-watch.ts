import type { FeedbackSnapshot, ReviewComment, ReviewRequest } from './forge';
import { reference } from './forges';

// Humans add and edit comments over a review, so new comments are announced
// only after no human comment has changed for this long.
export const SETTLE_TIME = 5 * 60_000;
// Feedback is fetched at most this often per session and request, even when
// the status polls faster, such as during an automated review.
export const FETCH_INTERVAL = 60_000;
// A failed send is retried after this long instead of on every poll.
export const RETRY_DELAY = 10 * 60_000;
// Records of requests not seen for this long are dropped. The next observation
// starts a fresh baseline, so old comments are never replayed.
const RECORD_RETENTION = 30 * 24 * 60 * 60_000;
// How stale a record's `seenAt` can get before an observation refreshes it.
const TOUCH_INTERVAL = 24 * 60 * 60_000;
const MAX_LINKS = 20;

export interface FeedbackRecord {
  // The highest comment order in the first complete snapshot. Comments at or
  // below it predate watching, even if deleted comments later shift them into
  // the window of newest comments that the forge reads.
  baseline: number;
  // IDs of comments already announced to the session.
  announced: string[];
  seenAt: number;
}

export interface FeedbackChange {
  // Only used when the record is created.
  baseline?: number;
  announced?: string[];
}

export interface FeedbackLog {
  // Keyed by `feedbackKey`.
  records: Record<string, FeedbackRecord>;
}

export const feedbackKey = (sessionID: string, request: ReviewRequest) =>
  `${sessionID} ${request.url}`;

// The record after a change, creating it if needed.
export function applyFeedback(
  record: FeedbackRecord | undefined,
  change: FeedbackChange,
  now: number,
): FeedbackRecord {
  const announced = [...(record?.announced ?? [])];
  for (const id of change.announced ?? []) if (!announced.includes(id)) announced.push(id);
  return { baseline: record?.baseline ?? change.baseline ?? 0, announced, seenAt: now };
}

// Whether a record is old enough to drop. The next observation starts a fresh
// baseline, so old comments are never replayed.
export const isExpired = (record: FeedbackRecord, now: number) =>
  now - record.seenAt > RECORD_RETENTION;

// Applies a change to a record in a log, and prunes stale records.
export function recordFeedback(log: FeedbackLog, key: string, change: FeedbackChange, now: number) {
  log.records[key] = applyFeedback(log.records[key], change, now);
  for (const [entry, value] of Object.entries(log.records)) {
    if (isExpired(value, now)) delete log.records[entry];
  }
}

export interface SeenComments {
  baseline: number;
  announced: Set<string>;
}

// The highest comment order in a snapshot, or 0 for a request without comments.
export const baselineOf = (snapshot: FeedbackSnapshot) =>
  snapshot.comments.reduce((highest, comment) => Math.max(highest, comment.order), 0);

const isNew = (comment: ReviewComment, seen: SeenComments) =>
  comment.order > seen.baseline && !seen.announced.has(comment.id);

// Unresolved comments from people other than the viewer.
const humanFeedback = (snapshot: FeedbackSnapshot) =>
  snapshot.comments.filter(
    (comment) => !comment.bot && comment.authorID !== snapshot.viewerID && !comment.resolved,
  );

// New human comments, but only once no human comment, announced or not, has
// been added or edited for SETTLE_TIME. Any activity restarts the wait for the
// whole batch, so a review in progress is announced once it goes quiet.
export function eligibleFeedback(
  snapshot: FeedbackSnapshot,
  seen: SeenComments,
  now: number,
): ReviewComment[] {
  const human = humanFeedback(snapshot);
  const pending = human.filter((comment) => isNew(comment, seen));
  if (pending.length === 0) return [];
  const lastActivity = Math.max(...human.map((comment) => comment.editedAt));
  return now - lastActivity >= SETTLE_TIME ? pending : [];
}

const authors = (comments: ReviewComment[]) => [
  ...new Set(comments.map((comment) => `@${comment.username}`)),
];

function list(items: string[]): string {
  if (items.length <= 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

export function feedbackMessage(request: ReviewRequest, comments: ReviewComment[]): string {
  const links = comments
    .slice(0, MAX_LINKS)
    .map((comment) => `- @${comment.username}: ${comment.url}`);
  if (comments.length > MAX_LINKS) links.push(`- and ${comments.length - MAX_LINKS} more`);
  return [
    `New review feedback from ${list(authors(comments))} on ${reference(request)} (${request.url}).`,
    'No review comment has changed for at least 5 minutes. New comments:',
    ...links,
    'Fetch these comments and their discussion threads, then assess and address the feedback.',
  ].join('\n');
}

export function feedbackToast(request: ReviewRequest, comments: ReviewComment[]) {
  const count = comments.length === 1 ? '1 comment' : `${comments.length} comments`;
  return {
    title: `New review feedback on ${reference(request)}`,
    message: `${count} from ${list(authors(comments))}. Sent to the agent.`,
  };
}

export interface FeedbackWatcherOptions {
  // The stored record of a `feedbackKey`, which may lag behind local writes.
  record: (key: string) => Promise<FeedbackRecord | undefined>;
  persist: (key: string, change: FeedbackChange, now: number) => void;
  fetch: (sessionID: string, request: ReviewRequest) => Promise<FeedbackSnapshot | undefined>;
  // Whether the request is still the session's target, checked before and
  // after each fetch.
  current: (sessionID: string, request: ReviewRequest) => boolean;
  // Rejects when the session couldn't be told.
  send: (sessionID: string, request: ReviewRequest, comments: ReviewComment[]) => Promise<void>;
  onFetchError?: (error: unknown) => void;
  onSendError?: (error: unknown) => void;
  now?: () => number;
}

export function createFeedbackWatcher(options: FeedbackWatcherOptions) {
  const now = options.now ?? Date.now;
  // Local copies of records, which storage may not reflect yet.
  const local = new Map<string, SeenComments>();
  const reserved = new Set<string>();
  const inflight = new Set<string>();
  const fetchedAt = new Map<string, number>();
  const retryAt = new Map<string, number>();

  // Merges the stored and local records. The higher baseline is the safer one.
  const seen = (key: string, shared: FeedbackRecord | undefined): SeenComments | undefined => {
    const mine = local.get(key);
    if (!shared && !mine) return undefined;
    return {
      baseline: Math.max(shared?.baseline ?? 0, mine?.baseline ?? 0),
      announced: new Set([...(shared?.announced ?? []), ...(mine?.announced ?? [])]),
    };
  };

  const remember = (key: string, change: FeedbackChange, at: number) => {
    const mine = local.get(key) ?? { baseline: change.baseline ?? 0, announced: new Set<string>() };
    for (const id of change.announced ?? []) mine.announced.add(id);
    local.set(key, mine);
    options.persist(key, change, at);
  };

  async function observe(sessionID: string, request: ReviewRequest, snapshot: FeedbackSnapshot) {
    if (!snapshot.complete) return;
    const key = feedbackKey(sessionID, request);
    const stored = await options.record(key);
    const at = now();
    const previous = seen(key, stored);
    if (!previous) return remember(key, { baseline: baselineOf(snapshot) }, at);
    if (at < (retryAt.get(key) ?? 0)) return;
    const comments = eligibleFeedback(snapshot, previous, at).filter(
      (comment) => !reserved.has(`${key} ${comment.id}`),
    );
    if (comments.length === 0) {
      if (stored && at - stored.seenAt > TOUCH_INTERVAL) options.persist(key, {}, at);
      return;
    }
    const ids = comments.map((comment) => comment.id);
    for (const id of ids) reserved.add(`${key} ${id}`);
    try {
      await options.send(sessionID, request, comments);
      retryAt.delete(key);
      remember(key, { announced: ids }, now());
    } catch (error) {
      retryAt.set(key, now() + RETRY_DELAY);
      options.onSendError?.(error);
    } finally {
      for (const id of ids) reserved.delete(`${key} ${id}`);
    }
  }

  return {
    // Fetches the request's comments, unless a fetch is running or ran
    // recently, and announces settled feedback. Resolves once that work is done.
    async check(sessionID: string, request: ReviewRequest): Promise<void> {
      const key = feedbackKey(sessionID, request);
      if (inflight.has(key) || now() - (fetchedAt.get(key) ?? -Infinity) < FETCH_INTERVAL) return;
      if (!options.current(sessionID, request)) return;
      inflight.add(key);
      fetchedAt.set(key, now());
      try {
        const snapshot = await options.fetch(sessionID, request);
        if (!snapshot || !options.current(sessionID, request)) return;
        await observe(sessionID, request, snapshot);
      } catch (error) {
        options.onFetchError?.(error);
      } finally {
        inflight.delete(key);
      }
    },
  };
}
