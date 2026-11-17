// Requests for the viewer's review of a session's PRs/MRs, from the forge's
// history. A repeated request is its own event, so a re-review is announced
// even when the viewer stays a reviewer throughout. The first complete read
// only records a baseline, so requests made before monitoring started are
// never announced.
import type {
  FeedbackSnapshot,
  ReviewComment,
  ReviewRequest,
  ReviewRequestEvent,
  ReviewRequestHistory,
} from './forge';
import { feedbackKey } from './human-review-watch';

// The history is read at most this often per session and request.
export const REQUEST_INTERVAL = 60_000;
// A failed send is retried after this long instead of on every poll.
export const REQUEST_RETRY_DELAY = 10 * 60_000;
// Records of requests not seen for this long are dropped. The next read
// starts a fresh baseline, so old requests are never replayed.
const RECORD_RETENTION = 30 * 24 * 60 * 60_000;
const TOUCH_INTERVAL = 24 * 60 * 60_000;
// Announced request IDs a record keeps. Older ones are below any baseline a
// busy PR/MR's history window still reaches.
const MAX_ANNOUNCED = 100;
// The author replies an update links, for its summary.
export const MAX_REQUEST_REPLIES = 10;

export interface RequestRecord {
  // The highest order the first complete read saw. Requests up to it aren't
  // announced.
  baseline: number;
  // IDs of requests already announced to the session.
  announced: string[];
  // The highest order of the requests already announced. Requests up to it
  // aren't announced again, even once `announced` no longer lists them.
  // Absent in records from before it existed.
  processed?: number;
  seenAt: number;
}

// Said in an update whose author replies couldn't be read, so its summary
// doesn't claim there were none.
export const REPLIES_UNAVAILABLE = "Forgekeeper couldn't read the author's replies.";

export const isRequestRecordExpired = (record: RequestRecord, now: number) =>
  now - record.seenAt > RECORD_RETENTION;

// What the update says about the request: the request before it, if any,
// and the order after which the author's replies count.
export interface RequestWindow {
  previous?: ReviewRequestEvent;
  after: number;
  viewerID?: string;
}

export interface AuthorReplies {
  replies: ReviewComment[];
  // Of those, replies in threads the viewer took part in, and in resolved ones.
  participated: number;
  resolved: number;
  // Replies left out of `replies`.
  more: number;
}

