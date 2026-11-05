import { expect, test } from 'bun:test';
import type { Result, Session } from './db.ts';
import {
  clip,
  dialogTitle,
  filterOptions,
  noMatches,
  openSession,
  stateTitle,
  summarize,
  summaryPrompt,
  toOptions,
  withTitleMatches,
} from './present.ts';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'ses_a',
    title: 'Session A',
    directory: '/repo',
    parent_id: null,
    project_id: 'p1',
    same_project: true,
    archived: false,
    created: '2026-10-09T19:00:00+02:00',
    updated: '2026-10-09T19:33:47+02:00',
    match_count: 1,
    last_match: '2026-10-09T19:33:47+02:00',
    matches: [
      {
        excerpt: '…the palette entry…',
        message_id: 'msg_1',
        source: 'assistant',
        time: '2026-10-09T19:33:47+02:00',
      },
    ],
    ...overrides,
  };
}

function result(overrides: Partial<Result> = {}): Result {
  return {
    query: 'palette',
    mode: 'phrase',
    include: [],
    searches: [{ mode: 'phrase', include: [], total_sessions: 1 }],
    total_sessions: 1,
    sessions: [session()],
    ...overrides,
  };
}

test('lists current-project sessions first and describes the rest', () => {
  const options = toOptions([
    session({
      id: 'ses_other',
      title: 'Other',
      same_project: false,
      directory: '/elsewhere',
      archived: true,
    }),
    session({ id: 'ses_mine', title: '', matches: [] }),
  ]);
  expect(options).toEqual([
    {
      title: 'ses_mine',
      value: 'ses_mine',
      description: '2026-10-09',
      category: 'Current project',
    },
    {
      title: 'Other',
      value: 'ses_other',
      description: '2026-10-09 · /elsewhere · archived · …the palette entry…',
      category: 'Other projects',
    },
  ]);
});

test('titles the dialog with the count and any fallback', () => {
  expect(dialogTitle(result())).toBe('Sessions matching "palette" (1)');
  expect(dialogTitle(result({ mode: 'words', include: ['tools'], total_sessions: 40 }))).toBe(
    'Sessions matching "palette" (1 of 40, all words, tool output)',
  );
  expect(dialogTitle(result(), true)).toBe('Sessions matching "palette" (1, searching messages…)');
});

test('titles the dialog for each stage of the search', () => {
  const query = 'palette';
  const none = result({ sessions: [], total_sessions: 0 });
  expect(stateTitle({ query, searching: true, failed: false })).toBe(
    '⋯ Searching sessions for "palette"…',
  );
  expect(stateTitle({ query, searching: true, failed: false, frame: 12 })).toBe(
    '⠹ Searching sessions for "palette"…',
  );
  expect(stateTitle({ query, result: result(), searching: true, failed: false, frame: 0 })).toBe(
    '⠋ Sessions matching "palette" (1, searching messages…)',
  );
  expect(stateTitle({ query, result: result(), searching: false, failed: false, frame: 3 })).toBe(
    'Sessions matching "palette" (1)',
  );
  expect(stateTitle({ query, result: result(), searching: false, failed: true })).toBe(
    'Sessions matching "palette" (1)',
  );
  expect(stateTitle({ query, result: none, searching: false, failed: false })).toBe(
    'No sessions matched "palette". Searched: exact phrase.',
  );
  expect(stateTitle({ query, searching: false, failed: true })).toBe(
    'Session search failed for "palette"',
  );
});

test('keeps title matches first and in their order, within the limit', () => {
  const ids = (value: Result) => value.sessions.map((entry) => entry.id);
  const titles = result({ sessions: [session({ id: 'ses_title' })] });
  const full = result({
    total_sessions: 2,
    sessions: [session({ id: 'ses_newer' }), session({ id: 'ses_title' })],
  });
  const merged = withTitleMatches(full, titles);
  expect(ids(merged)).toEqual(['ses_title', 'ses_newer']);
  expect(merged.total_sessions).toBe(2);

  const refreshed = session({ id: 'ses_title', match_count: 9, last_match: '2026-11-05' });
  const details = withTitleMatches(result({ sessions: [refreshed] }), titles);
  expect(details.sessions[0]).toBe(refreshed);

  const many = result({
    total_sessions: 40,
    sessions: ['ses_b', 'ses_c', 'ses_d'].map((id) => session({ id })),
  });
  const limited = withTitleMatches(many, titles, 3);
  expect(ids(limited)).toEqual(['ses_title', 'ses_b', 'ses_c']);
  expect(dialogTitle(limited)).toBe('Sessions matching "palette" (3 of 40)');
});

test('sorts kept options apart from the ones added after them', () => {
  const other = session({ id: 'ses_other', same_project: false });
  const mine = session({ id: 'ses_mine' });
  expect(toOptions([other, mine]).map((option) => option.value)).toEqual(['ses_mine', 'ses_other']);
  expect(toOptions([other, mine], 1).map((option) => option.value)).toEqual([
    'ses_other',
    'ses_mine',
  ]);
});

