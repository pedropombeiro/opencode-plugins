import { describe, expect, test } from 'bun:test';
import {
  fetchComments,
  MAX_COMMENT_PAGES,
  toInlineComment,
  toIssueComment,
  toReview,
} from './feedback';
import type { GraphQL } from './adapter';
import type { GitHubPullRequest } from '../../forge';
import {
  applyFeedback,
  createFeedbackWatcher,
  FETCH_INTERVAL,
  RETRY_DELAY,
  SETTLE_TIME,
  type FeedbackRecord,
} from '../../human-review-watch';

const user = { __typename: 'User', login: 'alice', id: 'alice' };

const issueComment = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  url: `https://github.com/o/r/pull/1#issuecomment-${id}`,
  createdAt: '2026-10-09T10:00:00Z',
  publishedAt: '2026-10-09T10:01:00Z',
  lastEditedAt: '2026-10-09T10:03:00Z',
  isMinimized: false,
  author: user,
  ...overrides,
});

const review = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  url: `https://github.com/o/r/pull/1#pullrequestreview-${id}`,
  state: 'COMMENTED',
  body: 'Please rework this.',
  submittedAt: '2026-10-09T10:02:00Z',
  lastEditedAt: null,
  isMinimized: false,
  author: user,
  ...overrides,
});

const inline = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  url: `https://github.com/o/r/pull/1#discussion_r${id}`,
  state: 'SUBMITTED',
  createdAt: '2026-10-09T09:00:00Z',
  publishedAt: '2026-10-09T10:04:00Z',
  lastEditedAt: null,
  isMinimized: false,
  author: user,
  ...overrides,
});

const thread = (comments: unknown[], isResolved = false, previous?: string, id = 'PRT_1') => ({
  id,
  isResolved,
  comments: connection(comments, previous),
});

// `previous` is the cursor for the page of older items, if there is one.
const connection = (nodes: unknown[], previous?: string) => ({
  pageInfo: { hasPreviousPage: !!previous, startCursor: previous ?? null },
  nodes,
});

interface Lists {
  comments?: unknown;
  reviews?: unknown;
  reviewThreads?: unknown;
}

// Answers each list's query with its own connection, or null for a missing one.
const reply = (lists: Lists, viewer: string | null = 'bob') => ({
  viewer: viewer ? { id: viewer } : null,
  repository: {
    pullRequest: {
      comments: lists.comments ?? connection([]),
      reviews: lists.reviews ?? connection([]),
      reviewThreads: lists.reviewThreads ?? connection([]),
    },
  },
});

describe('toIssueComment', () => {
  test('orders by the publish time and reads the last edit time', () => {
    expect(toIssueComment(issueComment('IC_1'))).toEqual({
      id: 'IC_1',
      order: Date.parse('2026-10-09T10:01:00Z'),
      url: 'https://github.com/o/r/pull/1#issuecomment-IC_1',
      editedAt: Date.parse('2026-10-09T10:03:00Z'),
      resolved: false,
      bot: false,
      authorID: 'alice',
      username: 'alice',
    });
  });

  test('falls back to the creation time', () => {
    const comment = toIssueComment(issueComment('IC_1', { publishedAt: null, lastEditedAt: null }));
    expect(comment?.order).toBe(Date.parse('2026-10-09T10:00:00Z'));
    expect(comment?.editedAt).toBe(Date.parse('2026-10-09T10:00:00Z'));
  });

  test('skips hidden comments and comments without an author or a valid time', () => {
    expect(toIssueComment(issueComment('IC_1', { isMinimized: true }))).toBeUndefined();
    expect(toIssueComment(issueComment('IC_1', { author: null }))).toBeUndefined();
    expect(toIssueComment(issueComment('IC_1', { publishedAt: 'nope' }))).toBeUndefined();
  });

  test.each([
    [{ __typename: 'Bot', login: 'github-actions', id: 'bot' }, true],
    [{ __typename: 'User', login: 'renovate[bot]', id: 'renovate' }, true],
    [{ __typename: 'User', login: 'alice', id: 'alice' }, false],
  ])('detects bot author %p', (author, bot) => {
    expect(toIssueComment(issueComment('IC_1', { author }))?.bot).toBe(bot);
  });
});