// The author's replies since `after`, resolved or not, with replies in
// threads the viewer took part in first. `authors` are the accounts that
// count as the author, such as the PR/MR's author and who asked for the
// review. The viewer's own comments and bots' never count.
export function authorReplies(
  snapshot: FeedbackSnapshot | undefined,
  authors: ReadonlySet<string>,
  after: number,
  viewerID = snapshot?.viewerID,
): AuthorReplies {
  const comments = snapshot?.comments ?? [];
  const joined = new Set(
    comments.flatMap((comment) =>
      comment.authorID === viewerID && comment.discussionID ? [comment.discussionID] : [],
    ),
  );
  const inJoined = (comment: ReviewComment) =>
    !!comment.discussionID && joined.has(comment.discussionID);
  const all = comments
    .filter(
      (comment) =>
        !comment.bot &&
        comment.order > after &&
        comment.authorID !== viewerID &&
        authors.has(comment.authorID),
    )
    .sort((a, b) => Number(inJoined(b)) - Number(inJoined(a)) || a.order - b.order);
  const replies = all.slice(0, MAX_REQUEST_REPLIES);
  return {
    replies,
    participated: replies.filter(inJoined).length,
    resolved: replies.filter((comment) => comment.resolved).length,
    more: all.length - replies.length,
  };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

// One line about the replies, for the inbox and session messages. It names
// counts only, never reply text.
export function repliesLine(context: AuthorReplies, again: boolean): string | undefined {
  const total = context.replies.length + context.more;
  if (!total) return undefined;
  const parts = [
    ...(context.participated ? [`${context.participated} in threads you took part in`] : []),
    ...(context.resolved ? [`${context.resolved} in resolved threads`] : []),
  ];
  return `The author replied ${plural(total, 'time', 'times')} since ${
    again ? 'the previous request' : 'monitoring started'
  }${parts.length ? `: ${parts.join(', ')}` : ''}.`;
}

export interface RequestWatcherOptions {
  // The stored record of a `feedbackKey`, which may lag behind local writes.
  record: (key: string) => Promise<RequestRecord | undefined>;
  persist: (key: string, record: RequestRecord) => void;
  fetch: (sessionID: string, request: ReviewRequest) => Promise<ReviewRequestHistory | undefined>;
  // Whether the request is still the session's target, checked before and
  // after each fetch.
  current: (sessionID: string, request: ReviewRequest) => boolean;
  // Rejects when the session couldn't be told.
  send: (
    sessionID: string,
    request: ReviewRequest,
    event: ReviewRequestEvent,
    window: RequestWindow,
  ) => Promise<void>;
  onFetchError?: (error: unknown) => void;
  onSendError?: (error: unknown, sessionID: string) => void;
  now?: () => number;
  interval?: number;
}

export function createReviewRequestWatcher(options: RequestWatcherOptions) {
  const now = options.now ?? Date.now;
  const interval = options.interval ?? REQUEST_INTERVAL;
  // Local copies of records, which storage may not reflect yet.
  const local = new Map<string, RequestRecord>();
  const inflight = new Set<string>();
  const fetchedAt = new Map<string, number>();
  const retryAt = new Map<string, number>();
  const dirty = new Set<string>();

  // Merges the stored and local records. The higher baseline is the safer one.
  const merged = (key: string, stored: RequestRecord | undefined) => {
    const mine = local.get(key);
    if (!stored || !mine) return mine ?? stored;
    const processed = Math.max(stored.processed ?? 0, mine.processed ?? 0);
    return {
      baseline: Math.max(stored.baseline, mine.baseline),
      announced: [...new Set([...stored.announced, ...mine.announced])].slice(-MAX_ANNOUNCED),
      ...(processed ? { processed } : {}),
      seenAt: Math.max(stored.seenAt, mine.seenAt),
    };
  };

  const remember = (key: string, record: RequestRecord) => {
    local.set(key, record);
    options.persist(key, record);
  };

  async function observe(sessionID: string, request: ReviewRequest, history: ReviewRequestHistory) {
    const key = feedbackKey(sessionID, request);
    const previous = merged(key, await options.record(key));
    const at = now();
    if (!previous) return remember(key, { baseline: history.newest, announced: [], seenAt: at });
    if (at < (retryAt.get(key) ?? 0)) return;
    const announced = new Set(previous.announced);
    const after = Math.max(previous.baseline, previous.processed ?? 0);
    // Requests the viewer made themselves, such as adding themselves as a
    // reviewer, need no notice, but still date the next request's context.
    const fresh = history.requests.filter(
      (event) =>
        event.order > after && !announced.has(event.id) && event.requester?.id !== history.viewerID,
    );
    if (!fresh.length) {
      if (at - previous.seenAt > TOUCH_INTERVAL) remember(key, { ...previous, seenAt: at });
      return;
    }
    // Requests that piled up, such as while OpenCode wasn't running, make one
    // update, about the newest.
    const event = fresh.at(-1)!;
    const before = history.requests.filter((entry) => entry.order < event.order).at(-1);
    try {
      await options.send(sessionID, request, event, {
        ...(before ? { previous: before } : {}),
        after: before?.order ?? previous.baseline,
        ...(history.viewerID ? { viewerID: history.viewerID } : {}),
      });
      retryAt.delete(key);
      const latest = merged(key, local.get(key)) ?? previous;
      remember(key, {
        ...latest,
        announced: [...new Set([...latest.announced, ...fresh.map((entry) => entry.id)])].slice(
          -MAX_ANNOUNCED,
        ),
        processed: Math.max(latest.processed ?? 0, event.order),
        seenAt: now(),
      });
    } catch (error) {
      retryAt.set(key, now() + REQUEST_RETRY_DELAY);
      options.onSendError?.(error, sessionID);
    }
  }

  return {
    invalidate(sessionID: string, request: ReviewRequest) {
      const key = feedbackKey(sessionID, request);
      fetchedAt.delete(key);
      dirty.add(key);
    },
    forget(sessionID: string) {
      for (const key of [...local.keys()])
        if (key.startsWith(`${sessionID} `)) {
          local.delete(key);
          fetchedAt.delete(key);
          retryAt.delete(key);
        }
    },
    // Reads the request's history, unless a read is running or ran recently,
    // and announces new requests. Resolves once that work is done.
    async check(sessionID: string, request: ReviewRequest): Promise<void> {
      const key = feedbackKey(sessionID, request);
      if (inflight.has(key) || !options.current(sessionID, request)) return;
      if (now() - (fetchedAt.get(key) ?? -Infinity) < interval) return;
      inflight.add(key);
      try {
        dirty.delete(key);
        fetchedAt.set(key, now());
        const history = await options.fetch(sessionID, request);
        if (!history?.complete) {
          fetchedAt.delete(key);
          return;
        }
        if (dirty.has(key) || !options.current(sessionID, request)) return;
        await observe(sessionID, request, history);
      } catch (error) {
        fetchedAt.delete(key);
        options.onFetchError?.(error);
      } finally {
        inflight.delete(key);
      }
    },
  };
}
