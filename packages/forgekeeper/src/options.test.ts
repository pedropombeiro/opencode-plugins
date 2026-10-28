import { describe, expect, test } from 'bun:test';
import { statusOptions } from './options';

describe('statusOptions', () => {
  test('monitors feedback without resuming sessions by default', () => {
    expect(statusOptions(undefined)).toEqual({
      enabled: true,
      pollSeconds: 120,
      notifyAutomatedReviews: true,
      notifyHumanReviews: true,
    });
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
