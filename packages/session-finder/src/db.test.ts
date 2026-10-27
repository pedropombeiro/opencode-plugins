import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attempts,
  defaultDatabase,
  excerpt,
  iso,
  parseDate,
  searchSessions,
  type SearchOptions,
} from './db.ts';

const DAY = 86_400_000;
const T0 = new Date(2026, 9, 1).getTime();

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface SessionRow {
  id: string;
  title?: string;
  directory?: string;
  project?: string;
  parent?: string;
  archived?: boolean;
  created?: number;
}

interface MessageRow {
  session: string;
  type: string;
  data: unknown;
  time?: number;
}

function fixture(
  sessions: SessionRow[],
  messages: MessageRow[],
  options: { table?: 'session_v2' | 'session'; projects?: [string, string, string[]][] } = {},
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'session-finder-')));
  dirs.push(dir);
  const path = join(dir, 'opencode.db');
  const db = new Database(path);
  const table = options.table ?? 'session_v2';
  const archived = table === 'session_v2' ? ', time_archived integer' : '';
  db.run(
    `CREATE TABLE ${table} (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, ` +
      `directory text NOT NULL, title text, time_created integer NOT NULL, ` +
      `time_updated integer NOT NULL${archived})`,
  );
  db.run(
    'CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, ' +
      'type text NOT NULL, time_created integer NOT NULL, data text NOT NULL)',
  );
  db.run('CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, sandboxes text)');
  for (const [id, worktree, sandboxes] of options.projects ?? []) {
    db.run('INSERT INTO project VALUES (?, ?, ?)', [id, worktree, JSON.stringify(sandboxes)]);
  }
  for (const session of sessions) {
    const values: (string | number | null)[] = [
      session.id,
      session.project ?? 'p1',
      session.parent ?? null,
      session.directory ?? '/repo',
      session.title ?? '',
      session.created ?? T0,
      session.created ?? T0,
    ];
    if (archived) values.push(session.archived ? T0 : null);
    db.run(`INSERT INTO ${table} VALUES (${values.map(() => '?').join(',')})`, values);
  }
  messages.forEach((message, index) => {
    db.run('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)', [
      `msg_${index}`,
      message.session,
      message.type,
      message.time ?? T0 + index * 1000,
      JSON.stringify(message.data),
    ]);
  });
  db.close();
  return { path, dir };
}

const user = (session: string, text: string, time?: number): MessageRow => ({
  session,
  type: 'user',
  data: { text },
  time,
});

const assistant = (session: string, content: unknown[], time?: number): MessageRow => ({
  session,
  type: 'assistant',
  data: { content },
  time,
});

function run(path: string, options: Omit<SearchOptions, 'database'>) {
  return searchSessions({ database: path, ...options });
}

