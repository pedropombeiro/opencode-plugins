import type { Attempt, Result, Session } from './db.ts';

export type Option = { title: string; value: string; description: string; category: string };

export type Route = { type: string; sessionID?: string };

export type Toast = {
  title?: string;
  message: string;
  variant: 'info' | 'success' | 'warning' | 'error';
};

export const LIMIT = 30;
const EXCERPT_LENGTH = 120;

export function clip(text: string, length = EXCERPT_LENGTH) {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

export function describeSearch(search: Pick<Attempt, 'mode' | 'include'>) {
  const parts = [search.mode === 'words' ? 'all words' : 'exact phrase'];
  if (search.include.includes('tools')) parts.push('tool output');
  return parts.join(', ');
}

export function noMatches(result: Result) {
  const searches = result.searches.map(describeSearch).join('; ');
  return `No sessions matched "${clip(result.query, 40)}". Searched: ${searches}.`;
}

export function dialogTitle(result: Result) {
  const count =
    result.total_sessions > result.sessions.length
      ? `${result.sessions.length} of ${result.total_sessions}`
      : String(result.sessions.length);
  const fallback =
    result.mode === 'words' || result.include.includes('tools')
      ? `, ${describeSearch(result)}`
      : '';
  return `Sessions matching "${clip(result.query, 40)}" (${count}${fallback})`;
}

export function toOptions(sessions: Session[]): Option[] {
  const current = sessions.filter((session) => session.same_project === true);
  const other = sessions.filter((session) => session.same_project !== true);
  return [...current, ...other].map((session) => {
    const details = [session.last_match.slice(0, 10)];
    if (session.same_project !== true) details.push(session.directory);
    if (session.archived) details.push('archived');
    const excerpt = session.matches[0]?.excerpt;
    if (excerpt) details.push(clip(excerpt));
    return {
      title: session.title || session.id,
      value: session.id,
      description: details.join(' · '),
      category: session.same_project === true ? 'Current project' : 'Other projects',
    };
  });
}

export interface SessionUI {
  router: { navigate(route: { type: 'session'; sessionID: string }): void };
  tabs: { enabled(): boolean; focus(sessionID: string): unknown };
}

export function openSession(ui: SessionUI, session: Session): Toast | undefined {
  if (session.same_project !== true) {
    return {
      title: 'Session belongs to another project',
      message: `Reopen it with: opencode --session ${session.id}`,
      variant: 'warning',
    };
  }
  if (ui.tabs.enabled() && !session.parent_id) ui.tabs.focus(session.id);
  else ui.router.navigate({ type: 'session', sessionID: session.id });
}

export type PromptRequest = {
  sessionID: string;
  text: string;
  delivery: 'queue';
  resume: true;
};

export function summaryPrompt(query: string, session: Session) {
  return [
    `Summarize what the previous session "${session.title}" (${session.id}) discussed about "${query}".`,
    'Read its matches with the `search_sessions` tool:',
    `\`{"query": ${JSON.stringify(query)}, "session_id": "${session.id}", "excerpts": 10, "context": 400}\`.`,
  ].join(' ');
}

export async function summarize(
  query: string,
  session: Session,
  route: Route,
  prompt: (request: PromptRequest) => Promise<unknown>,
): Promise<Toast> {
  if (route.type !== 'session' || !route.sessionID) {
    return { message: 'Open a session to summarize a search result in it', variant: 'warning' };
  }
  try {
    await prompt({
      sessionID: route.sessionID,
      text: summaryPrompt(query, session),
      delivery: 'queue',
      resume: true,
    });
    return { title: 'Summary requested', message: clip(session.title, 60), variant: 'success' };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { message: `Could not request the summary: ${reason}`, variant: 'error' };
  }
}
