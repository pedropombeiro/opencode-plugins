import { isReviewRequest, type FeedbackItem } from './feedback-inbox';
import { pipelineFails, type FeedbackSnapshot } from './forge';
import type { Lookup } from './store';
import { commentIDsOf } from './summary-delivery';

export function settledFeedback(
  item: Pick<FeedbackItem, 'url' | 'kind' | 'pipeline'>,
  lookup: Lookup | undefined,
): boolean {
  if (item.kind !== 'conflict' && item.kind !== 'ci-failed') return false;
  const request =
    lookup?.kind === 'found' ? lookup.requests.find((entry) => entry.url === item.url) : undefined;
  if (!request) return false;
  if (request.state !== 'opened') return true;
  if (item.kind === 'conflict') return request.conflictsKnown && !request.conflicts;
  const pipeline = request.pipeline;
  return !!pipeline?.id && (pipeline.id !== item.pipeline || !pipelineFails(pipeline));
}

export function resolvedFeedback(url: string, snapshot: FeedbackSnapshot) {
  const resolved = new Set(
    snapshot.comments.filter((comment) => comment.resolved).map((comment) => comment.id),
  );
  return (item: FeedbackItem): boolean => {
    // A review request's comments are context, which stays useful once the
    // author resolves their threads.
    if (!snapshot.complete || item.url !== url || isReviewRequest(item)) return false;
    const ids = commentIDsOf(item);
    return ids.length > 0 && ids.every((id) => resolved.has(id));
  };
}

export function closedFeedback(lookup: Lookup) {
  const closed = new Set(
    lookup.kind === 'found'
      ? lookup.requests
          .filter((request) => request.state !== 'opened')
          .map((request) => request.url)
      : [],
  );
  return (item: FeedbackItem) => item.kind !== 'merged' && closed.has(item.url);
}
