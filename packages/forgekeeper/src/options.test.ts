import { describe, expect, test } from 'bun:test';
import { DEFAULT_REVIEW_BOTS, matchesReviewBot, statusOptions } from './options';

const notify = { mode: 'notify' as const, actions: [] };

describe('statusOptions', () => {
  test('monitors feedback and lifecycle events without resuming sessions by default', () => {
    expect(statusOptions(undefined)).toEqual({
      enabled: true,
      pollSeconds: 120,
      notifyAutomatedReviews: true,
      notifyHumanReviews: true,
      reviewBots: {
        'gitlab.com': [
          'duo-security-review-gitlab-org',
          'ai-appsec-security-mr-reviewer-gitlab-org',
        ],
      },
      feedbackDelivery: 'inbox',
      notifyLifecycle: true,
      lifecycleDelivery: 'inbox',
      lifecycleExecution: { parentMerged: notify, conflict: notify },
      problems: [],
    });
  });

  test('reads the delivery modes and falls back to the inbox for unknown values', () => {
    expect(statusOptions({ reviewFeedbackDelivery: 'summary' }).feedbackDelivery).toBe('summary');
    expect(statusOptions({ reviewFeedbackDelivery: 'passive' }).feedbackDelivery).toBe('passive');
    expect(statusOptions({ reviewFeedbackDelivery: 'resume' }).feedbackDelivery).toBe('inbox');
    expect(statusOptions({ lifecycleDelivery: 'summary' }).lifecycleDelivery).toBe('summary');
    expect(statusOptions({ lifecycleDelivery: 'apply' }).lifecycleDelivery).toBe('inbox');
  });

  test('reads explicit settings', () => {
    expect(
      statusOptions({
        reviewStatus: false,
        pollSeconds: 45,
        notifyAutomatedReviews: false,
        notifyHumanReviews: false,
        notifyLifecycle: false,
      }),
    ).toMatchObject({
      enabled: false,
      pollSeconds: 45,
      notifyAutomatedReviews: false,
      notifyHumanReviews: false,
      feedbackDelivery: 'inbox',
      notifyLifecycle: false,
    });
  });

  test('accepts the former name of notifyAutomatedReviews and ignores invalid intervals', () => {
    expect(statusOptions({ notifyDuoReview: false, pollSeconds: -1 })).toMatchObject({
      notifyAutomatedReviews: false,
      pollSeconds: 120,
    });
    expect(
      statusOptions({ notifyDuoReview: false, notifyAutomatedReviews: true })
        .notifyAutomatedReviews,
    ).toBe(true);
  });

  test('reads the review bots by host, which replace the defaults, and keeps them for invalid values', () => {
    expect(
      statusOptions({
        reviewBots: { 'GitLab.example.com': ['SAST-bot', 'sast-bot'], 'github.com': [] },
      }).reviewBots,
    ).toEqual({ 'gitlab.example.com': ['sast-bot'], 'github.com': [] });
    expect(statusOptions({ reviewBots: {} }).reviewBots).toEqual({});
    for (const [value, reason] of [
      [['duo-security-review-gitlab-org'], 'must map hosts'],
      ['sast-bot', 'must map hosts'],
      [{ 'gitlab.com': ['duo-security-review-*'] }, 'without wildcards'],
      [{ 'gitlab.com': ['two words'] }, 'without wildcards'],
      [{ 'gitlab.com': 'sast-bot' }, 'must list usernames'],
      [{ 'https://gitlab.com': ['sast-bot'] }, "isn't a host name"],
    ] as const) {
      const options = statusOptions({ reviewBots: value });
      expect(options.reviewBots).toEqual(DEFAULT_REVIEW_BOTS);
      expect(options.problems).toEqual([expect.stringContaining(reason)]);
    }
  });

  test('matches review bots by exact username on their own host, ignoring case', () => {
    const bots = statusOptions({
      reviewBots: { 'gitlab.com': ['duo-security-review-gitlab-org'] },
    }).reviewBots;
    expect(matchesReviewBot(bots, 'gitlab.com', 'Duo-Security-Review-GitLab-Org')).toBe(true);
    // A name that only starts the same, or the same name on another host.
    expect(matchesReviewBot(bots, 'gitlab.com', 'duo-security-review-gitlab-org-evil')).toBe(false);
    expect(matchesReviewBot(bots, 'gitlab.example.com', 'duo-security-review-gitlab-org')).toBe(
      false,
    );
  });

  test('grants execution only as each event policy states', () => {
    const options = statusOptions({
      lifecycleExecution: {
        parentMerged: { mode: 'apply', actions: ['retarget', 'retarget'] },
        conflict: { mode: 'notify' },
      },
    });
    expect(options.lifecycleExecution).toEqual({
      parentMerged: { mode: 'apply', actions: ['retarget'] },
      conflict: notify,
    });
    expect(options.problems).toEqual([]);
    expect(
      statusOptions({ lifecycleExecution: { parentMerged: { mode: 'prepare' } } })
        .lifecycleExecution.parentMerged,
    ).toEqual({ mode: 'prepare', actions: [] });
  });

  test('falls back to notifying for every invalid or unsupported policy, and says why', () => {
    for (const [policy, reason] of [
      [{ mode: 'apply' }, '"apply" needs at least one action'],
      [{ mode: 'apply', actions: ['push'] }, 'unsupported actions ["push"]'],
      [{ mode: 'everything' }, 'mode must be'],
      [{ mode: 'apply', actions: 'retarget' }, 'actions must be a list'],
      ['apply', 'mode must be'],
    ] as const) {
      const options = statusOptions({ lifecycleExecution: { parentMerged: policy } });
      expect(options.lifecycleExecution.parentMerged).toEqual(notify);
      expect(options.problems).toEqual([expect.stringContaining(reason)]);
    }
    // Conflicts support only notifying so far.
    const conflict = statusOptions({ lifecycleExecution: { conflict: { mode: 'prepare' } } });
    expect(conflict.lifecycleExecution.conflict).toEqual(notify);
    expect(conflict.problems).toEqual([expect.stringContaining('"prepare" isn\'t supported yet')]);
    expect(statusOptions({ lifecycleExecution: 'apply' }).problems).toEqual([
      expect.stringContaining('must be an object'),
    ]);
  });
});
