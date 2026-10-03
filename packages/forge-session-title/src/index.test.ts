import { describe, expect, mock, test } from 'bun:test';
import type { Plugin } from '@opencode/plugin';
import type { Request } from './target.ts';

const sourceBranches = new Map<string, string>();
const lookups: Request[] = [];
mock.module('./source.ts', () => ({
  sourceBranch: async (request: Request) => {
    lookups.push(request);
    return sourceBranches.get(request.iid);
  },
}));
const { default: plugin } = await import('./index.ts');

type Tool = {
  execute: (input: unknown, context: { sessionID: string }) => Promise<unknown>;
};
type Hook = (event: {
  sessionID: string;
  system: { type: string; text: string }[];
}) => Promise<void>;

async function harness(storage = new Map<string, unknown>()) {
  const sessions = new Map([
    [
      'one',
      {
        title: '[#123, !45] Review changes',
        location: { directory: process.cwd() },
        parentID: undefined as string | undefined,
      },
    ],
    [
      'two',
      {
        title: 'Other session',
        location: { directory: process.cwd() },
        parentID: undefined as string | undefined,
      },
    ],
  ]);
  let tool: Tool;
  let hook: Hook;
  let renames = 0;
  let rpcHandlers: Record<string, (input: unknown) => Promise<unknown>> = {};
  const emitted: Array<{ name: string; data: unknown }> = [];
  let rpcDisposed = false;
  const ctx = {
    rpc: {
      register: async (
        _definition: unknown,
        handlers: Record<string, (input: unknown) => Promise<unknown>>,
      ) => {
        rpcHandlers = handlers;
        return {
          events: {
            emit: async (name: string, data: unknown) => {
              emitted.push({ name, data });
            },
          },
          dispose: async () => {
            rpcDisposed = true;
          },
        };
      },
    },
    location: { directory: process.cwd() },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => sessions.get(sessionID),
      update: async ({ sessionID, title }: { sessionID: string; title: string }) => {
        sessions.get(sessionID)!.title = title;
        renames++;
      },
      hook: async (_name: string, callback: Hook) => {
        hook = callback;
      },
    },
    tool: {
      transform: async (callback: (editor: { add: (value: Tool) => void }) => void) => {
        callback({
          add: (value) => {
            tool = value;
          },
        });
      },
    },
    vcs: { get: async () => ({ data: { branch: { current: 'main', default: 'main' } } }) },
    event: { subscribe: async function* () {} },
  };
  const cleanup = await plugin.setup(ctx as unknown as Plugin.Context);
  return {
    sessions,
    cleanup,
    renames: () => renames,
    emitted,
    rpcDisposed: () => rpcDisposed,
    target: (sessionID = 'one') => rpcHandlers.target!({ sessionID }),
    set: (input: unknown, sessionID = 'one') => tool.execute(input, { sessionID }),
    context: async (sessionID = 'one') => {
      const event = { sessionID, system: [] as { type: string; text: string }[] };
      await hook(event);
      return event.system.map((part) => part.text).join('\n');
    },
  };
}

