import { describe, expect, test } from 'bun:test';
import type { GitHubPullRequest, GitLabMergeRequest } from './forge';
import { prefixReferences, titlePrefix } from './forge';
import { reference, traits, traitsOf } from './forges';
import { footerSegments, responsiveFooterSegments } from './format';

const common = {
  iid: '7',
  title: 'Title',
  state: 'opened',
  draft: false,
  conflicts: false,
  conflictsKnown: true,
  approved: false,
  awaitingReviewers: [],
  reviewersComplete: true,
  targetProject: 'o/r',
  targetBranch: 'main',
  unresolvedThreads: 0,
  threadsComplete: true,
};
const merge: GitLabMergeRequest = {
  ...common,
  forge: 'gitlab',
  url: 'https://gitlab.com/o/r/-/merge_requests/7',
  hasApprovals: false,
  approvalRequirementsSatisfied: null,
  duoReviewState: 'REVIEW_STARTED',
  mergeStatus: 'CI_MUST_PASS',
};
const pull: GitHubPullRequest = {
  ...common,
  forge: 'github',
  url: 'https://github.com/o/r/pull/7',
  reviewDecision: 'CHANGES_REQUESTED',
};

describe('forge traits', () => {
  test("format references with each forge's sigil", () => {
    expect(reference(merge)).toBe('!7');
    expect(reference(pull)).toBe('#7');
    expect(traits('gitlab').reference('45')).toBe('!45');
    expect(traits('github').reference('45')).toBe('#45');
  });

  test.each([
    ['[#597600, !259332] Reviewing MRs', ['259332'], ['597600']],
    ['[#42, #108] Fix things', [], ['42', '108']],
    ['[!42] Title', ['42'], []],
    ['[tidy-up, #N/A] Branch without a PR', [], []],
    ['Fix !42 and #7 later', [], []],
    ['[a!42, b#7] Not references', [], []],
    [undefined, [], []],
  ])('find title references in %p', (title, gitlab, github) => {
    expect(traits('gitlab').titleReferences(title)).toEqual(gitlab);
    expect(traits('github').titleReferences(title)).toEqual(github);
  });

  test('read only the managed prefix', () => {
    expect(titlePrefix('[#1, !2] Title [!3]')).toBe('[#1, !2]');
    expect(titlePrefix('Title')).toBe('');
    expect(prefixReferences('[$12, $0, $1.5] Title', '$')).toEqual(['12']);
  });

  test('recognize hosts and own requests', () => {
    expect(traits('gitlab').recognizes('gitlab.example.com')).toBe(true);
    expect(traits('gitlab').recognizes('github.com')).toBe(false);
    expect(traits('github').recognizes('github.com')).toBe(false);
    expect(traits('gitlab').owns(merge)).toBe(true);
    expect(traits('gitlab').owns(pull)).toBe(false);
    expect(traits('github').owns(pull)).toBe(true);
  });

  test("resolve the traits of a request's own forge", () => {
    expect(traitsOf(merge)).toBe(traits('gitlab'));
    expect(traitsOf(pull)).toBe(traits('github'));
    expect(traitsOf(merge).details(merge)).toEqual([
      'Human approvals: no · Approval requirements satisfied: unknown',
      'Merge status: ci must pass',
    ]);
    expect(traitsOf(pull).details(pull)).toEqual(['Review decision: changes requested']);
  });

  test('contribute forge-specific footer indicators', () => {
    const text = (request: GitLabMergeRequest | GitHubPullRequest) =>
      footerSegments({ loading: false, lookup: { kind: 'found', requests: [request] } }).map(
        (segment) => segment.text,
      );
    expect(text(merge)).toEqual(['!7', 'no pipeline', '🤖 reviewing']);
    expect(text(pull)).toEqual(['#7', 'no checks', 'changes requested']);
    const fit = (width: number) =>
      responsiveFooterSegments(
        { loading: false, lookup: { kind: 'found', requests: [pull] } },
        width,
      ).map((segment) => segment.text);
    expect(fit(30)).toEqual(['#7', 'no CI', 'changes requested']);
    expect(fit(29)).toEqual(['#7', 'changes requested']);
  });

  test("name multiple requests with their forge's noun", () => {
    const text = (requests: Array<GitLabMergeRequest | GitHubPullRequest>) =>
      footerSegments({ loading: false, lookup: { kind: 'found', requests } }).at(-1)?.text;
    expect(text([merge, { ...merge, iid: '8' }])).toBe('2 open MRs, run /mr-status');
    expect(text([pull, { ...pull, iid: '8' }])).toBe('2 open PRs, run /pr-status');
  });
});
