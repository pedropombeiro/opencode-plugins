import { describe, expect, test } from 'bun:test';
import { statusOptions } from './options';

describe('statusOptions', () => {
  test('monitors feedback without resuming sessions by default', () => {
    expect(statusOptions(undefined)).toEqual({
      enabled: true,
      pollSeconds: 120,
      notifyAutomatedReviews: true,
      notifyHumanReviews: true,
      feedbackDelivery: 'inbox',
    });
  });

  test('reads the feedback delivery mode and falls back to the inbox for unknown values', () => {
    expect(statusOptions({ reviewFeedbackDelivery: 'summary' }).feedbackDelivery).toBe('summary');
    expect(statusOptions({ reviewFeedbackDelivery: 'passive' }).feedbackDelivery).toBe('passive');
    expect(statusOptions({ reviewFeedbackDelivery: 'resume' }).feedbackDelivery).toBe('inbox');
  });

  test('reads explicit settings', () => {
    expect(
      statusOptions({
        reviewStatus: false,
        pollSeconds: 45,
        notifyAutomatedReviews: false,
        notifyHumanReviews: false,
      }),
    ).toEqual({
      enabled: false,
      pollSeconds: 45,
      notifyAutomatedReviews: false,
      notifyHumanReviews: false,
      feedbackDelivery: 'inbox',
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
});
