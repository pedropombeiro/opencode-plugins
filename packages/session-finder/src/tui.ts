import type { Plugin } from '@opencode/plugin/tui';
import { createSignal } from 'solid-js';
import type { Result } from './db.ts';
import {
  LIMIT,
  SPINNER_INTERVAL_MS,
  filterOptions,
  openSession,
  stateTitle,
  summarize,
  toOptions,
  withTitleMatches,
  type PromptRequest,
} from './present.ts';
import { openRequested } from './route.ts';
import { SessionSearchRpc, type OpenRequest, type SearchRequest } from './rpc.ts';

const SEARCH_TIMEOUT_MS = 120_000;

export default {
  id: 'opencode-session-finder',
  setup(context) {
    const rpc = context.client.rpc(SessionSearchRpc);
    const toast = context.ui.toast.show;
    const animate = context.options?.['animations'] !== false;
    const lifetime = new AbortController();

    function location() {
      const route = context.ui.router.current();
      const sessionID = route.type === 'session' ? route.sessionID : undefined;
      const directory =
        (sessionID ? context.data.session.get(sessionID)?.location.directory : undefined) ??
        context.location?.directory ??
        context.data.location.default().directory;
      return { sessionID, directory };
    }

    function failed(error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      toast({ title: 'Session search failed', message: reason, variant: 'error' });
    }

    async function choose(query: string, titles: Promise<Result>, full: Promise<Result>) {
      const [result, setResult] = createSignal<Result | undefined>();
      const [kept, setKept] = createSignal(0);
      const [searching, setSearching] = createSignal(true);
      const [failure, setFailure] = createSignal(false);
      const [frame, setFrame] = createSignal(0);
      const timer = animate
        ? setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL_MS)
        : undefined;
      const stop = () => clearInterval(timer);
      let open = true;
      let complete = false;
      let preview: Result | undefined;
      const close = () => {
        if (!open) return;
        open = false;
        stop();
        context.ui.dialog.clear();
      };
      lifetime.signal.addEventListener('abort', close, { once: true });
      void titles.then(
        (found) => {
          if (!open || complete || !found.sessions.length) return;
          preview = found;
          setKept(found.sessions.length);
          setResult(found);
        },
        () => {},
      );
      void full
        .then(
          (found) => {
            if (!open) return;
            complete = true;
            setResult(preview ? withTitleMatches(found, preview) : found);
            setSearching(false);
          },
          (error) => {
            if (!open) return;
            failed(error);
            setFailure(true);
            setSearching(false);
          },
        )
        .finally(stop);
      const find = (id: string) => result()?.sessions.find((session) => session.id === id);
      let id: string | undefined;
      try {
        id = await context.ui.dialog.select<string>({
          get title() {
            return stateTitle({
              query,
              result: result(),
              searching: searching(),
              failed: failure(),
              ...(animate ? { frame: frame() } : {}),
            });
          },
          placeholder: 'Filter results',
          get options() {
            return toOptions(result()?.sessions ?? [], kept());
          },
          search: filterOptions,
          actions: [
            {
              bind: 'ctrl+s',
              title: 'Summarize here',
              onTrigger: async (value: string) => {
                const session = find(value);
                if (!session) return;
                context.ui.dialog.clear();
                toast(
                  await summarize(query, session, context.ui.router.current(), (request) =>
                    context.client.session.prompt(request as PromptRequest),
                  ),
                );
              },
            },
          ],
        });
      } finally {
        lifetime.signal.removeEventListener('abort', close);
        open = false;
        stop();
      }
      const session = id ? find(id) : undefined;
      if (!session) return;
      const warning = openSession(context.ui, session);
      if (warning) toast(warning);
    }

    async function run(input?: string) {
      const query =
        input?.trim() ||
        (
          await context.ui.dialog.prompt({
            title: 'Search sessions',
            placeholder: 'Keyword or sentence',
          })
        )?.trim();
      if (!query) return;

      const { sessionID, directory } = location();
      const cancel = new AbortController();
      const call = {
        location: { directory },
        signal: AbortSignal.any([
          cancel.signal,
          lifetime.signal,
          AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        ]),
      };
      const request: SearchRequest = {
        query,
        directory,
        limit: LIMIT,
        ...(sessionID ? { sessionID } : {}),
      };
      const search = (body: SearchRequest) => rpc.search(body, call) as unknown as Promise<Result>;
      const full = search(request);
      const titles = search({ ...request, titles: true });
      try {
        await choose(query, titles, full);
      } finally {
        cancel.abort();
      }
    }

    const stopSlot = context.ui.slot({
      append: 'app',
      render: () => {
        context.keymap.layer(() => ({
          mode: 'global',
          commands: [
            {
              id: 'opencode-session-finder.search',
              title: 'Search sessions',
              group: 'Session',
              bind: '<leader>f',
              palette: true,
              slash: { name: 'search-session', arguments: true },
              run,
            },
          ],
        }));
        return null;
      },
    });

    const stopEvents = rpc.events.on('requested', (event) => {
      const request = event.data as unknown as OpenRequest;
      const action = openRequested(context.ui, request);
      if (!action) return;
      const target = event.location ?? context.location ?? context.data.location.default();
      void rpc
        .handled({ requestID: request.requestID, action }, { location: target })
        .catch(() => {});
    });

    return () => {
      lifetime.abort();
      stopSlot();
      stopEvents();
    };
  },
} satisfies Plugin.Definition;