describe('searchSessions', () => {
  test('finds a phrase case-insensitively, newest match first', () => {
    const { path } = fixture(
      [{ id: 'ses_a', title: 'First' }, { id: 'ses_b' }, { id: 'ses_c' }],
      [
        user('ses_a', 'We should Move The Plugin'),
        user('ses_b', 'move the plugin now'),
        user('ses_c', 'plugin move the'),
      ],
    );
    const result = run(path, { query: 'move the plugin' });
    expect(result.mode).toBe('phrase');
    expect(result.sessions.map((session) => session.id)).toEqual(['ses_b', 'ses_a']);
    expect(result.sessions[1]!.matches[0]).toMatchObject({
      source: 'user',
      message_id: 'msg_0',
      excerpt: 'We should Move The Plugin',
    });
    expect(result.searches).toEqual([{ mode: 'phrase', include: [], total_sessions: 2 }]);
  });

  test('falls back to all words, then to tool output', () => {
    const { path } = fixture(
      [{ id: 'ses_words' }, { id: 'ses_tools' }],
      [
        user('ses_words', 'alpha first'),
        user('ses_words', 'then beta'),
        assistant('ses_tools', [
          { type: 'tool', name: 'shell', state: { input: { command: 'gamma delta' } } },
        ]),
      ],
    );
    const words = run(path, { query: 'beta alpha' });
    expect(words.mode).toBe('words');
    expect(words.sessions.map((session) => session.id)).toEqual(['ses_words']);
    expect(words.sessions[0]!.matches.map((match) => match.term)).toEqual(['beta', 'alpha']);

    const tools = run(path, { query: 'gamma' });
    expect(tools.searches.map((search) => [search.mode, search.include])).toEqual([
      ['phrase', []],
      ['phrase', ['tools']],
    ]);
    expect(tools.sessions[0]!.matches[0]!.source).toBe('tool:shell:input');

    const none = run(path, { query: 'gamma', fallback: false });
    expect(none.searches).toHaveLength(1);
    expect(none.sessions).toEqual([]);
  });

  test('searches only the requested message sources', () => {
    const { path } = fixture(
      [{ id: 'ses_a' }],
      [
        assistant('ses_a', [
          { type: 'reasoning', text: 'secret thought' },
          {
            type: 'tool',
            name: 'read',
            state: { content: [{ type: 'text', text: 'file says hidden' }], error: 'hidden fail' },
          },
        ]),
        { session: 'ses_a', type: 'system', data: { text: 'system note' } },
        { session: 'ses_a', type: 'compaction', data: { summary: 'compacted summary' } },
        {
          session: 'ses_a',
          type: 'shell',
          data: { command: 'ls hidden', output: { output: 'hidden out' } },
        },
      ],
    );
    expect(run(path, { query: 'secret', fallback: false }).sessions).toEqual([]);
    expect(
      run(path, { query: 'secret', include: ['reasoning'] }).sessions[0]!.matches[0]!.source,
    ).toBe('reasoning');
    expect(run(path, { query: 'system note', fallback: false }).sessions).toEqual([]);
    expect(run(path, { query: 'system note', include: ['system'] }).sessions).toHaveLength(1);
    expect(run(path, { query: 'compacted' }).sessions[0]!.matches[0]!.source).toBe('compaction');
    const sources = run(path, { query: 'hidden', include: ['tools'], excerpts: 10 })
      .sessions[0]!.matches.map((match) => match.source)
      .sort();
    expect(sources).toEqual([
      'shell:command',
      'shell:output',
      'tool:read:error',
      'tool:read:output',
    ]);
  });

  test('matches titles and requires every term in words mode', () => {
    const { path } = fixture(
      [
        { id: 'ses_a', title: 'Deploy pipeline' },
        { id: 'ses_b', title: 'Deploy' },
      ],
      [user('ses_a', 'unrelated'), user('ses_b', 'unrelated')],
    );
    const result = run(path, { query: 'deploy pipeline', words: true, fallback: false });
    expect(result.sessions.map((session) => session.id)).toEqual(['ses_a']);
    expect(result.sessions[0]!.matches.every((match) => match.source === 'title')).toBe(true);
  });

  test('escapes LIKE wildcards, JSON characters, and regular expressions', () => {
    const { path } = fixture(
      [{ id: 'ses_a' }, { id: 'ses_b' }],
      [user('ses_a', 'run "a.b" at 100%_ok'), user('ses_b', 'run axb at 100xyok')],
    );
    expect(run(path, { query: '"a.b"', fallback: false }).sessions.map((s) => s.id)).toEqual([
      'ses_a',
    ]);
    expect(run(path, { query: '100%_ok', fallback: false }).sessions.map((s) => s.id)).toEqual([
      'ses_a',
    ]);
  });

  test('filters by session, directory, and date', () => {
    const { path } = fixture(
      [
        { id: 'ses_a', directory: '/repo' },
        { id: 'ses_b', directory: '/repo/sub' },
        { id: 'ses_c', directory: '/repository' },
      ],
      [
        user('ses_a', 'needle', T0),
        user('ses_b', 'needle', T0 + DAY),
        user('ses_c', 'needle', T0 + 2 * DAY),
      ],
    );
    const ids = (options: Omit<SearchOptions, 'database' | 'query'>) =>
      run(path, { query: 'needle', ...options }).sessions.map((session) => session.id);
    expect(ids({ sessionID: 'ses_b' })).toEqual(['ses_b']);
    expect(ids({ directory: '/repo/' })).toEqual(['ses_b', 'ses_a']);
    const day = (offset: number) => iso(T0 + offset * DAY).slice(0, 10);
    expect(ids({ since: day(1) })).toEqual(['ses_c', 'ses_b']);
    expect(ids({ until: day(1) })).toEqual(['ses_a']);
  });

  test('excludes the current session and compares projects', () => {
    const { path } = fixture(
      [
        { id: 'ses_current', project: 'p1', directory: '/repo' },
        { id: 'ses_worktree', project: 'p1', directory: '/worktrees/task' },
        { id: 'ses_other', project: 'p2', directory: '/other' },
        { id: 'ses_global', project: 'global', directory: '/tmp/x' },
      ],
      ['ses_current', 'ses_worktree', 'ses_other', 'ses_global'].map((id) => user(id, 'needle')),
    );
    const result = run(path, { query: 'needle', currentSessionID: 'ses_current' });
    const same = Object.fromEntries(result.sessions.map((s) => [s.id, s.same_project]));
    expect(same).toEqual({ ses_worktree: true, ses_other: false, ses_global: false });

    const current = run(path, {
      query: 'needle',
      currentSessionID: 'ses_current',
      currentProject: true,
    });
    expect(current.sessions.map((s) => s.id)).toEqual(['ses_worktree']);

    const included = run(path, {
      query: 'needle',
      currentSessionID: 'ses_current',
      includeCurrent: true,
    });
    expect(included.sessions).toHaveLength(4);
  });

  test('takes the project from the directory without a current session', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'session-finder-cwd-')));
    dirs.push(base);
    mkdirSync(join(base, 'repo', 'deep'), { recursive: true });
    mkdirSync(join(base, 'sandbox'));
    const { path } = fixture(
      [
        { id: 'ses_repo', project: 'p1', directory: join(base, 'repo') },
        { id: 'ses_other', project: 'p2', directory: '/other' },
        { id: 'ses_global', project: 'global', directory: join(base, 'loose') },
      ],
      ['ses_repo', 'ses_other', 'ses_global'].map((id) => user(id, 'needle')),
      {
        projects: [
          ['p1', join(base, 'repo'), [join(base, 'sandbox')]],
          ['p2', '/other', []],
        ],
      },
    );
    const same = (cwd: string) =>
      Object.fromEntries(
        run(path, { query: 'needle', cwd }).sessions.map((s) => [s.id, s.same_project]),
      );
    expect(same(join(base, 'repo', 'deep'))).toMatchObject({ ses_repo: true, ses_other: false });
    expect(same(join(base, 'sandbox'))).toMatchObject({ ses_repo: true });
    expect(same(join(base, 'loose'))).toMatchObject({ ses_repo: false, ses_global: true });
  });

  test('reads the older session table without archive times', () => {
    const { path } = fixture([{ id: 'ses_old' }], [user('ses_old', 'needle')], {
      table: 'session',
    });
    const result = run(path, { query: 'needle' });
    expect(result.sessions[0]).toMatchObject({ id: 'ses_old', archived: false });
  });

  test('limits sessions and excerpts, and reports the archive flag', () => {
    const { path } = fixture(
      [{ id: 'ses_a', archived: true }, { id: 'ses_b' }, { id: 'ses_c' }],
      [user('ses_a', 'needle needle needle'), user('ses_b', 'needle'), user('ses_c', 'needle')],
    );
    const result = run(path, { query: 'needle', limit: 2, excerpts: 2 });
    expect(result.total_sessions).toBe(3);
    expect(result.sessions).toHaveLength(2);
    const archived = run(path, { query: 'needle', sessionID: 'ses_a', excerpts: 2 }).sessions[0]!;
    expect(archived.archived).toBe(true);
    expect(archived.match_count).toBe(3);
    expect(archived.matches).toHaveLength(2);
  });

  test('rejects bad input and unsupported databases', () => {
    const { path, dir } = fixture([], []);
    expect(() => run(path, { query: '  ' })).toThrow('The query is empty.');
    expect(() => run(join(dir, 'missing.db'), { query: 'x' })).toThrow('Database not found');
    expect(() => run(path, { query: 'x', since: '2026-13-01' })).toThrow('Invalid date');
    const empty = join(dir, 'empty.db');
    new Database(empty).close();
    expect(() => run(empty, { query: 'x' })).toThrow('no session_message table');
  });
});

