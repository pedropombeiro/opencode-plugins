import { expect, test } from 'bun:test';
import type { Result } from './db.ts';
import plugin from './tui.ts';

type Command = {
  id: string;
  bind: string;
  palette: boolean;
  slash: { name: string; arguments: boolean };
  run: (input?: string) => Promise<void>;
};
type Layer = { mode: string; commands: Command[] };
type Listener = (event: { data: unknown; location?: { directory: string } }) => void;

const empty: Result = {
  query: 'needle',
  mode: 'words',
  include: ['tools'],
  searches: [{ mode: 'phrase', include: [], total_sessions: 0 }],
  total_sessions: 0,
  sessions: [],
};

type Select = {
  title: string;
  placeholder?: string;
  options: { value: string }[];
  search?: (query: string, options: { value: string }[]) => { value: string }[];
  resolve: (value?: string) => void;
};

function setup(options: {
  prompt?: string;
  result?: Result | Promise<Result>;
  titles?: Result | Promise<Result>;
  route?: Record<string, string>;
  options?: Record<string, unknown>;
}) {
  const layers: Layer[] = [];
  const prompts: unknown[] = [];
  const toasts: { message: string; variant: string }[] = [];
  const searches: { input: unknown; location: unknown }[] = [];
  const selects: Select[] = [];
  const handled: unknown[] = [];
  const listeners: Listener[] = [];
  let route = options.route ?? { type: 'session', sessionID: 'ses_shown' };
  let render: (() => null) | undefined;
  let clears = 0;
  const context = {
    options: options.options ?? {},
    location: { directory: '/fallback' },
    data: {
      session: {
        get: (id: string) =>
          id === 'ses_shown' ? { location: { directory: '/repo' } } : undefined,
      },
      location: { default: () => ({ directory: '/default' }) },
    },
    keymap: { layer: (factory: () => Layer) => void layers.push(factory()) },
    client: {
      rpc: () => ({
        search: async (input: { titles?: boolean }, call: unknown) => {
          searches.push({ input, location: call });
          if (input.titles) return options.titles ?? empty;
          return options.result ?? empty;
        },
        handled: async (input: unknown) => void handled.push(input),
        events: {
          on: (_name: string, listener: Listener) => {
            listeners.push(listener);
            return () => {};
          },
        },
      }),
    },
    ui: {
      router: {
        current: () => route,
        navigate: (next: Record<string, string>) => {
          route = next;
        },
      },
      tabs: {
        enabled: () => true,
        focus: (sessionID: string) => {
          route = { type: 'session', sessionID };
        },
        close: () => {},
      },
      toast: { show: (toast: { message: string; variant: string }) => void toasts.push(toast) },
      dialog: {
        prompt: async (input: unknown) => {
          prompts.push(input);
          return options.prompt ?? '  ';
        },
        select: (input: Omit<Select, 'resolve'>) =>
          new Promise<string | undefined>((resolve) => {
            selects.push(Object.assign(input, { resolve }));
          }),
        clear: () => {
          clears += 1;
          selects.at(-1)?.resolve(undefined);
        },
      },
      slot(claim: { append: string; render: () => null }) {
        expect(claim.append).toBe('app');
        render = claim.render;
        return () => {};
      },
    },
  };
  const dispose = plugin.setup(context as never) as () => void;
  return {
    dispose,
    clears: () => clears,
    layers,
    prompts,
    toasts,
    searches,
    selects,
    handled,
    listeners,
    route: () => route,
    render: () => render!(),
  };
}

