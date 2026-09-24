import { describe, expect, test } from 'bun:test';
import { detectForge, extractIssueNumber, prefixTitle } from './title.ts';

const found = (iid: string) => async () => iid;
const missing = async () => undefined;

describe('detectForge', () => {
  test('recognizes GitHub and GitLab remotes', () => {
    expect(detectForge('git@github.com:owner/repo.git')).toBe('github');
    expect(detectForge('https://gitlab.com/group/project.git')).toBe('gitlab');
    expect(detectForge('https://example.com/repo.git')).toBeUndefined();
  });
});

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

describe('prefixTitle', () => {
  test('adds the issue and merge request references', async () => {
    expect(await prefixTitle('Fix login', 'gitlab', '123-fix-login', found('45'))).toBe(
      '[#123, !45] Fix login',
    );
  });

  test('uses the branch name and a placeholder when nothing is found', async () => {
    expect(await prefixTitle('Tidy up', 'github', 'tidy-up', missing)).toBe(
      '[tidy-up, #N/A] Tidy up',
    );
  });

  test('replaces the placeholder once a reference exists', async () => {
    expect(await prefixTitle('[#123, !N/A] Fix login', 'gitlab', '123-x', found('45'))).toBe(
      '[#123, !45] Fix login',
    );
  });

  test('keeps the placeholder while no reference exists', async () => {
    expect(await prefixTitle('[#123, !N/A] Fix login', 'gitlab', '123-x', missing)).toBeUndefined();
  });

  test('appends a reference to a prefix that lacks one', async () => {
    expect(await prefixTitle('[WIP] Fix login', 'gitlab', '123-x', found('45'))).toBe(
      '[WIP, !45] Fix login',
    );
  });

  test('leaves titles that already carry a reference alone', async () => {
    let looked = false;
    const result = await prefixTitle('[#123, !45] Fix login', 'gitlab', '123-x', async () => {
      looked = true;
      return '99';
    });
    expect(result).toBeUndefined();
    expect(looked).toBe(false);
  });

  test('truncates titles to 100 characters', async () => {
    const result = await prefixTitle('x'.repeat(120), 'github', '1-a', found('2'));
    expect(result).toHaveLength(100);
    expect(result?.startsWith('[#1, #2] ')).toBe(true);
  });
});
