import { expect, test } from 'bun:test';
import { subscriptionRetryAt } from './subscription-retry';

const now = Date.parse('2026-10-28T13:12:15Z');

test('honors seconds, dates and GitLab reset headers, including clock skew', () => {
  expect(subscriptionRetryAt(new Headers({ 'retry-after': '2865' }), now)).toBe(now + 2_865_000);
  expect(
    subscriptionRetryAt(new Headers({ 'retry-after': 'Wed, 28 Oct 2026 14:00:00 GMT' }), now),
  ).toBe(now + 2_865_000);
  expect(subscriptionRetryAt(new Headers({ 'ratelimit-reset': '1793196000' }), now)).toBe(
    now + 2_865_000,
  );
  expect(
    subscriptionRetryAt(
      new Headers({ 'ratelimit-resettime': 'Wed, 28 Oct 2026 14:00:00 GMT' }),
      now,
    ),
  ).toBe(now + 2_865_000);
  expect(
    subscriptionRetryAt(
      new Headers({ date: 'Wed, 28 Oct 2026 13:00:00 GMT', 'x-ratelimit-reset': '1793196000' }),
      now,
    ),
  ).toBe(now + 3_600_000);
  expect(
    subscriptionRetryAt(new Headers({ 'retry-after': '30', 'ratelimit-reset': '1793196000' }), now),
  ).toBe(now + 2_865_000);
});

test('ignores malformed, negative and expired values without creating overflowing timers', () => {
  for (const value of [
    'invalid',
    '-5',
    '1.5',
    '999999999999999999999',
    'Wed, 28 Oct 2026 12:00:00 GMT',
  ])
    expect(subscriptionRetryAt(new Headers({ 'retry-after': value }), now)).toBeUndefined();
  expect(subscriptionRetryAt(new Headers(), now)).toBeUndefined();
  expect(subscriptionRetryAt(new Headers({ 'retry-after': '0' }), now)).toBe(now);
});