describe('toReview', () => {
  test.each(['COMMENTED', 'CHANGES_REQUESTED', 'APPROVED'])('counts a %s summary', (state) => {
    expect(toReview(review('R_1', { state }))).toMatchObject({
      id: 'R_1',
      order: Date.parse('2026-10-09T10:02:00Z'),
      editedAt: Date.parse('2026-10-09T10:02:00Z'),
      resolved: false,
    });
  });

  test.each(['PENDING', 'DISMISSED'])('skips a %s review', (state) => {
    expect(toReview(review('R_1', { state }))).toBeUndefined();
  });

  test('skips an empty summary', () => {
    expect(toReview(review('R_1', { body: '' }))).toBeUndefined();
    expect(toReview(review('R_1', { body: '  \n' }))).toBeUndefined();
  });

  test('reads the last edit time', () => {
    expect(toReview(review('R_1', { lastEditedAt: '2026-10-09T10:09:00Z' }))?.editedAt).toBe(
      Date.parse('2026-10-09T10:09:00Z'),
    );
  });
});

describe('edits before publication', () => {
  test("never count as older than the comment's post", () => {
    const edited = { lastEditedAt: '2026-10-09T09:00:00Z' };
    expect(toReview(review('R_1', edited))?.editedAt).toBe(Date.parse('2026-10-09T10:02:00Z'));
    expect(toIssueComment(issueComment('IC_1', edited))?.editedAt).toBe(
      Date.parse('2026-10-09T10:01:00Z'),
    );
    expect(toInlineComment(inline('RC_1', edited), false)?.editedAt).toBe(
      Date.parse('2026-10-09T10:04:00Z'),
    );
  });
});

describe('toInlineComment', () => {
  test('orders by the publish time, so a review submitted later is newer', () => {
    expect(toInlineComment(inline('RC_1'), false)?.order).toBe(Date.parse('2026-10-09T10:04:00Z'));
  });

  test("takes the thread's resolution", () => {
    expect(toInlineComment(inline('RC_1'), true)?.resolved).toBe(true);
    expect(toInlineComment(inline('RC_1'), false)?.resolved).toBe(false);
  });

  test('skips comments of an unsubmitted review', () => {
    expect(toInlineComment(inline('RC_1', { state: 'PENDING' }), false)).toBeUndefined();
  });
});

