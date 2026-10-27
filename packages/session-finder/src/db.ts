import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SOURCES = ['tools', 'reasoning', 'system'] as const;
export type Source = (typeof SOURCES)[number];
export type Mode = 'phrase' | 'words';

export interface SearchOptions {
  query: string;
  database?: string;
  words?: boolean;
  include?: Source[];
  fallback?: boolean;
  sessionID?: string;
  directory?: string;
  currentProject?: boolean;
  since?: string;
  until?: string;
  limit?: number;
  excerpts?: number;
  context?: number;
  currentSessionID?: string;
  includeCurrent?: boolean;
  cwd?: string;
}

export interface Match {
  term?: string;
  time: string;
  message_id: string | null;
  source: string;
  excerpt: string;
}

export interface Session {
  id: string;
  title: string;
  directory: string;
  parent_id: string | null;
  project_id: string | null;
  same_project: boolean | null;
  archived: boolean;
  created: string;
  updated: string;
  match_count: number;
  last_match: string;
  matches: Match[];
}

export interface Attempt {
  mode: Mode;
  include: Source[];
  total_sessions: number;
}

export interface Result {
  query: string;
  mode: Mode;
  include: Source[];
  searches: Attempt[];
  total_sessions: number;
  sessions: Session[];
}

export class SearchError extends Error {}

interface Candidate {
  id: string;
  title: string;
  directory: string;
  parent_id: string | null;
  project_id: string | null;
  same_project: boolean | null;
  archived: boolean;
  created_ms: number;
  updated_ms: number;
}

interface Current {
  project_id: string | null;
  directory: string;
}

interface Hit {
  time: number;
  messageID: string | null;
  source: string;
  term: string;
  text: string;
  start?: number;
  end?: number;
}

interface Filters {
  sessionFilter: boolean;
  since?: number;
  until?: number;
  excerpts: number;
  context: number;
}

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

export function defaultDatabase(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share');
  return join(dataHome, 'opencode', 'opencode.db');
}

export function searchSessions(options: SearchOptions): Result {
  const query = options.query.trim();
  if (!query) throw new SearchError('The query is empty.');
  const include = new Set<Source>(options.include ?? []);
  const unknown = [...include].filter((source) => !SOURCES.includes(source));
  if (unknown.length)
    throw new SearchError(`Unknown include value(s): ${unknown.sort().join(', ')}`);

  const db = connect(options.database ?? defaultDatabase());
  try {
    const table = sessionTable(db);
    const filters: Filters = {
      sessionFilter: Boolean(options.sessionID || options.directory || options.currentProject),
      since: options.since ? parseDate(options.since) : undefined,
      until: options.until ? parseDate(options.until) : undefined,
      excerpts: options.excerpts ?? 3,
      context: options.context ?? 100,
    };
    const sessions = loadSessions(db, table, options);

    const searches: Attempt[] = [];
    let results: Session[] = [];
    for (const [words, sources] of attempts(query, options.words ?? false, include, options)) {
      results = search(db, sessions, query, words, sources, filters);
      searches.push({
        mode: words ? 'words' : 'phrase',
        include: [...sources].sort(),
        total_sessions: results.length,
      });
      if (results.length) break;
    }
    const last = searches[searches.length - 1]!;
    return {
      query,
      mode: last.mode,
      include: last.include,
      searches,
      total_sessions: results.length,
      sessions: results.slice(0, options.limit ?? 10),
    };
  } finally {
    db.close();
  }
}

export function parseDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
  if (!date || date.getMonth() !== Number(match![2]) - 1) {
    throw new SearchError(`Invalid date "${value}", expected YYYY-MM-DD`);
  }
  return date.getTime();
}

export function* attempts(
  query: string,
  words: boolean,
  include: Set<Source>,
  options: Pick<SearchOptions, 'fallback'> = {},
): Generator<[boolean, Set<Source>]> {
  yield [words, include];
  if (options.fallback === false) return;
  const multiword = splitWords(query).length > 1;
  if (multiword && !words) yield [true, include];
  if (!include.has('tools')) yield [words || multiword, new Set([...include, 'tools'])];
}

