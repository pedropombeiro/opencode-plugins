import { describe, expect, test } from 'bun:test';
import type { GraphQL } from './adapter';
import { fetchComments, fetchDetails, MAX_COMMENT_PAGES, toComment } from './feedback';

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

describe('fetchDetails', () => {
  const base = 'b'.repeat(40);
  const head = 'a'.repeat(40);
  const file = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n');
  const note = (id: string, overrides: Record<string, unknown> = {}) => ({
    id: `gid://gitlab/DiffNote/${id}`,
    url: `https://gitlab.com/g/p/-/merge_requests/1#note_${id}`,
    body: `Body ${id}`,
    author: { username: 'GitLabDuo' },
    position: null,
    discussion: {
      notes: { nodes: [{ id: `gid://gitlab/DiffNote/${id}`, body: 'x', author: null }] },
    },
    ...overrides,
  });

  function forge(notes: Record<string, unknown>, blobs: (query: string) => unknown) {
    const queries: string[] = [];
    const transport: GraphQL = async (_host, query) => {
      queries.push(query);
      if (query.includes('blobs(')) return blobs(query);
      const ids = [...query.matchAll(/(n\d+): note\(id: "gid:\/\/gitlab\/Note\/(\d+)"\)/g)];
      return Object.fromEntries(ids.map(([, alias, id]) => [alias, notes[id] ?? null]));
    };
    return { transport, queries };
  }

  test('reads notes in batches, with earlier thread replies and the code around their line', async () => {
    const reply = { id: 'gid://gitlab/Note/1', body: 'Why?', author: { username: 'bob' } };
    const notes: Record<string, unknown> = {
      '2': note('2', {
        position: {
          diffRefs: { baseSha: base, headSha: head },
          newPath: 'a.rb',
          newLine: 15,
          oldPath: 'a.rb',
          oldLine: null,
        },
        discussion: {
          notes: {
            nodes: [
              reply,
              { id: 'gid://gitlab/DiffNote/2', body: 'x', author: null },
              { id: 'gid://gitlab/Note/9', body: 'Later', author: { username: 'c' } },
            ],
          },
        },
      }),
      // A removed line is read from the base commit.
      '3': note('3', {
        position: {
          diffRefs: { baseSha: base, headSha: head },
          newPath: 'b.rb',
          newLine: null,
          oldPath: 'old.rb',
          oldLine: 2,
        },
      }),
    };
    for (let id = 10; id < 40; id++) notes[String(id)] = note(String(id));
    // Commits are queried in the order the notes name them: head, then base.
    const { transport, queries } = forge(notes, () => ({
      b0: { repository: { blobs: { nodes: [{ path: 'a.rb', rawTextBlob: file }] } } },
      b1: { repository: { blobs: { nodes: [{ path: 'old.rb', rawTextBlob: 'gone 1\ngone 2' }] } } },
    }));
    const ids = [
      '2',
      'gid://gitlab/Note/5"){ x }',
      '3',
      ...Object.keys(notes).filter((id) => Number(id) >= 10),
    ];
    const details = await fetchDetails(transport, 'gitlab.com', 'g/p', ids);
    expect(queries.filter((query) => query.includes('note(id:'))).toHaveLength(2);
    expect(queries.join('')).not.toContain('{ x }');
    const blobQuery = queries.find((query) => query.includes('blobs('))!;
    expect(blobQuery).toContain(`ref: "${head}"`);
    expect(blobQuery).toContain('fullPath: "g/p"');
    expect(details).toHaveLength(32);
    expect(details[0]).toMatchObject({
      id: '2',
      path: 'a.rb',
      line: 15,
      replies: [{ username: 'bob', body: 'Why?' }],
    });
    expect(details[0].code?.text.split('\n')).toHaveLength(21);
    expect(details[0].code?.text).toContain('>15: line 15');
    expect(details[0].code?.text).toContain(' 5: line 5');
    expect(details[1]).toMatchObject({
      id: '3',
      path: 'old.rb',
      line: 2,
      code: { path: 'old.rb', text: ' 1: gone 1\n>2: gone 2' },
    });
    expect(details[2]).not.toHaveProperty('code');
    expect(details[2]).not.toHaveProperty('replies');
  });

  test('summarizes the comments without code when the files cannot be read', async () => {
    const { transport } = forge(
      {
        '2': note('2', {
          position: {
            diffRefs: { baseSha: base, headSha: head },
            newPath: 'a.rb',
            newLine: 1,
            oldPath: null,
            oldLine: null,
          },
        }),
      },
      () => {
        throw new Error('too large');
      },
    );
    const [detail] = await fetchDetails(transport, 'gitlab.com', 'g/p', ['2']);
    expect(detail).toMatchObject({ id: '2', body: 'Body 2', line: 1 });
    expect(detail).not.toHaveProperty('code');
  });
});
