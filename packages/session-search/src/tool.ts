import { SOURCES, type SearchOptions, type Source } from './db.ts';

export const SEARCH_DESCRIPTION = [
  'Search previous OpenCode sessions for a keyword or sentence, newest match first.',
  'Use it when the user asks which earlier session discussed something, where a phrase,',
  'command, or decision came up, or wants to return to a past conversation. The session',
  'list API matches titles only; this tool searches message text.',
  '',
  'Matching is literal and case-insensitive: pass the wording as is, without wildcards or',
  'regular expressions. User messages, assistant replies, compaction summaries, and titles',
  'are always searched, and the current session is excluded.',
  '',
  'When a search finds nothing, the tool retries it with `words` for a multi-word query,',
  'then with tool output included. `searches` lists each search that ran; `mode` and',
  '`include` describe the one that produced the results.',
  '',
  'Present the results: list each session with its title, ID, directory, and the date of',
  'its last match, and quote the most relevant excerpt. List sessions whose `same_project`',
  'is true first and mark them as the current project. Mention `total_sessions` when it is',
  'larger than the number shown. When `include` contains `tools` and you did not request',
  'it, say that nothing matched the conversation text and the matches come from tool calls',
  'and their output. If nothing matches, say which searches ran.',
  '',
  'When the user wants to act on a session, ask in one question tool call. If several',
  'sessions match, ask which one, labeling each option with the session title and putting its',
  'ID and date in the description. Ask what to do with it, offering only the actions that apply:',
  '- Switch and close search tab: only when `same_project` is true; recommend it first. Call',
  '  `open_session` with `close_source: true`.',
  '- Open session: only when `same_project` is true. Call `open_session` without `close_source`.',
  '- Summarize here: search again with `session_id`, more `excerpts`, and a larger `context`,',
  '  and summarize the matches.',
  '- Show more matches: only when `total_sessions` is larger than shown. Search again with a',
  '  larger `limit`.',
  'If `open_session` fails, show its error instead of retrying, and tell the user to reopen the',
  'session with `opencode --session <id>`. For sessions of other projects, give that command',
  'directly.',
].join('\n');

export const OPEN_DESCRIPTION =
  "Open another OpenCode session of the current project in the user's terminal, focusing its " +
  'tab or switching to it. Optionally close the source tab after opening, preserving its ' +
  'conversation in history. Only call it after the user chooses that action. It fails for ' +
  'sessions of other projects.';

export const searchInput = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, description: 'Keyword or sentence to find.' },
    words: {
      type: 'boolean',
      description: 'Match sessions that contain every word, in any message, in any order.',
    },
    include: {
      type: 'array',
      items: { type: 'string', enum: [...SOURCES] },
      description:
        'Extra sources to search. `tools` covers commands, file reads, and tool output, and is ' +
        'several times slower. `reasoning` and `system` cover model reasoning and harness messages.',
    },
    fallback: {
      type: 'boolean',
      description: 'Set to false to run only the requested search, without retries.',
    },
    session_id: {
      type: 'string',
      pattern: '^ses',
      description: 'Only this session, for example to read more of its matches.',
    },
    directory: {
      type: 'string',
      description: 'Only sessions in this directory or its subdirectories.',
    },
    current_project: {
      type: 'boolean',
      description: 'Only sessions of the current project, including its other worktrees.',
    },
    since: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      description: 'Only matches on or after this date (YYYY-MM-DD).',
    },
    until: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      description: 'Only matches before this date (YYYY-MM-DD).',
    },
    limit: { type: 'integer', minimum: 1, description: 'Maximum sessions to return. Default 10.' },
    excerpts: {
      type: 'integer',
      minimum: 0,
      description: 'Maximum excerpts per session. Default 3.',
    },
    context: {
      type: 'integer',
      minimum: 0,
      description: 'Characters of context around a match. Default 100.',
    },
    include_current: {
      type: 'boolean',
      description: 'Also search the current session.',
    },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

export const openInput = {
  type: 'object',
  properties: {
    session_id: { type: 'string', pattern: '^ses', description: 'ID of the session to open.' },
    close_source: {
      type: 'boolean',
      description:
        'Close the source tab after opening the destination. Defaults to false. Does not delete history.',
    },
  },
  required: ['session_id'],
  additionalProperties: false,
} as const;

export interface SearchInput {
  query: string;
  words?: boolean;
  include?: Source[];
  fallback?: boolean;
  session_id?: string;
  directory?: string;
  current_project?: boolean;
  since?: string;
  until?: string;
  limit?: number;
  excerpts?: number;
  context?: number;
  include_current?: boolean;
}

export function searchOptions(
  input: SearchInput,
  caller: { sessionID: string; directory: string; database?: string },
): SearchOptions {
  return {
    query: input.query,
    database: caller.database,
    words: input.words,
    include: input.include,
    fallback: input.fallback,
    sessionID: input.session_id,
    directory: input.directory,
    currentProject: input.current_project,
    since: input.since,
    until: input.until,
    limit: input.limit,
    excerpts: input.excerpts,
    context: input.context,
    includeCurrent: input.include_current,
    currentSessionID: caller.sessionID,
    cwd: caller.directory,
  };
}
