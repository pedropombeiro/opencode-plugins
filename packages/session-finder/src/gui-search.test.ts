import { expect, test } from 'bun:test';
import type { Result } from './db.ts';
import { createDesktopSearch, type DesktopSearchState } from './gui-search.ts';
import type { SearchRequest } from './rpc.ts';

function setup() {
  const states: DesktopSearchState[] = [];
  const calls: (SearchRequest & {
    signal: AbortSignal;
    complete: (result: Result) => void;
    fail: (error: unknown) => void;
  })[] = [];
  const search = createDesktopSearch(
    (request, signal) => {
      const { promise, resolve, reject } = Promise.withResolvers<Result>();
      calls.push({ ...request, signal, complete: resolve, fail: reject });
      return promise;
    },
    (state) => states.push(state),
  );
  return { search, calls, states };
}

function result(...ids: string[]): Result {
  return {
    query: 'term',
    mode: 'phrase',
    include: [],
    searches: [],
    total_sessions: ids.length,
    sessions: ids.map((id) => ({
      id,
      title: id,
      directory: '/repo',
      parent_id: null,
      project_id: 'project',
      same_project: true,
      archived: false,
      created: '',
      updated: '',
      match_count: 1,
      last_match: '',
      matches: [],
    })),
  };
}

test('shows title matches while searching, then keeps them first in the full results', async () => {
  const { search, states, calls } = setup();
  const pending = search.run(' term ');
  await Promise.resolve();
  expect(calls[0]).toMatchObject({ query: 'term', limit: 30 });
  expect(calls[1]).toMatchObject({ query: 'term', limit: 30, titles: true });
  calls[1]!.complete(result('title'));
  await Bun.sleep(0);
  expect(states.at(-1)).toMatchObject({ searching: true, titleCount: 1 });
  expect(states.at(-1)?.result?.sessions.map(({ id }) => id)).toEqual(['title']);

  calls[0]!.complete(result('message', 'title'));
  await pending;
  expect(states.at(-1)).toMatchObject({ searching: false, titleCount: 1 });
  expect(states.at(-1)?.result?.sessions.map(({ id }) => id)).toEqual(['title', 'message']);
});

test('cancels both search requests and ignores late responses', async () => {
  const { search, states, calls } = setup();
  const stale = search.run('old');
  await Promise.resolve();
  const fresh = search.run('new');
  await Promise.resolve();
  expect(calls.slice(0, 2).map(({ signal }) => signal.aborted)).toEqual([true, true]);
  calls[1]!.complete(result('old title'));
  calls[0]!.complete(result('old message'));
  await stale;
  expect(states.at(-1)).toEqual({ query: 'new', titleCount: 0, searching: true });

  search.cancel();
  expect(calls.slice(2).map(({ signal }) => signal.aborted)).toEqual([true, true]);
  calls[2]!.fail(new Error('aborted'));
  calls[3]!.complete(result('new title'));
  await fresh;
  expect(states).toHaveLength(2);
});

test('shows the RPC error without dropping available title matches', async () => {
  const { search, states, calls } = setup();
  const pending = search.run('term');
  await Promise.resolve();
  calls[1]!.complete(result('title'));
  await Bun.sleep(0);
  calls[0]!.fail({ type: 'rpc.internal', message: 'Search database unavailable' });
  await pending;
  expect(states.at(-1)).toMatchObject({
    searching: false,
    titleCount: 1,
    error: 'Search database unavailable',
  });
});