describe('fetchComments', () => {
  test('merges every kind of comment, oldest first', async () => {
    const graphql: GraphQL = async () =>
      reply({
        comments: connection([issueComment('IC_1')]),
        reviews: connection([review('R_1')]),
        reviewThreads: connection([thread([inline('RC_1')]), thread([inline('RC_2')], true)]),
      });
    const snapshot = await fetchComments(graphql, 'github.com', 'o/r', '1');
    expect(snapshot?.complete).toBe(true);
    expect(snapshot?.viewerID).toBe('bob');
    expect(snapshot?.comments.map((comment) => [comment.id, comment.resolved])).toEqual([
      ['IC_1', false],
      ['R_1', false],
      ['RC_1', false],
      ['RC_2', true],
    ]);
  });

  test('queries by owner, repository, and number', async () => {
    const calls: Array<Record<string, string | number>> = [];
    const graphql: GraphQL = async (_host, _query, variables) => {
      calls.push(variables);
      return reply({});
    };
    await fetchComments(graphql, 'github.com', 'o/r', '7');
    expect(calls).toHaveLength(3);
    for (const variables of calls) expect(variables).toEqual({ owner: 'o', repo: 'r', number: 7 });
  });

  test('pages each list backwards and returns its items oldest first', async () => {
    const calls: Array<Record<string, string | number>> = [];
    const graphql: GraphQL = async (_host, query, variables) => {
      calls.push(variables);
      if (!query.includes('comments(last: 100, before')) return reply({});
      return variables.before
        ? reply({
            comments: connection([
              issueComment('IC_1', { publishedAt: '2026-10-09T10:00:00Z' }),
              issueComment('IC_2', { publishedAt: '2026-10-09T10:01:00Z' }),
            ]),
          })
        : reply({
            comments: connection(
              [
                issueComment('IC_3', { publishedAt: '2026-10-09T10:02:00Z' }),
                issueComment('IC_4', { publishedAt: '2026-10-09T10:03:00Z' }),
              ],
              'c3',
            ),
          });
    };
    const snapshot = await fetchComments(graphql, 'github.com', 'o/r', '1');
    expect(snapshot?.complete).toBe(true);
    expect(snapshot?.comments.map((comment) => comment.id)).toEqual([
      'IC_1',
      'IC_2',
      'IC_3',
      'IC_4',
    ]);
    expect(calls.filter((variables) => variables.before === 'c3')).toHaveLength(1);
  });

  test('returns undefined for a missing PR', async () => {
    const graphql: GraphQL = async () => ({
      viewer: { login: 'bob' },
      repository: { pullRequest: null },
    });
    expect(await fetchComments(graphql, 'github.com', 'o/r', '1')).toBeUndefined();
  });

  test('stops at the newest items and treats the full window as complete', async () => {
    const counts = { comments: 0 };
    const graphql: GraphQL = async (_host, query) => {
      if (!query.includes('comments(last: 100, before')) return reply({});
      counts.comments++;
      return reply({
        comments: connection(
          [
            issueComment(`IC_${counts.comments}`, {
              publishedAt: new Date(Date.UTC(2026, 9, 9) - counts.comments * 1000).toISOString(),
            }),
          ],
          `c${counts.comments}`,
        ),
      });
    };
    const snapshot = await fetchComments(graphql, 'github.com', 'o/r', '1');
    expect(counts.comments).toBe(MAX_COMMENT_PAGES);
    expect(snapshot?.complete).toBe(true);
    expect(snapshot?.comments).toHaveLength(MAX_COMMENT_PAGES);
    expect(snapshot?.comments.at(-1)?.id).toBe('IC_1');
  });

  test('marks a snapshot incomplete when an older page disappears', async () => {
    const graphql: GraphQL = async (_host, _query, variables) =>
      variables.before
        ? { viewer: { login: 'bob' }, repository: null }
        : reply({ comments: connection([issueComment('IC_2')], 'c2') });
    expect((await fetchComments(graphql, 'github.com', 'o/r', '1'))?.complete).toBe(false);
  });

  test('marks a snapshot incomplete when an older page has no cursor', async () => {
    const graphql: GraphQL = async () =>
      reply({
        reviews: { pageInfo: { hasPreviousPage: true, startCursor: null }, nodes: [] },
      });
    expect((await fetchComments(graphql, 'github.com', 'o/r', '1'))?.complete).toBe(false);
  });

  test("marks a snapshot incomplete without the viewer's login", async () => {
    const graphql: GraphQL = async () =>
      reply({ comments: connection([issueComment('IC_1')]) }, null);
    expect((await fetchComments(graphql, 'github.com', 'o/r', '1'))?.complete).toBe(false);
  });

  test('skips hidden comments and empty review summaries, and flags bots', async () => {
    const graphql: GraphQL = async () =>
      reply({
        comments: connection([
          issueComment('IC_1', { author: { __typename: 'Bot', login: 'copilot', id: 'copilot' } }),
          issueComment('IC_2', { isMinimized: true }),
        ]),
        reviews: connection([review('R_1', { body: '' })]),
      });
    const snapshot = await fetchComments(graphql, 'github.com', 'o/r', '1');
    expect(snapshot?.comments.map((comment) => comment.id)).toEqual(['IC_1']);
    expect(snapshot?.comments[0].bot).toBe(true);
  });
});

