import { describe, expect, test } from 'bun:test';
import type { GraphQL } from './adapter';
import {
  ACTIVITY_QUERY,
  fetchReviewRequests,
  MAX_ACTIVITY_PAGES,
  requestedReviewers,
  toRequest,
} from './review-requests';

const mr = 'https://gitlab.com/g/p/-/merge_requests/1';

const note = (id: string, body: string, overrides: Record<string, unknown> = {}) => ({
  id: `gid://gitlab/Note/${id}`,
  url: `${mr}#note_${id}`,
  body,
  createdAt: '2026-11-05T15:54:25Z',
  system: true,
  systemNoteMetadata: { action: 'reviewer' },
  author: { id: 'gid://gitlab/User/2', username: 'cleveland' },
  ...overrides,
});

const page = (
  nodes: unknown[],
  previous?: string,
  viewer: { id: string; username: string } | null = {
    id: 'gid://gitlab/User/1',
    username: 'pedro',
  },
) => ({
  currentUser: viewer,
  project: {
    mergeRequest: {
      notes: { pageInfo: { hasPreviousPage: !!previous, startCursor: previous ?? null }, nodes },
    },
  },
});

describe('requestedReviewers', () => {
  test('reads the reviewers a note requests, ignoring removals', () => {
    expect(requestedReviewers('requested review from @pedro')).toEqual(['pedro']);
    expect(requestedReviewers('requested review from @a.b and @Bob-2')).toEqual(['a.b', 'bob-2']);
    expect(
      requestedReviewers(
        'requested review from @a, @b and @c and removed review request for @pedro and @d',
      ),
    ).toEqual(['a', 'b', 'c']);
    expect(requestedReviewers('requested review from @pedro and removed approval')).toEqual([
      'pedro',
    ]);
    expect(requestedReviewers('removed review request for @pedro')).toEqual([]);
    expect(requestedReviewers('left review comments')).toEqual([]);
    expect(requestedReviewers('assigned to @pedro')).toEqual([]);
  });
});

describe('toRequest', () => {
  test("returns a reviewer note that requests the viewer's review", () => {
    expect(toRequest(note('5', 'requested review from @Pedro'), 'pedro', mr)).toEqual({
      id: '5',
      order: 5,
      url: `${mr}#note_5`,
      at: Date.parse('2026-11-05T15:54:25Z'),
      requester: { id: 'gid://gitlab/User/2', username: 'cleveland' },
    });
  });

  test('skips requests for other reviewers, comments, and other system notes', () => {
    expect(toRequest(note('5', 'requested review from @pedrosa'), 'pedro', mr)).toBeUndefined();
    expect(
      toRequest(note('5', 'requested review from @pedro', { system: false }), 'pedro', mr),
    ).toBeUndefined();
    expect(
      toRequest(
        note('5', 'requested review from @pedro', { systemNoteMetadata: { action: 'title' } }),
        'pedro',
        mr,
      ),
    ).toBeUndefined();
  });

  test('accepts notes without metadata, and links the note without a URL', () => {
    expect(
      toRequest(
        note('5', 'requested review from @pedro', { systemNoteMetadata: null, url: null }),
        'pedro',
        mr,
      )?.url,
    ).toBe(`${mr}#note_5`);
  });
});

describe('fetchReviewRequests', () => {
  test("reads activity notes across pages and keeps the viewer's requests in order", async () => {
    const calls: Array<Record<string, string>> = [];
    const queries: string[] = [];
    const graphql: GraphQL = async (_host, query, variables) => {
      calls.push(variables);
      queries.push(query);
      return variables.before
        ? page([note('1', 'requested review from @pedro'), note('2', 'added 1 commit')])
        : page(
            [
              note('3', 'requested review from @someone'),
              note('4', 'requested review from @pedro', {
                author: { id: 'gid://gitlab/User/1', username: 'pedro' },
              }),
            ],
            'c3',
          );
    };
    const history = await fetchReviewRequests(graphql, 'gitlab.com', 'g/p', '1', mr);
    expect(queries[0]).toBe(String(ACTIVITY_QUERY));
    expect(queries[0]).toContain('ONLY_ACTIVITY');
    expect(calls).toEqual([
      { project: 'g/p', iid: '1' },
      { project: 'g/p', iid: '1', before: 'c3' },
    ]);
    expect(history).toMatchObject({ complete: true, viewerID: 'gid://gitlab/User/1', newest: 4 });
    expect(history?.requests.map((event) => [event.id, event.requester?.username])).toEqual([
      ['1', 'cleveland'],
      ['4', 'pedro'],
    ]);
  });

  test('is incomplete without the viewer, and undefined for a missing MR', async () => {
    const anonymous: GraphQL = async () =>
      page([note('1', 'requested review from @pedro')], undefined, null);
    expect(await fetchReviewRequests(anonymous, 'gitlab.com', 'g/p', '1', mr)).toEqual({
      complete: false,
      newest: 1,
      requests: [],
    });
    const missing: GraphQL = async () => ({ currentUser: null, project: { mergeRequest: null } });
    expect(await fetchReviewRequests(missing, 'gitlab.com', 'g/p', '1', mr)).toBeUndefined();
  });

  test('stops at the newest activity and treats the full window as complete', async () => {
    let calls = 0;
    const graphql: GraphQL = async () => {
      calls++;
      return page([note(String(1000 - calls), 'added 1 commit')], `c${calls}`);
    };
    const history = await fetchReviewRequests(graphql, 'gitlab.com', 'g/p', '1', mr);
    expect(calls).toBe(MAX_ACTIVITY_PAGES);
    expect(history?.complete).toBe(true);
    expect(history?.newest).toBe(999);
  });
});
