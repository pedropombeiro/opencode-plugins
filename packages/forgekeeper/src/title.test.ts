import { describe, expect, test } from 'bun:test';
import { traits } from './forges';
import { branchPrefix, extractIssueNumber, reconcileTitle } from './title';

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

describe('branchPrefix', () => {
  test('adds the issue and merge request references', () => {
    expect(branchPrefix(traits('gitlab'), '123-fix-login', '45')).toBe('[#123, !45]');
  });

  test('uses the branch name and a placeholder when nothing is found', () => {
    expect(branchPrefix(traits('github'), 'tidy-up', undefined)).toBe('[tidy-up, #N/A]');
    expect(branchPrefix(traits('gitlab'), 'tidy-up', undefined)).toBe('[tidy-up, !N/A]');
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

  test('removes the managed prefix when resetting on a default branch', () => {
    expect(reconcileTitle('[!456] Review changes', undefined, '[!456]')).toBe('Review changes');
  });

  test('preserves a renamed title', () => {
    expect(reconcileTitle('New title', '[!456]', '[!456]')).toBe('[!456] New title');
  });

  test('keeps a long branch prefix whole, so it can be removed later', () => {
    const branch = 'a-very-long-branch-name-that-describes-everything-it-changes-in-detail';
    const prefix = branchPrefix(traits('gitlab'), branch, '45');
    expect(prefix).toBe('[a-very-long-branch-name-that-describes-…, !45]');
    const title = reconcileTitle(`Review ${'x'.repeat(120)}`, prefix);
    expect(title).toHaveLength(100);
    expect(title.startsWith(`${prefix} Review`)).toBe(true);
    // Back on the default branch, the stored prefix still matches the title.
    expect(reconcileTitle(title, undefined, prefix).startsWith('Review')).toBe(true);
    // A title that is only the prefix loses it entirely.
    expect(reconcileTitle(prefix, undefined, prefix)).toBe('');
    expect(reconcileTitle(prefix, '[!46]', prefix)).toBe('[!46]');
  });

  test('truncates titles to 100 characters', () => {
    const result = reconcileTitle('x'.repeat(120), '[#1, #2]');
    expect(result).toHaveLength(100);
    expect(result.startsWith('[#1, #2] ')).toBe(true);
  });
});
