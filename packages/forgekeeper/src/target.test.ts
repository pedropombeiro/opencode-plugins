import { describe, expect, test } from 'bun:test';
import { githubTraits } from './adapters/github/adapter';
import { gitlabTraits } from './adapters/gitlab/adapter';
import {
  applyTargetChange,
  classifyTargets,
  parseTarget,
  parseTargetChange,
  targetOutput,
  targetPrefix,
  targetRequest,
  targetsPrefix,
} from './target';

describe('parseTarget', () => {
  test.each([
    ['https://gitlab.com/group/project/-/merge_requests/456', '[!456]'],
    ['https://gitlab.example.com/group/subgroup/project/-/merge_requests/456', '[!456]'],
    ['https://gitlab.com/group/project/-/issues/123', '[#123]'],
    ['https://gitlab.com/group/project/-/work_items/123', '[#123]'],
    ['https://github.com/owner/repo/pull/456', '[#456]'],
    ['https://github.com/owner/repo/issues/123', '[#123]'],
    ['https://github.example.com/owner/repo/pull/456', '[#456]'],
  ])('formats %s', (url, prefix) => {
    const target = parseTarget({ target: url });
    expect(target).toEqual({ url });
    expect(targetPrefix(target!)).toBe(prefix);
  });

  test('normalizes links and accepts an established related issue', () => {
    const target = parseTarget({
      target: 'https://gitlab.com/group/project/-/merge_requests/456/?tab=changes#note_1',
      issue_url: 'https://gitlab.com/group/other/-/issues/789',
    });
    expect(target?.url).toBe('https://gitlab.com/group/project/-/merge_requests/456');
    expect(targetPrefix(target!)).toBe('[#789, !456]');
  });

  test('supports returning to branch-based naming', () => {
    expect(parseTarget({ target: 'branch' })).toBeUndefined();
  });

  test.each([
    {},
    { target: '!456' },
    { target: 'file:///group/project/-/issues/123' },
    { target: 'https://user:password@gitlab.com/group/project/-/issues/123' },
    { target: 'https://github.com/owner/repo/pull/456/files' },
    { target: 'https://gitlab.com/group/project/-/pipelines/7' },
    { target: 'https://gitlab.com/group/project/issues/7' },
    { target: 'branch', issue_url: 'https://gitlab.com/group/project/-/issues/123' },
    {
      target: 'https://gitlab.com/group/project/-/issues/123',
      issue_url: 'https://gitlab.com/group/project/-/issues/789',
    },
    {
      target: 'https://gitlab.com/group/project/-/merge_requests/456',
      issue_url: 'https://gitlab.com/group/project/-/merge_requests/789',
    },
    {
      target: 'https://gitlab.com/group/project/-/merge_requests/456',
      issue_url: 'https://github.com/owner/repo/issues/1',
    },
  ])('rejects invalid input %j', (input) => {
    expect(() => parseTarget(input)).toThrow();
  });
});

