import { describe, expect, test } from 'bun:test';
import type {
  GitHubIssueSnapshot,
  GitLabIssueSnapshot,
  IssueSnapshot,
  ReviewRequest,
} from './forge';
import { issueProblems } from './issue-watch';

const mr = (state: string, draft = false): ReviewRequest =>
  ({
    forge: 'gitlab',
    iid: '45',
    url: 'https://gitlab.com/g/p/-/merge_requests/45',
    state,
    draft,
  }) as ReviewRequest;

const pr = (state: string, draft = false, iid = '42'): ReviewRequest =>
  ({
    forge: 'github',
    iid,
    url: `https://github.com/acme/app/pull/${iid}`,
    state,
    draft,
  }) as ReviewRequest;

const complete: GitLabIssueSnapshot = {
  forge: 'gitlab',
  open: true,
  status: 'In review',
  assignees: ['me'],
  labels: ['group::development health', 'feature::addition'],
  milestone: '18.10',
  availableStatuses: ['In dev', 'In review'],
  availableLabelPrefixes: ['group::', 'feature::'],
  hasActiveMilestones: true,
};

const githubIssue = (open = true): GitHubIssueSnapshot => ({
  forge: 'github',
  open,
  url: 'https://github.com/acme/platform/issues/9',
});

const ids = (issue: IssueSnapshot, ...requests: ReviewRequest[]) =>
  issueProblems(issue, requests).map((problem) => problem.id);

describe('issueProblems', () => {
  test('finds nothing wrong with an up to date issue', () => {
    expect(ids(complete, mr('opened'))).toEqual([]);
  });

  test('expects In dev for a draft MR and In review for a ready one', () => {
    const ready: GitLabIssueSnapshot = { ...complete, status: 'Ready for development' };
    expect(ids(ready, mr('opened', true))).toEqual(['status:In dev']);
    expect(ids(ready, mr('opened'))).toEqual(['status:In review']);
    expect(ids({ ...complete, status: 'In dev' }, mr('opened', true))).toEqual([]);
  });

  test('flags a missing status, and leaves statuses off the ladder alone', () => {
    expect(ids({ ...complete, status: undefined }, mr('opened'))).toEqual(['status:In review']);
    expect(ids({ ...complete, status: 'Blocked' }, mr('opened'))).toEqual([]);
  });

  test('flags an open issue whose MRs are all merged', () => {
    expect(ids(complete, mr('merged'))).toEqual(['merged']);
    expect(ids({ ...complete, open: false }, mr('merged'))).toEqual([]);
  });

  test('skips unavailable metadata while still reporting a missing assignee', () => {
    const bare: GitLabIssueSnapshot = { forge: 'gitlab', open: true, assignees: [], labels: [] };
    expect(ids(bare, mr('opened'))).toEqual(['unassigned']);
    expect(ids({ ...bare, availableStatuses: ['In progress'] }, mr('opened'))).toEqual([
      'unassigned',
    ]);
    expect(ids({ ...bare, assignees: ['me'] }, mr('merged'))).toEqual(['merged']);
  });

  test('flags a missing assignee, group label, type label, and milestone', () => {
    const bare: GitLabIssueSnapshot = {
      ...complete,
      assignees: [],
      labels: [],
      milestone: undefined,
    };
    expect(ids(bare, mr('opened'))).toEqual([
      'unassigned',
      'label:group',
      'label:type',
      'milestone',
    ]);
  });

  test('flags only an open GitHub issue whose tracked PRs are all merged', () => {
    expect(issueProblems(githubIssue(true), [pr('merged')], 'acme/platform#9')).toEqual([
      {
        id: 'merged',
        text: 'All PRs this session tracks for acme/platform#9 have merged, but the issue is still open',
      },
    ]);
    expect(ids(githubIssue(false), pr('merged'))).toEqual([]);
    expect(ids(githubIssue(true), pr('opened'))).toEqual([]);
    expect(ids(githubIssue(true), pr('opened', true))).toEqual([]);
    expect(ids(githubIssue(true), pr('merged', false, '41'), pr('closed', false, '42'))).toEqual(
      [],
    );
  });
});
