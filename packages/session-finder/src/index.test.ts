import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from './index.ts';
import type { Result } from './db.ts';

const dir = mkdtempSync(join(tmpdir(), 'session-finder-index-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Tool = {
  name: string;
  execute: (
    input: unknown,
    context: { sessionID: string; signal: AbortSignal },
  ) => Promise<{
    content: string;
  }>;
};
type Handlers = Record<string, (input: unknown, context: { signal: AbortSignal }) => unknown>;

const sessions: Record<
  string,
  {
    id: string;
    projectID: string;
    parentID?: string;
    title?: string;
    location: { directory: string };
  }
> = {
  ses_current: { id: 'ses_current', projectID: 'p1', location: { directory: '/repo' } },
  ses_target: {
    id: 'ses_target',
    projectID: 'p1',
    title: 'Target',
    location: { directory: '/repo' },
  },
  ses_child: {
    id: 'ses_child',
    projectID: 'p1',
    parentID: 'ses_target',
    location: { directory: '/repo' },
  },
  ses_other: { id: 'ses_other', projectID: 'p2', location: { directory: '/other' } },
};

function database() {
  const path = join(dir, 'opencode.db');
  const db = new Database(path);
  db.run(
    'CREATE TABLE session_v2 (id text, project_id text, parent_id text, directory text, ' +
      'title text, time_created integer, time_updated integer, time_archived integer)',
  );
  db.run(
    'CREATE TABLE session_message (id text, session_id text, type text, time_created integer, ' +
      'data text)',
  );
  for (const [index, id] of ['ses_current', 'ses_target'].entries()) {
    db.run('INSERT INTO session_v2 VALUES (?, ?, NULL, ?, ?, ?, ?, NULL)', [
      id,
      'p1',
      '/repo',
      id,
      index,
      index,
    ]);
    db.run('INSERT INTO session_message VALUES (?, ?, ?, ?, ?)', [
      `msg_${index}`,
      id,
      'user',
      index,
      JSON.stringify({ text: 'needle' }),
    ]);
  }
  db.close();
  return path;
}

const path = database();

async function setup() {
  const tools = new Map<string, Tool>();
  let handlers: Handlers = {};
  const emitted: { name: string; data: Record<string, unknown> }[] = [];
  const ctx = {
    options: { database: path },
    location: { directory: '/repo' },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const session = sessions[sessionID];
        if (!session) throw new Error('not found');
        return session;
      },
    },
    rpc: {
      register: async (_definition: unknown, value: Handlers) => {
        handlers = value;
        return {
          events: {
            emit: async (name: string, data: Record<string, unknown>) => {
              emitted.push({ name, data });
              queueMicrotask(() =>
                handlers['handled']!(
                  { requestID: data['requestID'], action: 'tab' },
                  { signal: new AbortController().signal },
                ),
              );
            },
          },
          dispose: async () => {},
        };
      },
    },
    tool: {
      transform: async (edit: (editor: { add: (tool: Tool) => void }) => void) => {
        edit({ add: (tool) => tools.set(tool.name, tool) });
        return { dispose: async () => {} };
      },
    },
  };
  await plugin.setup(ctx as never);
  return { tools, handlers: () => handlers, emitted };
}

const context = (sessionID = 'ses_current') => ({
  sessionID,
  signal: new AbortController().signal,
});

test('search_sessions excludes the calling session', async () => {
  const { tools } = await setup();
  const output = await tools.get('search_sessions')!.execute({ query: 'needle' }, context());
  const result = JSON.parse(output.content) as Result;
  expect(result.sessions.map((session) => session.id)).toEqual(['ses_target']);
  expect(result.sessions[0]!.same_project).toBe(true);
});

test('the search RPC method serves the palette', async () => {
  const { handlers } = await setup();
  const result = (await handlers()['search']!(
    { query: 'needle', sessionID: 'ses_target' },
    { signal: new AbortController().signal },
  )) as Result;
  expect(result.sessions.map((session) => session.id)).toEqual(['ses_current']);
  expect(result.sessions[0]!.matches).toHaveLength(1);
});

test('open_session asks the terminal to open the target and reports the action', async () => {
  const { tools, emitted } = await setup();
  const output = await tools
    .get('open_session')!
    .execute({ session_id: 'ses_child', close_source: true }, context());
  expect(emitted).toEqual([
    {
      name: 'requested',
      data: expect.objectContaining({
        sourceSessionIDs: ['ses_current'],
        sessionID: 'ses_child',
        rootSessionID: 'ses_target',
        root: false,
        closeSource: true,
      }),
    },
  ]);
  expect(output.content).toBe('Opened ses_child: the terminal focused its tab.');
});

test('open_session rejects sessions of other projects and unknown sessions', async () => {
  const { tools } = await setup();
  const open = tools.get('open_session')!;
  await expect(open.execute({ session_id: 'ses_other' }, context())).rejects.toThrow(
    'belongs to another project',
  );
  await expect(open.execute({ session_id: 'ses_missing' }, context())).rejects.toThrow(
    'Session ses_missing was not found.',
  );
});
