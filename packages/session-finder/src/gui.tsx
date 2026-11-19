/** @jsxImportSource solid-js */
import { Command, Plugin, Style } from '@opencode/plugin/gui';
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import type { Result } from './db.ts';
import { createDesktopSearch, type DesktopSearchState } from './gui-search.ts';
import { stateTitle, toOptions } from './present.ts';
import { SessionSearchRpc } from './rpc.ts';

const CSS = `
.session-finder-search { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; padding: 0 2px; }
.session-finder-search .session-finder-input { box-sizing: border-box; width: 100%; min-width: 0; }
.session-finder-results { display: grid; gap: 8px; max-height: 50vh; overflow-y: auto; margin: 0; padding: 2px; list-style: none; }
.session-finder-result { display: grid; gap: 4px; padding: 8px 0; border-top: 1px solid var(--v2-border-border-muted); }
.session-finder-result > button { justify-self: start; max-width: 100%; white-space: normal; text-align: start; overflow-wrap: anywhere; }
.session-finder-details { color: var(--v2-text-text-muted); overflow-wrap: anywhere; }
`;

export default Plugin.define({
  setup(ctx) {
    ctx.add(Style, CSS);

    function SearchDialog(props: {
      server: string;
      directory?: string;
      sessionID?: string;
      input?: string;
      close: () => void;
    }) {
      const ui = ctx.ui;
      const [query, setQuery] = createSignal(props.input ?? '');
      const [state, setState] = createSignal<DesktopSearchState>();
      const search = createDesktopSearch((request, signal) => {
        const { directory, sessionID } = props;
        return ctx.client.rpc(SessionSearchRpc).search(
          {
            ...request,
            ...(directory ? { directory } : {}),
            ...(sessionID ? { sessionID } : {}),
          },
          { signal, ...(directory ? { location: { directory } } : {}) },
        ) as Promise<Result>;
      }, setState);
      onCleanup(search.cancel);
      if (query().trim()) void search.run(query());

      const submit = () => {
        if (!state()?.searching) void search.run(query());
      };
      const edit = (value: string) => {
        if (value.trim() !== query().trim()) {
          search.cancel();
          setState(undefined);
        }
        setQuery(value);
      };
      const results = createMemo(() =>
        toOptions(state()?.result?.sessions ?? [], state()?.titleCount),
      );
      const byID = createMemo(() => new Map(results().map((result) => [result.value, result])));
      const status = () => {
        const current = state();
        if (!current?.query) return '';
        if (current.error) return `Session search failed: ${current.error}`;
        return stateTitle({ ...current, failed: false });
      };

      return (
        <ui.Dialog title="Search sessions">
          <div class="session-finder-search">
            <ui.TextInput
              class="session-finder-input"
              label="Keyword or sentence"
              placeholder="Enter a keyword or phrase"
              value={query()}
              onInput={edit}
              onSubmit={submit}
              autofocus
            />
            <div>
              <ui.Button
                variant="contrast"
                onClick={submit}
                disabled={!query().trim() || state()?.searching}
              >
                Search
              </ui.Button>
            </div>
            <div role="status">{status()}</div>
            <Show when={results().length}>
              <ul class="session-finder-results" aria-label="Matching sessions">
                <For each={results().map((result) => result.value)}>
                  {(id) => (
                    <li class="session-finder-result">
                      <ui.Button
                        variant="ghost"
                        onClick={() => {
                          props.close();
                          ctx.tabs.open({ server: props.server, id }, { focus: true });
                        }}
                      >
                        {byID().get(id)?.title}
                      </ui.Button>
                      <div class="session-finder-details">
                        {props.directory ? `${byID().get(id)?.category} · ` : ''}
                        {byID().get(id)?.description}
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
        </ui.Dialog>
      );
    }

    const builtinServer = () =>
      ctx.servers
        .list()
        .map((id) => ctx.servers.get(id))
        .find((server) => server?.builtin);

    ctx.add(Command, (): Command => ({
      id: 'search',
      title: 'Search sessions',
      group: 'Session',
      section: 'session',
      slash: { name: 'search-session', arguments: true },
      enabled: !!builtinServer(),
      run: (input) => {
        const server = builtinServer();
        if (!server) return;
        const session = ctx.sessions.current();
        const local = session?.server.id === server.id ? session : undefined;
        ctx.dialogs.open((dialog) => (
          <SearchDialog
            server={server.id}
            directory={local?.location?.directory ?? local?.directory}
            sessionID={local?.id}
            input={input}
            close={dialog.close}
          />
        ));
      },
    }));
  },
});
