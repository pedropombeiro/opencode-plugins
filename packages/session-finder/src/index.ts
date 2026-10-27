import type { Plugin } from '@opencode/plugin';
import { randomUUID } from 'node:crypto';
import { rejectReason, type SessionRef } from './match.ts';
import { reply, waitForReply } from './pending.ts';
import { LIMIT } from './present.ts';
import { SessionSearchRpc, type OpenAction, type SearchRequest } from './rpc.ts';
import { runSearch } from './run.ts';
import {
  OPEN_DESCRIPTION,
  SEARCH_DESCRIPTION,
  openInput,
  searchInput,
  searchOptions,
  type SearchInput,
} from './tool.ts';

const REPLY_TIMEOUT_MS = 3_000;
const MAX_ANCESTORS = 10;

type SessionGet = (input: { sessionID: string }) => Promise<SessionRef & { title?: string }>;

async function ancestry(get: SessionGet, session: SessionRef): Promise<string[]> {
  const ids = [session.id];
  let parentID = session.parentID;
  while (parentID && ids.length <= MAX_ANCESTORS) {
    ids.push(parentID);
    parentID = (await get({ sessionID: parentID })).parentID;
  }
  return ids;
}

function describe(action: OpenAction): string {
  return action === 'tab' ? 'focused its tab' : 'navigated to it';
}

function databaseOption(options: unknown): string | undefined {
  if (!options || typeof options !== 'object') return undefined;
  const value = (options as Record<string, unknown>)['database'];
  return typeof value === 'string' && value ? value : undefined;
}

export default {
  id: 'opencode-session-finder',
  async setup(ctx) {
    const get = ctx.session.get as unknown as SessionGet;
    const database = databaseOption(ctx.options);

    const rpc = await ctx.rpc.register(SessionSearchRpc, {
      handled: async (input) => {
        const { requestID, action } = input as { requestID: string; action: OpenAction };
        reply(requestID, action);
        return {};
      },
      search: async (input, { signal }) => {
        const request = input as SearchRequest;
        const result = await runSearch(
          {
            query: request.query,
            database,
            limit: request.limit ?? LIMIT,
            excerpts: 1,
            currentSessionID: request.sessionID,
            cwd: request.directory ?? ctx.location.directory,
          },
          signal,
        );
        return result as unknown as Record<string, unknown>;
      },
    });

    const tools = await ctx.tool.transform((editor) => {
      editor.add({
        name: 'search_sessions',
        description: SEARCH_DESCRIPTION,
        input: searchInput,
        execute: async (input, { sessionID, signal }) => {
          const session = await get({ sessionID });
          const result = await runSearch(
            searchOptions(input as SearchInput, {
              sessionID,
              directory: session.location.directory,
              database,
            }),
            signal,
          );
          return { content: JSON.stringify(result, null, 2) };
        },
      });

      editor.add({
        name: 'open_session',
        description: OPEN_DESCRIPTION,
        input: openInput,
        execute: async (input, { sessionID, signal }) => {
          const { session_id: targetID, close_source: closeSource = false } = input as {
            session_id: string;
            close_source?: boolean;
          };
          const source = await get({ sessionID });
          let target: Awaited<ReturnType<SessionGet>>;
          try {
            target = await get({ sessionID: targetID });
          } catch {
            throw new Error(`Session ${targetID} was not found.`);
          }
          const reason = rejectReason(source, target);
          if (reason) throw new Error(reason);

          const sourceSessionIDs = await ancestry(get, source);
          const targetSessionIDs = await ancestry(get, target);
          const requestID = randomUUID();
          const replied = waitForReply(requestID, REPLY_TIMEOUT_MS, signal);
          await rpc.events.emit('requested', {
            requestID,
            sourceSessionIDs,
            sessionID: target.id,
            rootSessionID: targetSessionIDs[targetSessionIDs.length - 1]!,
            root: !target.parentID,
            closeSource,
          });
          const action = await replied;
          if (!action) {
            throw new Error(
              `No terminal showing this session opened ${target.id}. ` +
                `Reopen it with \`opencode --session ${target.id}\`.`,
            );
          }
          const title = target.title ? `"${target.title}" (${target.id})` : target.id;
          return { content: `Opened ${title}: the terminal ${describe(action)}.` };
        },
      });
    });

    return async () => {
      await tools.dispose();
      await rpc.dispose();
    };
  },
} satisfies Plugin.Plugin;