function connect(path: string): Database {
  if (!existsSync(path)) throw new SearchError(`Database not found: ${path}`);
  const db = new Database(path, { readonly: true });
  db.run('PRAGMA busy_timeout = 10000');
  db.run('PRAGMA query_only = 1');
  return db;
}

function sessionTable(db: Database): string {
  const tables = new Set(
    db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  );
  if (!tables.has('session_message')) {
    throw new SearchError('Unsupported database schema: no session_message table');
  }
  for (const name of ['session_v2', 'session']) if (tables.has(name)) return name;
  throw new SearchError('Unsupported database schema: no session table');
}

function loadSessions(db: Database, table: string, options: SearchOptions) {
  const columns = new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
  const archived = columns.has('time_archived') ? 'time_archived' : 'NULL';
  const project = columns.has('project_id') ? 'project_id' : 'NULL';
  let sql =
    `SELECT id, title, directory, parent_id, ${project} AS project_id, time_created, ` +
    `time_updated, ${archived} AS time_archived FROM ${table}`;
  const conditions: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (options.sessionID) {
    conditions.push('id = ?');
    params.push(options.sessionID);
  }
  if (options.directory) {
    const directory = options.directory.replace(/\/+$/, '');
    conditions.push("(directory = ? OR directory LIKE ? ESCAPE '\\')");
    params.push(directory, `${likeEscape(directory)}/%`);
  }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;

  const currentID = options.currentSessionID;
  const excluded = options.includeCurrent || options.sessionID ? undefined : currentID;
  let current: Current | null = null;
  if (currentID) {
    current = db
      .query<
        Current,
        [string]
      >(`SELECT ${project} AS project_id, directory FROM ${table} WHERE id = ?`)
      .get(currentID);
  } else if (project !== 'NULL') {
    current = projectOf(db, options.cwd ?? process.cwd());
  }
  if (options.currentProject && (!current || current.project_id === null)) {
    throw new SearchError('Searching the current project needs a database with project IDs');
  }

  const sessions = new Map<string, Candidate>();
  for (const row of db.query<Row, SQLQueryBindings[]>(sql).all(...params)) {
    const id = row['id'] as string;
    if (id === excluded) continue;
    const projectID = (row['project_id'] as string | null) ?? null;
    const directory = row['directory'] as string;
    const same = sameProject({ project_id: projectID, directory }, current);
    if (options.currentProject && !same) continue;
    sessions.set(id, {
      id,
      title: (row['title'] as string | null) ?? '',
      directory,
      parent_id: (row['parent_id'] as string | null) ?? null,
      project_id: projectID,
      same_project: same,
      archived: row['time_archived'] !== null && row['time_archived'] !== undefined,
      created_ms: row['time_created'] as number,
      updated_ms: row['time_updated'] as number,
    });
  }
  return sessions;
}

function projectOf(db: Database, directory: string): Current | null {
  const cwd = resolve(directory);
  let rows: { id: string; worktree: string; sandboxes: string | null }[];
  try {
    rows = db
      .query<
        { id: string; worktree: string; sandboxes: string | null },
        []
      >('SELECT id, worktree, sandboxes FROM project')
      .all();
  } catch {
    return null;
  }
  let best: [string, string] | undefined;
  for (const row of rows) {
    let sandboxes: unknown[] = [];
    try {
      const parsed = JSON.parse(row.sandboxes || '[]');
      if (Array.isArray(parsed)) sandboxes = parsed;
    } catch {
      sandboxes = [];
    }
    for (const path of [row.worktree, ...sandboxes]) {
      if (typeof path !== 'string' || path === '' || path === '/') continue;
      const root = resolve(path);
      if ((cwd === root || cwd.startsWith(`${root}/`)) && (!best || root.length > best[1].length)) {
        best = [row.id, root];
      }
    }
  }
  return { project_id: best ? best[0] : 'global', directory: cwd };
}