test('filters options by every word of the title or project, keeping their order', () => {
  const options = toOptions([
    session({ id: 'ses_b', title: 'Runner fleet', same_project: false }),
    session({ id: 'ses_a', title: 'Fleet review' }),
  ]);
  const values = (query: string) => filterOptions(query, options).map((option) => option.value);
  expect(values('')).toEqual(['ses_a', 'ses_b']);
  expect(values('FLEET')).toEqual(['ses_a', 'ses_b']);
  expect(values('fleet other')).toEqual(['ses_b']);
  expect(values('review current')).toEqual(['ses_a']);
  expect(values('missing')).toEqual([]);
});

test('keeps a filtered session listed when its date and excerpt change', () => {
  const preview = session({ id: 'ses_mr', title: '!267387 review', last_match: '2026-10-01' });
  const titles = result({ sessions: [preview] });
  const refreshed = session({
    id: 'ses_mr',
    title: '!267387 review',
    last_match: '2026-11-05',
    matches: [{ excerpt: 'feedback', message_id: 'msg_2', source: 'user', time: '2026-11-05' }],
  });
  const other = session({ id: 'ses_other', title: 'Another review', last_match: '2026-10-01' });
  const merged = withTitleMatches(result({ sessions: [refreshed, other] }), titles);
  const values = (value: Result, query: string) =>
    filterOptions(query, toOptions(value.sessions, 1)).map((option) => option.value);
  expect(values(titles, '267387')).toEqual(['ses_mr']);
  expect(values(merged, '267387')).toEqual(['ses_mr']);
  expect(values(titles, '2026-10-01')).toEqual([]);
  expect(values(merged, 'palette')).toEqual([]);
});

test('reports every search that ran when nothing matched', () => {
  const empty = result({
    query: 'two words',
    sessions: [],
    total_sessions: 0,
    searches: [
      { mode: 'phrase', include: [], total_sessions: 0 },
      { mode: 'words', include: [], total_sessions: 0 },
      { mode: 'words', include: ['tools'], total_sessions: 0 },
    ],
  });
  expect(noMatches(empty)).toBe(
    'No sessions matched "two words". Searched: exact phrase; all words; all words, tool output.',
  );
});

test('clip collapses whitespace and truncates', () => {
  expect(clip('a\n  b')).toBe('a b');
  expect(clip('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`);
});

function terminal(tabs: boolean) {
  const calls: string[] = [];
  return {
    calls,
    ui: {
      router: {
        navigate: (route: { sessionID: string }) => void calls.push(`navigate ${route.sessionID}`),
      },
      tabs: { enabled: () => tabs, focus: (id: string) => void calls.push(`focus ${id}`) },
    },
  };
}

test('focuses the tab of a root session and navigates to a child', () => {
  const withTabs = terminal(true);
  expect(openSession(withTabs.ui, session())).toBeUndefined();
  openSession(withTabs.ui, session({ id: 'ses_child', parent_id: 'ses_a' }));
  const withoutTabs = terminal(false);
  openSession(withoutTabs.ui, session());
  expect(withTabs.calls).toEqual(['focus ses_a', 'navigate ses_child']);
  expect(withoutTabs.calls).toEqual(['navigate ses_a']);
});

test('does not open a session of another project', () => {
  const { calls, ui } = terminal(true);
  for (const same_project of [false, null]) {
    expect(openSession(ui, session({ same_project }))?.message).toBe(
      'Reopen it with: opencode --session ses_a',
    );
  }
  expect(calls).toHaveLength(0);
});

test('asks the agent to read the matches with search_sessions', () => {
  const prompt = summaryPrompt('palette "entry"', session());
  expect(prompt).toContain('`search_sessions`');
  expect(prompt).toContain(
    '{"query": "palette \\"entry\\"", "session_id": "ses_a", "excerpts": 10, "context": 400}',
  );
});

test('queues a summary request in the displayed session', async () => {
  const requests: unknown[] = [];
  const toast = await summarize(
    'palette',
    session(),
    { type: 'session', sessionID: 'ses_current' },
    async (request) => requests.push(request),
  );
  expect(requests).toEqual([
    {
      sessionID: 'ses_current',
      text: summaryPrompt('palette', session()),
      delivery: 'queue',
      resume: true,
    },
  ]);
  expect(toast.variant).toBe('success');
});

test('refuses to summarize outside a session and reports failures', async () => {
  const fail = async () => {
    throw new Error('boom');
  };
  expect((await summarize('q', session(), { type: 'home' }, fail)).variant).toBe('warning');
  expect(await summarize('q', session(), { type: 'session', sessionID: 'ses_x' }, fail)).toEqual({
    message: 'Could not request the summary: boom',
    variant: 'error',
  });
});