describe('fetchComments with long threads', () => {
  test('marks a missing initial comment connection incomplete', async () => {
    const snapshot = await fetchComments(
      async () =>
        reply({ reviewThreads: connection([{ id: 't', isResolved: false, comments: null }]) }),
      'github.com',
      'o/r',
      '1',
    );
    expect(snapshot?.complete).toBe(false);
  });

  test('finds a new reply beyond twenty pages of threads', async () => {
    const snapshot = await fetchComments(
      async (_host, query, variables) => {
        if (!query.includes('reviewThreads(last')) return reply({});
        const index = Number(variables.before ?? 0);
        return reply({
          reviewThreads: connection(
            [thread([inline(`reply_${index}`)])],
            index < 20 ? String(index + 1) : undefined,
          ),
        });
      },
      'github.com',
      'o/r',
      '1',
    );
    expect(snapshot?.complete).toBe(true);
    expect(snapshot?.comments.some((comment) => comment.id === 'reply_20')).toBe(true);
  });

  test('bounds the fetch and marks exhausted coverage incomplete', async () => {
    let calls = 0;
    const snapshot = await fetchComments(
      async () => {
        calls++;
        return reply({ reviewThreads: connection([], `page_${calls}`) });
      },
      'github.com',
      'o/r',
      '1',
    );
    expect(calls).toBeLessThanOrEqual(200);
    expect(snapshot?.complete).toBe(false);
  });
  const at = (minute: number) => `2026-10-09T10:${String(minute).padStart(2, '0')}:00Z`;

  test('reads the older comments of a thread that has more than a page', async () => {
    const calls: Array<Record<string, string | number>> = [];
    const graphql: GraphQL = async (_host, query, variables) => {
      if (query.includes('node(id')) {
        calls.push(variables);
        return {
          node: {
            comments: connection([
              inline('RC_1', { publishedAt: at(1) }),
              inline('RC_2', { publishedAt: at(2) }),
            ]),
          },
        };
      }
      return reply({
        reviewThreads: connection([
          thread(
            [inline('RC_3', { publishedAt: at(3) }), inline('RC_4', { publishedAt: at(4) })],
            false,
            't3',
          ),
        ]),
      });
    };
    const snapshot = await fetchComments(graphql, 'github.com', 'o/r', '1');
    expect(snapshot?.complete).toBe(true);
    expect(snapshot?.comments.map((comment) => comment.id)).toEqual([
      'RC_1',
      'RC_2',
      'RC_3',
      'RC_4',
    ]);
    expect(calls).toEqual([{ id: 'PRT_1', before: 't3' }]);
  });

  test("keeps the thread's resolution for its older comments", async () => {
    const graphql: GraphQL = async (_host, query) =>
      query.includes('node(id')
        ? { node: { comments: connection([inline('RC_1', { publishedAt: at(1) })]) } }
        : reply({
            reviewThreads: connection([
              thread([inline('RC_2', { publishedAt: at(2) })], true, 't2'),
            ]),
          });
    const snapshot = await fetchComments(graphql, 'github.com', 'o/r', '1');
    expect(snapshot?.comments.map((comment) => [comment.id, comment.resolved])).toEqual([
      ['RC_1', true],
      ['RC_2', true],
    ]);
  });

  test('marks a snapshot incomplete when older comments of a thread disappear', async () => {
    const graphql: GraphQL = async (_host, query) =>
      query.includes('node(id')
        ? { node: null }
        : reply({ reviewThreads: connection([thread([inline('RC_2')], false, 't2')]) });
    expect((await fetchComments(graphql, 'github.com', 'o/r', '1'))?.complete).toBe(false);
  });

  test('stops at the newest comments of a thread and treats the full window as complete', async () => {
    let older = 0;
    const graphql: GraphQL = async (_host, query) => {
      if (query.includes('node(id')) {
        older++;
        return {
          node: {
            comments: connection(
              [inline(`RC_old${older}`, { publishedAt: at(40 - older) })],
              `o${older}`,
            ),
          },
        };
      }
      return reply({
        reviewThreads: connection([
          thread([inline('RC_new', { publishedAt: at(50) })], false, 't'),
        ]),
      });
    };
    const snapshot = await fetchComments(graphql, 'github.com', 'o/r', '1');
    expect(older).toBe(MAX_COMMENT_PAGES - 1);
    expect(snapshot?.complete).toBe(true);
    expect(snapshot?.comments.at(-1)?.id).toBe('RC_new');
  });
});