export function sameProject(row: Current, current: Current | null): boolean | null {
  if (!current || current.project_id === null || row.project_id === null) return null;
  if (row.project_id !== current.project_id) return false;
  if (row.project_id !== 'global') return true;
  return resolve(row.directory) === resolve(current.directory);
}

function resolve(path: string): string {
  if (!path) return path;
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function search(
  db: Database,
  sessions: Map<string, Candidate>,
  query: string,
  words: boolean,
  include: Set<Source>,
  filters: Filters,
): Session[] {
  const terms = words ? splitWords(query) : [query];
  const hits = new Map<string, Hit[]>();
  const add = (sessionID: string, hit: Hit) => {
    const list = hits.get(sessionID);
    if (list) list.push(hit);
    else hits.set(sessionID, [hit]);
  };

  for (const row of candidateMessages(db, sessions, terms, include, filters)) {
    for (const [source, text] of extract(row.type, row.data, include)) {
      for (const term of terms) {
        for (const match of text.matchAll(new RegExp(escapeRegExp(term), 'gi'))) {
          add(row.session_id, {
            time: row.time_created,
            messageID: row.id,
            source,
            term,
            text,
            start: match.index,
            end: match.index + match[0].length,
          });
        }
      }
    }
  }

  for (const session of sessions.values()) {
    for (const term of terms) {
      if (session.title.toLowerCase().includes(term.toLowerCase())) {
        add(session.id, {
          time: session.created_ms,
          messageID: null,
          source: 'title',
          term,
          text: session.title,
        });
      }
    }
  }

  const results: (Session & { last_match_ms: number })[] = [];
  for (const [sessionID, matches] of hits) {
    const found = new Set(matches.map((match) => match.term));
    if (found.size !== new Set(terms).size) continue;
    matches.sort((a, b) => b.time - a.time);
    const session = sessions.get(sessionID)!;
    results.push({
      id: session.id,
      title: session.title,
      directory: session.directory,
      parent_id: session.parent_id,
      project_id: session.project_id,
      same_project: session.same_project,
      archived: session.archived,
      created: iso(session.created_ms),
      updated: iso(session.updated_ms),
      match_count: matches.length,
      last_match: iso(matches[0]!.time),
      last_match_ms: matches[0]!.time,
      matches: matches
        .slice(0, filters.excerpts)
        .map((match) => renderMatch(match, words, filters.context)),
    });
  }

  results.sort((a, b) =>
    b.last_match_ms !== a.last_match_ms
      ? b.last_match_ms - a.last_match_ms
      : b.id < a.id
        ? -1
        : b.id > a.id
          ? 1
          : 0,
  );
  return results.map(({ last_match_ms: _, ...session }) => session);
}

function renderMatch(match: Hit, words: boolean, context: number): Match {
  return {
    ...(words ? { term: match.term } : {}),
    time: iso(match.time),
    message_id: match.messageID,
    source: match.source,
    excerpt:
      match.start === undefined
        ? match.text
        : excerpt(match.text, match.start, match.end!, context),
  };
}

interface Message {
  id: string;
  session_id: string;
  type: string;
  time_created: number;
  data: Json;
}

function* candidateMessages(
  db: Database,
  sessions: Map<string, Candidate>,
  terms: string[],
  include: Set<Source>,
  filters: Filters,
): Generator<Message> {
  const types = ['user', 'assistant', 'compaction'];
  if (include.has('tools')) types.push('shell', 'synthetic');
  if (include.has('system')) types.push('system');
  const params: SQLQueryBindings[] = [];
  let data = 'data';
  if (!include.has('tools')) {
    const parts = ['text', ...(include.has('reasoning') ? ['reasoning'] : [])];
    data =
      "CASE WHEN type = 'assistant' THEN json_object('content', json((" +
      "SELECT json_group_array(json(j.value)) FROM json_each(data, '$.content') AS j " +
      `WHERE j.value ->> 'type' IN (${placeholders(parts.length)})))) ELSE data END`;
    params.push(...parts);
  }
  const clauses = terms.map(() => "data LIKE ? ESCAPE '\\'").join(' OR ');
  let sql =
    `SELECT id, session_id, type, time_created, ${data} AS data FROM session_message ` +
    `WHERE type IN (${placeholders(types.length)}) AND (${clauses})`;
  params.push(...types);
  params.push(...terms.map((term) => `%${likeEscape(JSON.stringify(term).slice(1, -1))}%`));
  if (filters.sessionFilter) {
    sql += ' AND session_id IN (SELECT value FROM json_each(?))';
    params.push(JSON.stringify([...sessions.keys()]));
  }
  if (filters.since !== undefined) {
    sql += ' AND time_created >= ?';
    params.push(filters.since);
  }
  if (filters.until !== undefined) {
    sql += ' AND time_created < ?';
    params.push(filters.until);
  }
  for (const row of db.query<Row, SQLQueryBindings[]>(sql).iterate(...params)) {
    const sessionID = row['session_id'] as string;
    if (!sessions.has(sessionID)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row['data'] as string);
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;
    yield {
      id: row['id'] as string,
      session_id: sessionID,
      type: row['type'] as string,
      time_created: row['time_created'] as number,
      data: parsed,
    };
  }
}

export function* extract(
  kind: string,
  data: Json,
  include: Set<Source>,
): Generator<[string, string]> {
  if (kind === 'user') {
    yield ['user', text(data['text'])];
  } else if (kind === 'assistant') {
    const content = Array.isArray(data['content']) ? data['content'] : [];
    for (const part of content) {
      if (!isObject(part)) continue;
      const type = part['type'];
      if (type === 'text') {
        yield ['assistant', text(part['text'])];
      } else if (type === 'reasoning' && include.has('reasoning')) {
        yield ['reasoning', text(part['text'])];
      } else if (type === 'tool' && include.has('tools')) {
        const source = `tool:${String(part['name'])}`;
        const state = isObject(part['state']) ? part['state'] : {};
        if (state['input'] !== undefined && state['input'] !== null) {
          yield [`${source}:input`, JSON.stringify(state['input'])];
        }
        const outputs = Array.isArray(state['content']) ? state['content'] : [];
        for (const output of outputs) {
          if (isObject(output) && output['type'] === 'text') {
            yield [`${source}:output`, text(output['text'])];
          }
        }
        const error = state['error'];
        if (isObject(error)) yield [`${source}:error`, text(error['message'])];
        else if (typeof error === 'string') yield [`${source}:error`, error];
      }
    }
  } else if (kind === 'compaction') {
    yield ['compaction', text(data['summary'])];
  } else if (kind === 'shell' && include.has('tools')) {
    yield ['shell:command', text(data['command'])];
    const output = isObject(data['output']) ? data['output'] : {};
    yield ['shell:output', text(output['output'])];
  } else if (kind === 'synthetic' && include.has('tools')) {
    yield ['synthetic', text(data['text'])];
  } else if (kind === 'system' && include.has('system')) {
    yield ['system', text(data['text'])];
  }
}

export function excerpt(value: string, start: number, end: number, context: number): string {
  let first = Math.max(0, start - context);
  let last = Math.min(value.length, end + context);
  if (first > 0 && isLowSurrogate(value.charCodeAt(first))) first -= 1;
  if (last < value.length && isLowSurrogate(value.charCodeAt(last))) last += 1;
  const snippet = splitWords(value.slice(first, last)).join(' ');
  return (first > 0 ? '…' : '') + snippet + (last < value.length ? '…' : '');
}

export function iso(ms: number): string {
  const date = new Date(ms);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const pad = (value: number) => String(Math.trunc(Math.abs(value))).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  );
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function splitWords(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function likeEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}
