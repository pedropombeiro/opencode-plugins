import type { Plugin } from '@opencode/plugin/tui';
import type { Result, Session } from './db.ts';
import {
  LIMIT,
  dialogTitle,
  noMatches,
  openSession,
  summarize,
  toOptions,
  type PromptRequest,
} from './present.ts';
import { openRequested } from './route.ts';
import { SessionSearchRpc, type OpenRequest } from './rpc.ts';

const SEARCH_TIMEOUT_MS = 120_000;

export default {
  id: 'opencode-session-finder',
  setup(context) {
    const rpc = context.client.rpc(SessionSearchRpc);
    const toast = context.ui.toast.show;

    function location() {
      const route = context.ui.router.current();
      const sessionID = route.type === 'session' ? route.sessionID : undefined;
      const directory =
        (sessionID ? context.data.session.get(sessionID)?.location.directory : undefined) ??
        context.location?.directory ??
        context.data.location.default().directory;
      return { sessionID, directory };
    }

    async function choose(query: string, result: Result) {
      const sessions = new Map<string, Session>(
        result.sessions.map((session) => [session.id, session]),
      );
      const id = await context.ui.dialog.select({
        title: dialogTitle(result),
        options: toOptions(result.sessions),
        actions: [
          {
            bind: 'ctrl+s',
            title: 'Summarize here',
            onTrigger: async (value: string) => {
              const session = sessions.get(value);
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
      const session = id ? sessions.get(id) : undefined;
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

      toast({ message: `Searching sessions for "${query}"…`, variant: 'info' });
      const { sessionID, directory } = location();
      let result: Result;
      try {
        result = (await rpc.search(
          { query, directory, limit: LIMIT, ...(sessionID ? { sessionID } : {}) },
          { location: { directory }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) },
        )) as unknown as Result;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        toast({ title: 'Session search failed', message: reason, variant: 'error' });
        return;
      }
      if (result.sessions.length === 0) {
        toast({ message: noMatches(result), variant: 'warning' });
        return;
      }
      await choose(query, result);
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
      stopSlot();
      stopEvents();
    };
  },
} satisfies Plugin.Definition;