describe('target requests and prefixes', () => {
  test('identifies pull and merge requests for source branch lookups', () => {
    expect(
      targetRequest({ url: 'https://gitlab.example.com/group/sub/project/-/merge_requests/456' }),
    ).toEqual({
      forge: 'gitlab',
      host: 'gitlab.example.com',
      project: 'group/sub/project',
      iid: '456',
    });
    expect(targetRequest({ url: 'https://github.com/owner/repo/pull/7' })).toEqual({
      forge: 'github',
      host: 'github.com',
      project: 'owner/repo',
      iid: '7',
    });
    expect(targetRequest({ url: 'https://gitlab.com/group/project/-/issues/1' })).toBeUndefined();
  });

  test('uses a branch-derived issue unless an explicit issue is set', () => {
    const url = 'https://gitlab.com/group/project/-/merge_requests/456';
    expect(targetPrefix({ url, branchIssue: '123' })).toBe('[#123, !456]');
    expect(
      targetPrefix({
        url,
        branchIssue: '123',
        issueUrl: 'https://gitlab.com/group/project/-/issues/9',
      }),
    ).toBe('[#9, !456]');
    expect(
      targetPrefix({ url: 'https://gitlab.com/group/project/-/issues/5', branchIssue: '123' }),
    ).toBe('[#5]');
  });

  test('reports only the URLs over RPC, with the first target at the top level', () => {
    expect(targetOutput(undefined)).toEqual({});
    expect(targetOutput([])).toEqual({});
    expect(targetOutput([{ url: 'u', branchIssue: '1' }])).toEqual({
      url: 'u',
      targets: [{ url: 'u' }],
    });
    expect(targetOutput([{ url: 'u', issueUrl: 'i' }, { url: 'v' }])).toEqual({
      url: 'u',
      issueUrl: 'i',
      targets: [{ url: 'u', issueUrl: 'i' }, { url: 'v' }],
    });
  });

  const mr = (iid: number) => ({
    url: `https://gitlab.com/group/project/-/merge_requests/${iid}`,
    branchIssue: '9',
  });

  test("lists only the targets' own references for several targets", () => {
    expect(targetsPrefix([])).toBeUndefined();
    expect(targetsPrefix([mr(1)])).toBe('[#9, !1]');
    expect(
      targetsPrefix([
        mr(1),
        { url: 'https://github.com/o/r/pull/2' },
        { url: 'https://gitlab.com/g/p/-/issues/3' },
      ]),
    ).toBe('[!1, #2, #3]');
    expect(targetsPrefix([mr(1), { ...mr(2), branchIssue: '8' }])).toBe('[!1, !2]');
    expect(targetsPrefix([mr(1), { url: mr(2).url }])).toBe('[!1, !2]');
  });

  test('puts first the issue that every target shares', () => {
    expect(targetsPrefix([1, 2, 3, 4].map(mr))).toBe('[#9, !1, !2, !3, !4]');
    expect(targetsPrefix([1, 2, 3, 4, 5, 6].map(mr))).toBe('[#9, !1, !2, !3, +3]');
    // An explicit issue matches the same issue inferred from a source branch.
    const explicit = { url: mr(2).url, issueUrl: 'https://gitlab.com/group/project/-/issues/9' };
    expect(targetsPrefix([mr(1), explicit])).toBe('[#9, !1, !2]');
    // The same number in another project is another issue.
    const elsewhere = {
      url: 'https://gitlab.com/group/other/-/merge_requests/3',
      branchIssue: '9',
    };
    expect(targetsPrefix([mr(1), elsewhere])).toBe('[!1, !3]');
    const shared = 'https://gitlab.com/group/project/-/issues/9';
    expect(targetsPrefix([{ ...elsewhere, issueUrl: shared }, explicit])).toBe('[#9, !3, !2]');
  });
});

const a = 'https://gitlab.com/group/project/-/merge_requests/1';
const b = 'https://gitlab.com/group/project/-/merge_requests/2';
const c = 'https://gitlab.com/other/project/-/merge_requests/3';
const issue = 'https://gitlab.com/group/project/-/issues/9';

describe('parseTargetChange', () => {
  test('defaults to replacing with a single target or branch mode', () => {
    expect(parseTargetChange({ target: a, issue_url: issue })).toEqual({
      operation: 'replace',
      targets: [{ url: a, issueUrl: issue }],
    });
    expect(parseTargetChange({ target: 'branch' })).toEqual({ operation: 'branch' });
    expect(parseTargetChange({ target: 'branch', operation: 'replace' })).toEqual({
      operation: 'branch',
    });
  });

  test('normalizes and deduplicates several targets', () => {
    expect(
      parseTargetChange({ targets: [a, `${b}?tab=diffs`, `${a}/`], operation: 'add' }),
    ).toEqual({
      operation: 'add',
      targets: [{ url: a }, { url: b }],
    });
  });

  test('relates every PR/MR in targets to a shared issue_url', () => {
    expect(
      parseTargetChange({ targets: [a, c], issue_url: `${issue}#note_1`, operation: 'add' }),
    ).toEqual({
      operation: 'add',
      targets: [
        { url: a, issueUrl: issue },
        { url: c, issueUrl: issue },
      ],
    });
  });

  test.each([
    { targets: [] },
    { targets: 'https://gitlab.com/group/project/-/merge_requests/1' },
    { targets: [a, 7] },
    { targets: [a, 'branch'] },
    { targets: [a], target: b },
    { targets: [a, issue], issue_url: issue },
    { targets: [a, 'https://github.com/o/r/pull/2'], issue_url: issue },
    { targets: [a, b], issue_url: b },
    { targets: [a], operation: 'remove', issue_url: issue },
    { targets: Array.from({ length: 51 }, (_, index) => `${a.slice(0, -1)}${index + 1}`) },
    { target: a, operation: 'merge' },
    { target: a, operation: 'remove', issue_url: issue },
    { target: 'branch', operation: 'add' },
    'nope',
  ])('rejects %j', (input) => {
    expect(() => parseTargetChange(input)).toThrow();
  });
});

