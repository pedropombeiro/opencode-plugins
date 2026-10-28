import type { FeedbackSnapshot } from './forge';
import { SETTLE_TIME } from './human-review-watch';

export function duoFindings(snapshot: FeedbackSnapshot): FeedbackSnapshot {
  return {
    ...snapshot,
    comments: snapshot.comments
      .filter(
        (comment) => comment.automated?.reviewer === 'GitLab Duo' && comment.automated.finding,
      )
      .map((comment) => ({ ...comment, bot: false })),
  };
}

export function duoReady(snapshot: FeedbackSnapshot, now: number): boolean {
  const comments = snapshot.comments.filter((comment) => !comment.resolved);
  return comments.every(
    (comment) =>
      now - comment.editedAt >= SETTLE_TIME &&
      (!comment.automated?.status ||
        ['FINISHED', 'FAILED', 'STOPPED'].includes(comment.automated.status)),
  );
}