describe('GitHub comments through the human review watcher', () => {
  const request: GitHubPullRequest = {
    forge: 'github',
    iid: '1',
    url: 'https://github.com/o/r/pull/1',
    title: 'Review',
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

  test('baselines old comments, then announces a new reply once after the quiet period', async () => {
    let clock = Date.parse('2026-10-09T11:00:00Z');
    let lists: Lists = {
      comments: connection([issueComment('IC_old', { publishedAt: '2026-10-09T10:00:00Z' })]),
    };
    const graphql: GraphQL = async () => reply(lists);
    const records = new Map<string, FeedbackRecord>();
    const sent: string[][] = [];
    const watcher = createFeedbackWatcher({
      now: () => clock,
      record: async (key) => records.get(key),
      persist: (key, change, at) => records.set(key, applyFeedback(records.get(key), change, at)),
      fetch: async () => fetchComments(graphql, 'github.com', 'o/r', '1'),
      current: () => true,
      send: async (_sessionID, _request, comments) => {
        sent.push(comments.map((comment) => comment.id));
      },
    });
    const tick = async (ms: number) => {
      clock += ms;
      await watcher.check('ses_1', request);
    };

    await tick(0);
    lists = {
      comments: connection([
        issueComment('IC_old', { publishedAt: '2026-10-09T10:00:00Z' }),
        issueComment('IC_mine', {
          publishedAt: '2026-10-09T10:30:00Z',
          author: { __typename: 'User', login: 'bob', id: 'bob' },
        }),
      ]),
      reviewThreads: connection([
        thread([
          inline('RC_new', {
            publishedAt: new Date(clock + 1000).toISOString(),
            lastEditedAt: null,
          }),
        ]),
      ]),
    };
    await tick(FETCH_INTERVAL);
    expect(sent).toEqual([]);
    await tick(SETTLE_TIME);
    expect(sent).toEqual([['RC_new']]);
    await tick(FETCH_INTERVAL);
    expect(sent).toHaveLength(1);
  });

  test('retries a failed send after the retry delay', async () => {
    let clock = Date.parse('2026-10-09T11:00:00Z');
    const old = '2026-10-09T10:00:00Z';
    let lists: Lists = { comments: connection([issueComment('IC_old', { publishedAt: old })]) };
    const graphql: GraphQL = async () => reply(lists);
    const records = new Map<string, FeedbackRecord>();
    let failing = true;
    const sent: string[][] = [];
    const watcher = createFeedbackWatcher({
      now: () => clock,
      record: async (key) => records.get(key),
      persist: (key, change, at) => records.set(key, applyFeedback(records.get(key), change, at)),
      fetch: async () => fetchComments(graphql, 'github.com', 'o/r', '1'),
      current: () => true,
      send: async (_sessionID, _request, comments) => {
        if (failing) throw new Error('busy');
        sent.push(comments.map((comment) => comment.id));
      },
      onSendError: () => {},
    });
    await watcher.check('ses_1', request);
    lists = {
      comments: connection([
        issueComment('IC_old', { publishedAt: old }),
        issueComment('IC_new', { publishedAt: '2026-10-09T11:00:30Z', lastEditedAt: null }),
      ]),
    };
    clock += SETTLE_TIME + FETCH_INTERVAL;
    await watcher.check('ses_1', request);
    expect(sent).toEqual([]);
    failing = false;
    clock += FETCH_INTERVAL;
    await watcher.check('ses_1', request);
    expect(sent).toEqual([]);
    clock += RETRY_DELAY;
    await watcher.check('ses_1', request);
    expect(sent).toEqual([['IC_new']]);
  });
});