describe('helpers', () => {
  test('attempts retries a multi-word phrase as words, then with tools', () => {
    const list = (query: string, words = false, include: string[] = []) =>
      [...attempts(query, words, new Set(include as never[]))].map(([w, s]) => [w, [...s]]);
    expect(list('one two')).toEqual([
      [false, []],
      [true, []],
      [true, ['tools']],
    ]);
    expect(list('one')).toEqual([
      [false, []],
      [false, ['tools']],
    ]);
    expect(list('one', false, ['tools'])).toEqual([[false, ['tools']]]);
  });

  test('excerpt marks truncated ends and collapses whitespace', () => {
    expect(excerpt('aaaa\n\nneedle  bbbb', 6, 12, 3)).toBe('…a needle b…');
    expect(excerpt('needle', 0, 6, 100)).toBe('needle');
    expect(excerpt('😀ab needle cd😀', 5, 11, 4)).toBe('😀ab needle cd😀');
    expect(excerpt('x😀ab needle cd😀x', 6, 12, 4)).toBe('…😀ab needle cd😀…');
  });

  test('parseDate uses local midnight and iso uses the local offset', () => {
    const ms = parseDate('2026-10-27');
    expect(new Date(ms).getHours()).toBe(0);
    expect(iso(ms).startsWith('2026-10-27T00:00:00')).toBe(true);
  });

  test('defaultDatabase follows XDG_DATA_HOME', () => {
    expect(defaultDatabase({ XDG_DATA_HOME: '/data' })).toBe('/data/opencode/opencode.db');
  });
});