function found(ids: string[], overrides: Partial<Result> = {}): Result {
  return {
    ...empty,
    query: '!267387',
    mode: 'phrase',
    include: [],
    total_sessions: ids.length,
    sessions: ids.map((id) => ({
      id,
      title: id,
      directory: '/repo',
      parent_id: null,
      project_id: 'p1',
      same_project: true,
      archived: false,
      created: '2026-10-09T19:00:00+02:00',
      updated: '2026-10-09T19:00:00+02:00',
      match_count: 1,
      last_match: '2026-10-09T19:00:00+02:00',
      matches: [],
    })),
    ...overrides,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('registers a palette command that replaces /search-session', async () => {
  const { layers, prompts, searches, render } = setup({});
  expect(layers).toHaveLength(0);
  expect(render()).toBeNull();
  const command = layers[0]!.commands[0]!;
  expect(layers[0]!.mode).toBe('global');
  expect(command.bind).toBe('<leader>f');
  expect(command.palette).toBe(true);
  expect(command.slash).toEqual({ name: 'search-session', arguments: true });

  await command.run();
  expect(prompts).toHaveLength(1);
  expect(searches).toHaveLength(0);
});

function deferred() {
  let resolve!: (result: Result) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Result>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function start(env: ReturnType<typeof setup>, query = '!267387') {
  env.render();
  const running = env.layers[0]!.commands[0]!.run(query);
  await tick();
  return { running, dialog: env.selects[0]! };
}

const values = (dialog: Select) => dialog.options.map((option) => option.value);

test('searches through the server for the displayed session', async () => {
  const env = setup({});
  const { running, dialog } = await start(env, ' needle ');
  const input = { query: 'needle', directory: '/repo', limit: 30, sessionID: 'ses_shown' };
  const location = { location: { directory: '/repo' }, signal: expect.any(AbortSignal) };
  expect(env.searches).toEqual([
    { input, location },
    { input: { ...input, titles: true }, location },
  ]);
  expect(dialog.title).toBe('No sessions matched "needle". Searched: exact phrase.');
  expect(dialog.options).toEqual([]);
  dialog.resolve(undefined);
  await running;
  expect(env.toasts).toEqual([]);
});

test('uses the location directory on the home screen', async () => {
  const env = setup({ route: { type: 'home' } });
  const { running, dialog } = await start(env, 'needle');
  expect(env.searches[0]!.input).toEqual({ query: 'needle', directory: '/fallback', limit: 30 });
  dialog.resolve(undefined);
  await running;
});

test('opens the dialog at once and adds each batch of results as it arrives', async () => {
  const titles = deferred();
  const full = deferred();
  const env = setup({ titles: titles.promise, result: full.promise });
  const { running, dialog } = await start(env);
  expect(dialog.title).toBe('⠋ Searching sessions for "!267387"…');
  expect(dialog.placeholder).toBe('Filter results');
  expect(values(dialog)).toEqual([]);
  expect(dialog.search).toBeDefined();

  titles.resolve(found(['ses_title']));
  await tick();
  expect(dialog.title).toBe('⠋ Sessions matching "!267387" (1, searching messages…)');
  expect(values(dialog)).toEqual(['ses_title']);

  full.resolve(found(['ses_message', 'ses_title']));
  await tick();
  expect(dialog.title).toBe('Sessions matching "!267387" (2)');
  expect(values(dialog)).toEqual(['ses_title', 'ses_message']);
  expect(dialog.search!('message', dialog.options).map((option) => option.value)).toEqual([
    'ses_message',
  ]);

  dialog.resolve('ses_message');
  await running;
  expect(env.route()).toEqual({ type: 'session', sessionID: 'ses_message' });
  expect(env.selects).toHaveLength(1);
  const signal = (env.searches[0]!.location as { signal: AbortSignal }).signal;
  expect(signal.aborted).toBe(true);
});

test('fills the dialog from the full search when no title matched', async () => {
  const full = deferred();
  const env = setup({ result: full.promise });
  const { running, dialog } = await start(env);
  await tick();
  expect(dialog.title).toBe('⠋ Searching sessions for "!267387"…');
  full.resolve(found(['ses_message']));
  await tick();
  expect(dialog.title).toBe('Sessions matching "!267387" (1)');
  expect(values(dialog)).toEqual(['ses_message']);
  dialog.resolve(undefined);
  await running;
});

test('ignores title matches that arrive after the full results', async () => {
  const titles = deferred();
  const env = setup({ titles: titles.promise, result: found(['ses_message']) });
  const { running, dialog } = await start(env);
  titles.resolve(found(['ses_title']));
  await tick();
  expect(values(dialog)).toEqual(['ses_message']);
  dialog.resolve(undefined);
  await running;
});

test('animates the title while searching and stops when the search finishes', async () => {
  const full = deferred();
  const env = setup({ result: full.promise });
  const { running, dialog } = await start(env);
  const first = dialog.title;
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(dialog.title).not.toBe(first);
  expect(dialog.title).toEndWith('Searching sessions for "!267387"…');

  full.resolve(found(['ses_message']));
  await tick();
  expect(dialog.title).toBe('Sessions matching "!267387" (1)');
  const settled = dialog.title;
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(dialog.title).toBe(settled);
  dialog.resolve(undefined);
  await running;
});

test('shows a static marker when animations are off', async () => {
  const env = setup({
    options: { animations: false },
    result: new Promise<Result>(() => {}),
  });
  const { running, dialog } = await start(env);
  expect(dialog.title).toBe('⋯ Searching sessions for "!267387"…');
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(dialog.title).toBe('⋯ Searching sessions for "!267387"…');
  dialog.resolve(undefined);
  await running;
});

test('cancels searches, stops the spinner, and closes the dialog when the plugin unloads', async () => {
  const env = setup({
    titles: new Promise<Result>(() => {}),
    result: new Promise<Result>(() => {}),
  });
  const { running, dialog } = await start(env);
  env.dispose();
  await running;
  for (const search of env.searches) {
    expect((search.location as { signal: AbortSignal }).signal.aborted).toBe(true);
  }
  expect(env.clears()).toBe(1);
  const frozen = dialog.title;
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(dialog.title).toBe(frozen);
});

test('does not close another dialog when the plugin unloads after the search', async () => {
  const env = setup({ result: found(['ses_message']) });
  const { running, dialog } = await start(env);
  dialog.resolve(undefined);
  await running;
  env.dispose();
  expect(env.clears()).toBe(0);
});

test('shows title matches that arrive after the full search failed', async () => {
  const titles = deferred();
  const env = setup({
    titles: titles.promise,
    result: Promise.reject(new Error('worker died')),
  });
  const { running, dialog } = await start(env);
  expect(dialog.title).toBe('Session search failed for "!267387"');
  titles.resolve(found(['ses_title']));
  await tick();
  expect(dialog.title).toBe('Sessions matching "!267387" (1)');
  expect(values(dialog)).toEqual(['ses_title']);
  dialog.resolve(undefined);
  await running;
});

test('cancels both searches when the dialog is closed', async () => {
  const env = setup({
    titles: new Promise<Result>(() => {}),
    result: new Promise<Result>(() => {}),
  });
  const { running, dialog } = await start(env);
  dialog.resolve(undefined);
  await running;
  for (const search of env.searches) {
    expect((search.location as { signal: AbortSignal }).signal.aborted).toBe(true);
  }
  expect(env.toasts).toEqual([]);
});

test('keeps the title results and reports a failed full search', async () => {
  const full = deferred();
  const env = setup({ titles: found(['ses_title']), result: full.promise });
  const { running, dialog } = await start(env);
  full.reject(new Error('worker died'));
  await tick();
  expect(dialog.title).toBe('Sessions matching "!267387" (1)');
  expect(env.toasts.at(-1)).toMatchObject({ message: 'worker died', variant: 'error' });
  dialog.resolve(undefined);
  await running;
});

test('reports a failed search in the dialog when nothing was found', async () => {
  const full = deferred();
  const env = setup({ result: full.promise });
  const { running, dialog } = await start(env);
  full.reject(new Error('worker died'));
  await tick();
  expect(dialog.title).toBe('Session search failed for "!267387"');
  expect(env.toasts.at(-1)).toMatchObject({ message: 'worker died', variant: 'error' });
  dialog.resolve(undefined);
  await running;
});

test('opens sessions that open_session requests in the terminal showing the caller', () => {
  const { listeners, handled } = setup({});
  listeners[0]!({
    data: {
      requestID: 'request_1',
      sourceSessionIDs: ['ses_shown'],
      sessionID: 'ses_target',
      rootSessionID: 'ses_target',
      root: true,
      closeSource: false,
    },
  });
  expect(handled).toEqual([{ requestID: 'request_1', action: 'tab' }]);
});
