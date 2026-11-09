import { describe, expect, test } from 'bun:test';
import { parseDuration, resolveWarming } from './warming';

test('parseDuration', () => {
  expect(parseDuration('4 minutes')).toBe(240_000);
  expect(parseDuration('30 seconds')).toBe(30_000);
  expect(parseDuration('1 hour')).toBe(3_600_000);
  expect(parseDuration('2 hours')).toBe(7_200_000);
  expect(parseDuration('5m')).toBe(300_000);
  expect(parseDuration('500ms')).toBe(500);
  expect(parseDuration('1 day')).toBe(86_400_000);
  expect(parseDuration('0 minutes')).toBeUndefined();
  expect(parseDuration('soon')).toBeUndefined();
  expect(parseDuration(4)).toBeUndefined();
});

describe('resolveWarming', () => {
  test('is off unless configured', () => {
    expect(resolveWarming({})).toBeUndefined();
    expect(resolveWarming({ top: false })).toBeUndefined();
  });

  test('uses the defaults when enabled', () => {
    expect(resolveWarming({ top: true })).toEqual({ interval: 240_000, duration: 1_800_000 });
  });

  test('reads the object form', () => {
    expect(resolveWarming({ top: { interval: '2 minutes', duration: '1 hour' } })).toEqual({
      interval: 120_000,
      duration: 3_600_000,
    });
  });

  test('derives an automatic interval from the cache lifetime', () => {
    expect(resolveWarming({ top: { interval: 'auto' }, ttl: 300_000 })).toEqual({
      interval: 270_000,
      duration: 1_800_000,
    });
    expect(resolveWarming({ top: { interval: 'auto' } })).toBeUndefined();
  });

  test('lets a model override its provider and the top level', () => {
    expect(resolveWarming({ top: true, provider: true, model: false })).toBeUndefined();
    expect(resolveWarming({ top: false, provider: { interval: '3 minutes' } })).toEqual({
      interval: 180_000,
      duration: 1_800_000,
    });
  });

  test('fills missing fields from the top level', () => {
    expect(
      resolveWarming({ top: { duration: '1 hour' }, provider: { interval: '2 minutes' } }),
    ).toEqual({ interval: 120_000, duration: 3_600_000 });
  });

  test('falls back to the top level when a narrower setting is invalid', () => {
    expect(resolveWarming({ top: true, model: { interval: 'often' } })).toEqual({
      interval: 240_000,
      duration: 1_800_000,
    });
  });

  test('skips warming when the interval is not shorter than the duration', () => {
    expect(resolveWarming({ top: { interval: '1 hour', duration: '30 minutes' } })).toBeUndefined();
  });
});
