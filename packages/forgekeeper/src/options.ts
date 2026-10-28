// The PR/MR status options, from the plugin's `opencode.json` entry. The
// server entry point reads them; the CLI only renders what the server sends.
export interface StatusOptions {
  // `reviewStatus: false` keeps only session targets and titles.
  enabled: boolean;
  pollSeconds: number;
  notifyAutomatedReviews: boolean;
  notifyHumanReviews: boolean;
  feedbackDelivery: FeedbackDelivery;
}

// What a feedback update does besides entering the inbox. `passive` queues a
// session message that starts no turn. `summary` starts a tool-free turn that
// summarizes the feedback.
export type FeedbackDelivery = 'inbox' | 'passive' | 'summary';

const DELIVERIES = new Set<unknown>(['inbox', 'passive', 'summary']);

export function statusOptions(options: unknown): StatusOptions {
  const source = options && typeof options === 'object' ? (options as Record<string, unknown>) : {};
  const poll = Number(source.pollSeconds);
  return {
    enabled: source.reviewStatus !== false,
    pollSeconds: poll > 0 ? poll : 120,
    // `notifyDuoReview` is the option's former name.
    notifyAutomatedReviews: (source.notifyAutomatedReviews ?? source.notifyDuoReview) !== false,
    notifyHumanReviews: source.notifyHumanReviews !== false,
    feedbackDelivery: DELIVERIES.has(source.reviewFeedbackDelivery)
      ? (source.reviewFeedbackDelivery as FeedbackDelivery)
      : 'inbox',
  };
}
