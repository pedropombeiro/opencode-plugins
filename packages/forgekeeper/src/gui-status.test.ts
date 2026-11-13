import { describe, expect, test } from 'bun:test';
import type { GitLabMergeRequest } from './forge';
import { statusPill } from './gui-status';
import type { Snapshot } from './store';

const mr = (overrides: Partial<GitLabMergeRequest> = {}): GitLabMergeRequest => ({
  forge: 'gitlab',
  iid: '4281',
  title: 'Add things',
  url: 'https://gitlab.com/group/project/-/merge_requests/4281',
  state: 'opened',
  draft: false,
  conflicts: false,
  conflictsKnown: true,
  approved: false,
  hasApprovals: false,
  approvalRequirementsSatisfied: false,
  awaitingReviewers: ['david'],
  reviewersComplete: true,
  targetProject: 'group/project',
  targetBranch: 'main',
  headSha: 'local',
  pipeline: { status: 'SUCCESS', label: 'passed' },
  unresolvedThreads: 2,
  threadsComplete: true,
  ...overrides,
});

const snapshot = (requests: GitLabMergeRequest[]): Snapshot => ({
  lookup: { kind: 'found', explicitTarget: true, requests },
  loading: false,
});

function harness() {
  const calls: string[] = [];
  return {
    calls,
    actions: {
      external: (url: string) => {
        calls.push(url);
      },
      status: () => {
        calls.push('status');
      },
      feedback: () => {
        calls.push('feedback');
      },
    },
  };
}

describe('Desktop status pill', () => {
  test('keeps unknown mergeability after pending reviewers', () => {
    const { actions } = harness();
    const pill = statusPill(snapshot([mr({ conflictsKnown: false })]), undefined, actions);
    expect(pill?.label).toBe('!4281 · 💬 2 · ✓ CI · ◷ @david · mergeability unknown');
    expect(pill?.rows?.map((row) => row.label)).toContain('mergeability unknown');
  });
  test('shows compact symbols and counts with unresolved threads before successful CI', () => {
    const { actions } = harness();
    const pill = statusPill(
      snapshot([mr({ duoReviewState: 'REVIEW_STARTED' })]),
      undefined,
      actions,
    );
    expect(pill?.label).toBe('!4281 · 💬 2 · 🤖 · ✓ CI · ◷ @david');
    expect(pill?.tone).toBe('warning');
  });

  test('preserves dropdown status links, panel actions, and feedback', () => {
    const { actions, calls } = harness();
    const pill = statusPill(snapshot([mr()]), '2 review updates', actions)!;
    expect(pill.label).toBe('!4281 · 💬 2 · ✓ CI · ◷ @david · ↻ 2');
    expect(pill.title).toBe('PR/MR status');
    expect(pill.rows?.map((row) => row.label)).toEqual([
      '!4281',
      'CI passed',
      '2 unresolved threads',
      'awaiting @david',
      'Show PR/MR status',
      '2 review updates',
    ]);
    pill.rows?.[0].run?.();
    pill.rows?.find((row) => row.id === 'details')?.run?.();
    pill.rows?.find((row) => row.id === 'feedback')?.run?.();
    expect(calls).toEqual([mr().url, 'status', 'feedback']);
  });

  test('keeps the most urgent tone', () => {
    const { actions } = harness();
    expect(statusPill(snapshot([mr({ conflicts: true })]), undefined, actions)?.tone).toBe(
      'danger',
    );
    expect(statusPill(snapshot([mr({ state: 'merged' })]), undefined, actions)?.tone).toBe(
      'success',
    );
    expect(
      statusPill(snapshot([mr({ state: 'closed' })]), undefined, actions)?.tone,
    ).toBeUndefined();
  });

  test('keeps all branch-discovered MR references before the warning', () => {
    const { actions, calls } = harness();
    const requests = [
      mr(),
      mr({ iid: '4282', url: 'https://gitlab.com/group/project/-/merge_requests/4282' }),
    ];
    const pill = statusPill(
      { loading: false, lookup: { kind: 'found', explicitTarget: false, requests } },
      undefined,
      actions,
    );
    expect(pill?.label).toBe('!4281 · !4282 · 2 open MRs, run /mr-status');
    expect(pill?.rows?.map((row) => row.label)).toEqual([
      '!4281',
      '!4282',
      '2 open MRs, run /mr-status',
      'Show PR/MR status',
    ]);
    pill?.rows?.[0].run?.();
    pill?.rows?.[1].run?.();
    expect(calls).toEqual(requests.map((request) => request.url));
  });

  test('prioritizes failed CI and conflicts in multi-target summaries', () => {
    const { actions } = harness();
    expect(
      statusPill(
        snapshot([
          mr({ pipeline: { status: 'FAILED', label: 'failed' } }),
          mr({ iid: '4282', duoReviewState: 'REVIEW_STARTED', conflicts: true }),
        ]),
        undefined,
        actions,
      )?.label,
    ).toBe('2 MRs · ✗ CI 1 · 1 conflict · 🤖 1');
  });

  test('puts failures and conflicts before threads and secondary status', () => {
    const { actions } = harness();
    const pill = statusPill(
      snapshot([
        mr({
          iid: '266177',
          conflicts: true,
          pipeline: { status: 'FAILED', label: 'failed' },
          awaitingReviewers: ['a', 'b'],
        }),
      ]),
      undefined,
      actions,
    );
    expect(pill?.label).toBe('!266177 · ✗ CI · conflicts · 💬 2 · ◷ @a +1');
    expect(pill?.rows?.find((row) => row.label === 'CI failed')?.tone).toBe('danger');
  });

  test('retains incomplete thread counts, reviewer totals, and paused feedback', () => {
    const { actions } = harness();
    const pill = statusPill(
      snapshot([
        mr({
          unresolvedThreads: 1,
          threadsComplete: false,
          awaitingReviewers: ['a', 'b', 'c'],
        }),
      ]),
      '3 review updates (paused)',
      actions,
    );
    expect(pill?.label).toBe('!4281 · 💬 1+ · ✓ CI · ◷ @a +2 · ↻ 3 (paused)');
    expect(pill?.rows?.map((row) => row.label)).toContain('1+ unresolved threads');
    expect(pill?.rows?.map((row) => row.label)).toContain('awaiting @a, @b, @c');
  });

  test.each([
    ['RUNNING', 'running', '… CI'],
    ['CANCELED', 'canceled', 'CI canceled'],
  ])('preserves CI state for %s', (status, label, expected) => {
    const { actions } = harness();
    expect(
      statusPill(
        snapshot([
          mr({
            pipeline: { status, label },
            unresolvedThreads: 0,
            awaitingReviewers: [],
          }),
        ]),
        undefined,
        actions,
      )?.label,
    ).toBe(`!4281 · ${expected}`);
  });

  test('shows feedback on its own and hides an empty pill', () => {
    const { actions } = harness();
    expect(statusPill({ loading: false }, undefined, actions)).toBeUndefined();
    expect(statusPill({ loading: false }, '2 updates', actions)?.label).toBe('2 updates');
  });
});
