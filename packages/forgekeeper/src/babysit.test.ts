import { describe, expect, test } from 'bun:test';
import { createBabysitter, evaluate, isReady, startPrompt, type BabysitRecord } from './babysit';
import type { GitLabMergeRequest } from './forge';

const request = (overrides: Partial<GitLabMergeRequest> = {}) =>
  ({
    forge: 'gitlab',
    iid: '1',
    url: 'https://gitlab.com/group/a/-/merge_requests/1',
    state: 'opened',
    headSha: 'aaaa',
    pipeline: { status: 'RUNNING', label: 'running' },
    conflicts: false,
    conflictsKnown: true,
    unresolvedThreads: 0,
    threadsComplete: true,
    ...overrides,
  }) as GitLabMergeRequest;

const passed = { status: 'SUCCESS', label: 'passed' };
const failed = { status: 'FAILED', label: 'failed' };

describe('isReady', () => {
  test('needs green CI, known mergeability, no threads, and no running review', () => {
    expect(isReady(request({ pipeline: passed }))).toBe(true);
    expect(isReady(request())).toBe(false);
    expect(isReady(request({ pipeline: passed, conflictsKnown: false }))).toBe(false);
    expect(isReady(request({ pipeline: passed, unresolvedThreads: 1 }))).toBe(false);
    expect(isReady(request({ pipeline: passed, threadsComplete: false }))).toBe(false);
    expect(isReady(request({ pipeline: passed, duoReviewState: 'REVIEW_STARTED' }))).toBe(false);
  });
});

describe('evaluate', () => {
  test('records a baseline without events, unless the MR is already done', () => {
    expect(evaluate({}, request({ pipeline: failed }))).toEqual({
      next: { observed: true, sha: 'aaaa', ci: 'FAILED' },
      events: [],
    });
    expect(evaluate({}, request({ pipeline: passed })).events).toEqual(['ready']);
    expect(evaluate({}, request({ state: 'closed' })).events).toEqual(['closed']);
  });

  test('reports a CI failure once per head commit and status', () => {
    const seen = { observed: true, sha: 'aaaa', ci: 'RUNNING' };
    const first = evaluate(seen, request({ pipeline: failed }));
    expect(first.events).toEqual(['ci-failed']);
    expect(evaluate(first.next, request({ pipeline: failed })).events).toEqual([]);
    expect(evaluate(first.next, request({ headSha: 'bbbb', pipeline: failed })).events).toEqual([
      'ci-failed',
    ]);
    expect(
      evaluate(seen, request({ pipeline: { status: 'CANCELED', label: 'canceled' } })).events,
    ).toEqual(['ci-canceled']);
  });

  test('reports new merge conflicts only once', () => {
    const seen = { observed: true, sha: 'aaaa', ci: 'RUNNING' };
    const first = evaluate(seen, request({ conflicts: true }));
    expect(first.events).toEqual(['conflict']);
    expect(evaluate(first.next, request({ conflicts: true })).events).toEqual([]);
    expect(evaluate(seen, request({ conflicts: true, conflictsKnown: false })).events).toEqual([]);
  });
});

describe('startPrompt', () => {
  test('lists the PRs/MRs and names the skill only when given', () => {
    const urls = ['https://gitlab.com/group/a/-/merge_requests/1'];
    expect(startPrompt(urls)).toContain(urls[0]);
    expect(startPrompt(urls)).not.toContain('skill');
    expect(startPrompt(urls, 'team-babysit')).toContain('Load the `team-babysit` skill');
  });
});

describe('createBabysitter', () => {
  test('reports a change only when the PRs/MRs it babysits change', async () => {
    const records = new Map<string, BabysitRecord>();
    const changes: string[] = [];
    const babysitter = createBabysitter({
      directory: '/repo',
      read: async (sessionID) => records.get(sessionID),
      write: async (sessionID, record) =>
        void (record ? records.set(sessionID, record) : records.delete(sessionID)),
      scan: async () => [...records].map(([sessionID, record]) => ({ sessionID, record })),
      send: async () => [],
      changed: (sessionID) => changes.push(sessionID),
    });
    const a = 'https://gitlab.com/group/a/-/merge_requests/1';
    const b = 'https://gitlab.com/group/b/-/merge_requests/1';

    await babysitter.start('one', [a]);
    expect(changes).toEqual(['one']);
    await babysitter.start('one', [a]);
    expect(changes).toEqual(['one']);
    await babysitter.start('one', [b]);
    expect(changes).toEqual(['one', 'one']);
    await babysitter.stop('one', [a]);
    expect(changes).toHaveLength(3);
    await babysitter.prune('one', (url) => url === b);
    expect(changes).toHaveLength(3);
    await babysitter.prune('one', () => false);
    expect(changes).toHaveLength(4);
    await babysitter.stop('one');
    expect(changes).toHaveLength(4);
  });
});
