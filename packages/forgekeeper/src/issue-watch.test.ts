import { describe, expect, test } from 'bun:test';
import type { IssueSnapshot, ReviewRequest } from './forge';
import { issueProblems } from './issue-watch';

const mr = (state: string, draft = false): ReviewRequest =>
  ({
    forge: 'gitlab',
    iid: '45',
    url: 'https://gitlab.com/g/p/-/merge_requests/45',
    state,
    draft,
  }) as ReviewRequest;

const complete: IssueSnapshot = {
  open: true,
  status: 'In review',
  assignees: ['me'],
  labels: ['group::development health', 'feature::addition'],
  milestone: '18.10',
};

const ids = (issue: IssueSnapshot, ...requests: ReviewRequest[]) =>
  issueProblems(issue, requests).map((problem) => problem.id);

describe('issueProblems', () => {
  test('finds nothing wrong with an up to date issue', () => {
    expect(ids(complete, mr('opened'))).toEqual([]);
  });

  test('expects In dev for a draft MR and In review for a ready one', () => {
    const ready: IssueSnapshot = { ...complete, status: 'Ready for development' };
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

  test('flags a missing assignee, group label, type label, and milestone', () => {
    const bare: IssueSnapshot = { open: true, status: 'In review', assignees: [], labels: [] };
    expect(ids(bare, mr('opened'))).toEqual([
      'unassigned',
      'label:group',
      'label:type',
      'milestone',
    ]);
  });
});