describe('applyTargetChange', () => {
  const current = [
    { url: a, branchIssue: '5' },
    { url: b, issueUrl: issue },
  ];

  test('replaces the targets, keeping inferred issues of targets it keeps', () => {
    expect(
      applyTargetChange(current, {
        operation: 'replace',
        targets: [{ url: c }, { url: a }, { url: b }],
      }),
    ).toEqual({
      targets: [{ url: c }, { url: a, branchIssue: '5' }, { url: b }],
      missing: [],
    });
  });

  test('adds targets after the current ones, keeping their details', () => {
    expect(
      applyTargetChange(current, { operation: 'add', targets: [{ url: b }, { url: c }] }).targets,
    ).toEqual([{ url: a, branchIssue: '5' }, { url: b, issueUrl: issue }, { url: c }]);
    expect(
      applyTargetChange(current, { operation: 'add', targets: [{ url: a, issueUrl: issue }] })
        .targets[0],
    ).toEqual({
      url: a,
      issueUrl: issue,
    });
  });

  test("removes targets and reports the ones it didn't have", () => {
    expect(
      applyTargetChange(current, { operation: 'remove', targets: [{ url: a }, { url: c }] }),
    ).toEqual({
      targets: [{ url: b, issueUrl: issue }],
      missing: [c],
    });
  });

  test('clears every target in branch mode', () => {
    expect(applyTargetChange(current, { operation: 'branch' })).toEqual({
      targets: [],
      missing: [],
    });
  });

  test('limits how many targets a session can have', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      url: `${a.slice(0, -1)}${index + 10}`,
    }));
    const more = Array.from({ length: 30 }, (_, index) => ({
      url: `${c.slice(0, -1)}${index + 10}`,
    }));
    expect(() => applyTargetChange(many, { operation: 'add', targets: more })).toThrow(
      'at most 50',
    );
  });
});

describe('classifyTargets', () => {
  test('recognizes a PR or MR target on any forge', () => {
    expect(
      classifyTargets({ url: 'https://gitlab.com/group/project/-/merge_requests/42' }),
    ).toEqual([
      {
        kind: 'merge-request',
        ref: { forge: 'gitlab', host: 'gitlab.com', project: 'group/project', iid: '42' },
        url: 'https://gitlab.com/group/project/-/merge_requests/42',
      },
    ]);
    expect(classifyTargets({ url: 'https://github.com/owner/repo/pull/7' })).toMatchObject([
      {
        kind: 'merge-request',
        ref: { forge: 'github', host: 'github.com', project: 'owner/repo', iid: '7' },
      },
    ]);
  });

  test.each([
    'https://gitlab.com/group/project/-/issues/7',
    'https://github.com/owner/repo/issues/7',
  ])('marks an issue target as not a PR/MR: %s', (url) => {
    expect(classifyTargets({ url })).toEqual([{ kind: 'other', url }]);
  });

  test('prefers the list of targets over the first target', () => {
    expect(classifyTargets({ url: a, targets: [{ url: a }, { url: issue }] })).toMatchObject([
      { kind: 'merge-request', url: a },
      { kind: 'other', url: issue },
    ]);
  });

  test('treats a missing target as automatic', () => {
    expect(classifyTargets({})).toBeUndefined();
    expect(classifyTargets({ targets: [] })).toBeUndefined();
    expect(classifyTargets({ url: 42 })).toBeUndefined();
    expect(classifyTargets(undefined)).toBeUndefined();
  });
});

describe('parseUrl', () => {
  test('parses a GitLab MR URL in a nested group', () => {
    expect(
      gitlabTraits.parseUrl('https://gitlab.com/gitlab-org/security/gitlab/-/merge_requests/42'),
    ).toEqual({
      forge: 'gitlab',
      host: 'gitlab.com',
      project: 'gitlab-org/security/gitlab',
      iid: '42',
    });
  });

  test.each([
    'not a url',
    'https://gitlab.com/group/project/-/issues/42',
    'https://github.com/me/project/pull/42',
    'ftp://gitlab.com/group/project/-/merge_requests/42',
  ])('GitLab rejects %p', (value) => {
    expect(gitlabTraits.parseUrl(value)).toBeUndefined();
  });

  test.each([
    'https://github.com/owner/repo/issues/42',
    'https://github.com/owner/repo/pull/42/files',
    'https://gitlab.com/group/project/-/merge_requests/42',
    'https://github.com/owner/repo/pull/0',
    'https://gitlab.example.com/owner/repo/pull/42',
  ])('GitHub rejects %p', (value) => {
    expect(githubTraits.parseUrl(value)).toBeUndefined();
  });
});

describe('parseIssueUrl', () => {
  test('parses issues and work items, but not PRs/MRs', () => {
    expect(gitlabTraits.parseIssueUrl('https://gitlab.com/g/sub/p/-/work_items/3')).toMatchObject({
      project: 'g/sub/p',
      iid: '3',
    });
    expect(gitlabTraits.parseIssueUrl('https://gitlab.com/g/p/-/merge_requests/3')).toBeUndefined();
    expect(githubTraits.parseIssueUrl('https://github.com/o/r/issues/3')).toMatchObject({
      forge: 'github',
      iid: '3',
    });
    expect(githubTraits.parseIssueUrl('https://github.com/o/r/pull/3')).toBeUndefined();
  });
});