describe('session target integration', () => {
  const mr = 'https://gitlab.com/group/project/-/merge_requests/456';
  const nextMr = 'https://gitlab.com/group/project/-/merge_requests/789';

  test('registers guidance and replaces branch references even on main', async () => {
    const app = await harness();
    expect(await app.context()).toContain('call set_session_target');
    await app.set({ target: mr });
    expect(app.sessions.get('one')?.title).toBe('[!456] Review changes');
    expect(await app.context()).toContain(mr);
    expect(await app.context('two')).not.toContain(mr);
    expect(app.sessions.get('two')?.title).toBe('Other session');
    await app.cleanup();
  });

  test('persists the target and owned prefix across plugin reloads', async () => {
    const storage = new Map<string, unknown>();
    const first = await harness(storage);
    await first.set({ target: mr, issue_url: 'https://gitlab.com/group/project/-/issues/42' });
    const title = first.sessions.get('one')!.title;
    await first.cleanup();

    const second = await harness(storage);
    second.sessions.get('one')!.title = title;
    expect(await second.context()).toContain(mr);
    await second.set({ target: nextMr });
    expect(second.sessions.get('one')?.title).toBe('[!789] Review changes');
    await second.set({ target: nextMr });
    expect(second.renames()).toBe(1);
    await second.cleanup();
  });

  test('reset removes the prefix on main and restores automatic context', async () => {
    const app = await harness();
    await app.set({ target: mr });
    await app.set({ target: 'branch' });
    expect(app.sessions.get('one')?.title).toBe('Review changes');
    expect(await app.context()).toContain('checked-out branch (automatic)');
    await app.cleanup();
  });

  test('serializes concurrent switches and drops the previous related issue', async () => {
    const app = await harness();
    await Promise.all([
      app.set({ target: mr, issue_url: 'https://gitlab.com/group/project/-/issues/42' }),
      app.set({ target: nextMr }),
    ]);
    expect(app.sessions.get('one')?.title).toBe('[!789] Review changes');
    await app.cleanup();
  });

  test('rejects invalid targets without changing the current target', async () => {
    const app = await harness();
    await app.set({ target: mr });
    await expect(app.set({ target: '!789' })).rejects.toThrow();
    expect(app.sessions.get('one')?.title).toBe('[!456] Review changes');
    expect(await app.context()).toContain(mr);
    await app.cleanup();
  });

  test('tells the agent to target a newly created MR with its issue', async () => {
    const app = await harness();
    expect(await app.context()).toContain('After you create a PR or MR for the current task');
    await app.set({ target: 'https://gitlab.com/group/project/-/issues/123' });
    expect(app.sessions.get('one')?.title).toBe('[#123] Review changes');
    await app.set({ target: mr, issue_url: 'https://gitlab.com/group/project/-/issues/123' });
    expect(app.sessions.get('one')?.title).toBe('[#123, !456] Review changes');
    await app.cleanup();
  });

  test('infers the related issue from the MR source branch', async () => {
    sourceBranches.set('456', '321-fix-timeout');
    lookups.length = 0;
    try {
      const app = await harness();
      await app.set({ target: mr });
      expect(lookups).toEqual([
        { forge: 'gitlab', host: 'gitlab.com', project: 'group/project', iid: '456' },
      ]);
      expect(app.sessions.get('one')?.title).toBe('[#321, !456] Review changes');
      expect(await app.context()).toContain('"branchIssue":"321"');
      await app.set({ target: nextMr });
      expect(app.sessions.get('one')?.title).toBe('[!789] Review changes');
      await app.cleanup();
    } finally {
      sourceBranches.clear();
    }
  });

  test('prefers an explicit issue and skips lookups for issue targets', async () => {
    sourceBranches.set('456', '321-fix-timeout');
    lookups.length = 0;
    try {
      const app = await harness();
      await app.set({ target: mr, issue_url: 'https://gitlab.com/group/other/-/issues/42' });
      expect(app.sessions.get('one')?.title).toBe('[#42, !456] Review changes');
      await app.set({ target: 'https://gitlab.com/group/project/-/issues/7' });
      expect(app.sessions.get('one')?.title).toBe('[#7] Review changes');
      expect(lookups).toEqual([]);
      await app.cleanup();
    } finally {
      sourceBranches.clear();
    }
  });

  test('exposes the target over RPC and announces changes', async () => {
    const storage = new Map<string, unknown>();
    const app = await harness(storage);
    expect(await app.target()).toEqual({});
    const issue = 'https://gitlab.com/group/project/-/issues/42';
    await app.set({ target: mr, issue_url: issue });
    expect(await app.target()).toEqual({ url: mr, issueUrl: issue });
    expect(await app.target('two')).toEqual({});
    await app.set({ target: 'branch' });
    expect(await app.target()).toEqual({});
    expect(app.emitted).toEqual([
      { name: 'targetChanged', data: { sessionID: 'one', url: mr, issueUrl: issue } },
      { name: 'targetChanged', data: { sessionID: 'one' } },
    ]);
    await app.cleanup();
    expect(app.rpcDisposed()).toBe(true);

    const reloaded = await harness(storage);
    await reloaded.set({ target: nextMr });
    expect(await reloaded.target()).toEqual({ url: nextMr });
    await reloaded.cleanup();
  });

  test('skips child sessions and sessions in another location', async () => {
    const app = await harness();
    app.sessions.get('one')!.parentID = 'parent';
    expect(await app.context()).toBe('');
    await expect(app.set({ target: mr })).rejects.toThrow('root session');
    app.sessions.get('two')!.location.directory = '/another/location';
    expect(await app.context('two')).toBe('');
    await expect(app.set({ target: mr }, 'two')).rejects.toThrow('root session');
    await app.cleanup();
  });
});
