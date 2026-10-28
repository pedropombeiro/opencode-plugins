import { describe, expect, test } from 'bun:test';
import type { GraphQL } from './adapter';
import { fetchComments, MAX_COMMENT_PAGES, toComment } from './feedback';

const node = (id: string, overrides: Record<string, unknown> = {}) => ({
  id: `gid://gitlab/DiscussionNote/${id}`,
  url: `https://gitlab.com/g/p/-/merge_requests/1#note_${id}`,
  createdAt: '2026-10-09T10:00:00Z',
  updatedAt: '2026-10-09T10:05:00Z',
  lastEditedAt: '2026-10-09T10:03:00Z',
  system: false,
  discussion: { resolved: false },
  author: { id: 'gid://gitlab/User/2', username: 'alice', bot: false },
  ...overrides,
});

// `previous` is the cursor for the page of older comments, if there is one.
const page = (
  nodes: unknown[],
  previous?: string,
  viewer: string | null = 'gid://gitlab/User/1',
) => ({
  currentUser: viewer ? { id: viewer } : null,
  project: {
    mergeRequest: {
      notes: { pageInfo: { hasPreviousPage: !!previous, startCursor: previous ?? null }, nodes },
    },
  },
});

describe('toComment', () => {
  test('classifies Duo diff findings and workflow identity without treating summaries as findings', () => {
    const author = { id: 'duo', username: 'GitLabDuo', bot: true };
    const duoCreatedSession = {
      id: 'workflow-1',
      status: 'FINISHED',
      workflowDefinition: 'code_review/v1',
    };
    expect(
      toComment(node('5', { author, position: { newPath: 'src/a.ts' }, duoCreatedSession }))
        ?.automated,
    ).toEqual({ reviewer: 'GitLab Duo', finding: true, runID: 'workflow-1', status: 'FINISHED' });
    expect(
      toComment(node('6', { author, position: null, duoCreatedSession: null }))?.automated,
    ).toEqual({ reviewer: 'GitLab Duo', finding: false });
    expect(
      toComment(node('7', { author, position: { newPath: 'a' }, duoCreatedSession: null }))
        ?.automated,
    ).toEqual({ reviewer: 'GitLab Duo', finding: true });
    expect(
      toComment(node('8', { position: { newPath: 'a' }, duoCreatedSession }))?.automated,
    ).toBeUndefined();
  });
  test('uses the numeric ID as the order and the last edit time', () => {
    expect(toComment(node('5'))).toEqual({
      id: '5',
      order: 5,
      url: 'https://gitlab.com/g/p/-/merge_requests/1#note_5',
      editedAt: Date.parse('2026-10-09T10:03:00Z'),
      resolved: false,
      bot: false,
      authorID: 'gid://gitlab/User/2',
      username: 'alice',
    });
  });

  test('falls back to the update and creation times', () => {
    expect(toComment(node('5', { lastEditedAt: null }))?.editedAt).toBe(
      Date.parse('2026-10-09T10:05:00Z'),
    );
    expect(toComment(node('5', { lastEditedAt: null, updatedAt: null }))?.editedAt).toBe(
      Date.parse('2026-10-09T10:00:00Z'),
    );
  });

  test('skips system notes and notes without an author or a valid time', () => {
    expect(toComment(node('5', { system: true }))).toBeUndefined();
    expect(toComment(node('5', { author: null }))).toBeUndefined();
    expect(toComment(node('5', { lastEditedAt: 'nope' }))).toBeUndefined();
    expect(toComment(node('5', { id: 'gid://gitlab/Note/abc' }))).toBeUndefined();
  });

  test("reads the thread's resolution", () => {
    expect(toComment(node('5', { discussion: { resolved: true } }))?.resolved).toBe(true);
  });
});

describe('fetchComments', () => {
  test('falls back for older GitLab schemas without hiding other errors', async () => {
    const queries: string[] = [];
    const transport: GraphQL = async (_host, query) => {
      queries.push(query);
      if (query.includes('duoCreatedSession'))
        throw new Error("Field 'duoCreatedSession' doesn't exist on type 'Note'");
      return page([node('1')]);
    };
    expect((await fetchComments(transport, 'gitlab.com', 'g/p', '1'))?.complete).toBe(true);
    expect(queries).toHaveLength(2);
    expect(queries[1]).not.toContain('duoCreatedSession');
    await expect(
      fetchComments(
        async () => {
          throw new Error('rate limit');
        },
        'gitlab.com',
        'g/p',
        '1',
      ),
    ).rejects.toThrow('rate limit');
  });
  test('pages backwards from the newest comment and returns them oldest first', async () => {
    const calls: Record<string, string>[] = [];
    const graphql: GraphQL = async (_host, _query, variables) => {
      calls.push(variables);
      return variables.before ? page([node('1'), node('2')]) : page([node('3'), node('4')], 'c3');
    };
    const snapshot = await fetchComments(graphql, 'gitlab.com', 'g/p', '1');
    expect(snapshot?.complete).toBe(true);
    expect(snapshot?.viewerID).toBe('gid://gitlab/User/1');
    expect(snapshot?.comments.map((n) => n.id)).toEqual(['1', '2', '3', '4']);
    expect(calls).toEqual([
      { project: 'g/p', iid: '1' },
      { project: 'g/p', iid: '1', before: 'c3' },
    ]);
  });

  test('returns undefined for a missing MR', async () => {
    const graphql: GraphQL = async () => ({
      currentUser: { id: 'u' },
      project: { mergeRequest: null },
    });
    expect(await fetchComments(graphql, 'gitlab.com', 'g/p', '1')).toBeUndefined();
  });

  test('stops at the newest comments and treats the full window as complete', async () => {
    let calls = 0;
    // Each call returns an older page, with lower IDs.
    const graphql: GraphQL = async () => {
      calls++;
      return page([node(String(1000 - calls))], `c${calls}`);
    };
    const snapshot = await fetchComments(graphql, 'gitlab.com', 'g/p', '1');
    expect(calls).toBe(MAX_COMMENT_PAGES);
    expect(snapshot?.complete).toBe(true);
    expect(snapshot?.comments.at(0)?.id).toBe(String(1000 - MAX_COMMENT_PAGES));
    expect(snapshot?.comments.at(-1)?.id).toBe('999');
  });

  test('marks a snapshot incomplete when an older page disappears', async () => {
    const graphql: GraphQL = async (_host, _query, variables) =>
      variables.before ? { project: null } : page([node('2')], 'c2');
    expect((await fetchComments(graphql, 'gitlab.com', 'g/p', '1'))?.complete).toBe(false);
  });

  test('marks a snapshot incomplete when the older page has no cursor', async () => {
    const graphql: GraphQL = async () => ({
      currentUser: { id: 'u' },
      project: {
        mergeRequest: {
          notes: { pageInfo: { hasPreviousPage: true, startCursor: null }, nodes: [] },
        },
      },
    });
    expect((await fetchComments(graphql, 'gitlab.com', 'g/p', '1'))?.complete).toBe(false);
  });

  test("marks a snapshot incomplete without the viewer's ID", async () => {
    const graphql: GraphQL = async () => page([node('1')], undefined, null);
    expect((await fetchComments(graphql, 'gitlab.com', 'g/p', '1'))?.complete).toBe(false);
  });
});
