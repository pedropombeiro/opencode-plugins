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

function setup(options: { prompt?: string; result?: Result; route?: Record<string, string> }) {
  const layers: Layer[] = [];
  const prompts: unknown[] = [];
  const toasts: { message: string; variant: string }[] = [];
  const searches: { input: unknown; location: unknown }[] = [];
  const handled: unknown[] = [];
  const listeners: Listener[] = [];
  let route = options.route ?? { type: 'session', sessionID: 'ses_shown' };
  let render: (() => null) | undefined;
  const context = {
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
        search: async (input: unknown, call: unknown) => {
          searches.push({ input, location: call });
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
      },
      slot(claim: { append: string; render: () => null }) {
        expect(claim.append).toBe('app');
        render = claim.render;
        return () => {};
      },
    },
  };
  plugin.setup(context as never);
  return {
    layers,
    prompts,
    toasts,
    searches,
    handled,
    listeners,
    render: () => render!(),
  };
}

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

test('searches through the server for the displayed session', async () => {
  const { layers, searches, toasts, render } = setup({});
  render();
  await layers[0]!.commands[0]!.run(' needle ');
  expect(searches).toEqual([
    {
      input: { query: 'needle', directory: '/repo', limit: 30, sessionID: 'ses_shown' },
      location: { location: { directory: '/repo' }, signal: expect.any(AbortSignal) },
    },
  ]);
  expect(toasts.at(-1)).toEqual({
    message: 'No sessions matched "needle". Searched: exact phrase.',
    variant: 'warning',
  });
});

test('uses the location directory on the home screen', async () => {
  const { layers, searches, render } = setup({ route: { type: 'home' } });
  render();
  await layers[0]!.commands[0]!.run('needle');
  expect(searches[0]!.input).toEqual({ query: 'needle', directory: '/fallback', limit: 30 });
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
