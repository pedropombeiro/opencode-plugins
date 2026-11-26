import { describe, expect, test } from 'bun:test';
import { extractIssueNumber, reconcileTitle } from './title';

describe('extractIssueNumber', () => {
  test.each([
    ['feature/123-add-login', '123'],
    ['123-fix-typo', '123'],
    ['fix-typo-123', '123'],
    ['user/123/some-work', '123'],
    ['gh-42-improve-perf', '42'],
    ['fix-99', '99'],
    ['hotfix/501-critical', '501'],
    ['no-number-here', undefined],
  ])('%s', (branch, expected) => {
    expect(extractIssueNumber(branch)).toBe(expected);
  });
});

describe('reconcileTitle', () => {
  test('replaces the placeholder once a reference exists', () => {
    expect(reconcileTitle('[#123, !N/A] Fix login', '[#123, !45]')).toBe('[#123, !45] Fix login');
  });

  test('replaces stale legacy references together', () => {
    expect(reconcileTitle('[#123, !45] Review changes', '[!456]')).toBe('[!456] Review changes');
  });

  test('preserves user prefixes', () => {
    expect(reconcileTitle('[WIP] Fix login', '[!456]')).toBe('[!456] [WIP] Fix login');
    expect(reconcileTitle('[!456] [WIP] Fix login', '[!789]', '[!456]')).toBe(
      '[!789] [WIP] Fix login',
    );
  });

  test('repeated reconciliation is stable', () => {
    expect(reconcileTitle('[!456] Review changes', '[!456]', '[!456]')).toBe(
      '[!456] Review changes',
    );
  });

  test('removes the managed prefix when no targets remain', () => {
    expect(reconcileTitle('[!456] Review changes', undefined, '[!456]')).toBe('Review changes');
  });

  test('preserves a renamed title', () => {
    expect(reconcileTitle('New title', '[!456]', '[!456]')).toBe('[!456] New title');
  });

  test('keeps the managed prefix whole, so it can be removed later', () => {
    const prefix = '[!101, !102, !103, +3]';
    const title = reconcileTitle(`Review ${'x'.repeat(120)}`, prefix);
    expect(title).toHaveLength(100);
    expect(title.startsWith(`${prefix} Review`)).toBe(true);
    expect(reconcileTitle(title, undefined, prefix).startsWith('Review')).toBe(true);
    // A title that is only the prefix loses it entirely.
    expect(reconcileTitle(prefix, undefined, prefix)).toBe('');
    expect(reconcileTitle(prefix, '[!46]', prefix)).toBe('[!46]');
  });

  test('preserves a user-written prefix when clearing old targets', () => {
    expect(reconcileTitle('[#12, !45] My title', undefined, '[!46]')).toBe('[#12, !45] My title');
  });

  test('truncates titles to 100 characters', () => {
    const result = reconcileTitle('x'.repeat(120), '[#1, #2]');
    expect(result).toHaveLength(100);
    expect(result.startsWith('[#1, #2] ')).toBe(true);
  });
});
