// What the terminal and desktop parts share: the status client that leases
// the shown sessions, its heartbeat, and the RPC events that reach it.
import type { InboxState } from './feedback-inbox';
import { HEARTBEAT, type EventData, type Output } from './rpc';
import { createStatusClient, type StatusClient } from './status-client';

type Location = { location: { directory: string } };
type Call = (input: never, options: Location) => Promise<unknown>;

// The parts of `client.rpc(ForgeSessionRpc)` the clients use. OpenCode types
// results as `unknown`; the server returns what the schemas in rpc.ts describe.
export interface ForgeRpcClient {
  watch: Call;
  refresh: Call;
  release: Call;
  feedback: Call;
  events: {
    on: (
      name: 'status' | 'notice' | 'feedbackChanged',
      listener: (event: { data: unknown; location?: { directory?: string } }) => void,
    ) => () => void;
  };
}

const at = (directory: string): Location => ({ location: { directory } });

export const loadFeedback = async (rpc: ForgeRpcClient, directory: string) =>
  (await (rpc.feedback as (input: object, options: Location) => Promise<unknown>)(
    {},
    at(directory),
  )) as InboxState;

export interface ForgeConnection {
  client: StatusClient;
  dispose: () => void;
}

// Connects a status client to the RPC. `onChange` runs after any snapshot or
// setting changes; `heartbeat` runs with each lease renewal, such as to reload
// the inbox.
export function connectStatus(
  rpc: ForgeRpcClient,
  options: { clientID: string; onChange: () => void; heartbeat?: () => void },
): ForgeConnection {
  const call = rpc as unknown as Record<
    'watch' | 'refresh' | 'release',
    (input: object, options: Location) => Promise<unknown>
  >;
  const client = createStatusClient({
    clientID: options.clientID,
    watch: async (directory, input) => (await call.watch(input, at(directory))) as Output<'watch'>,
    refresh: async (directory, key) =>
      (await call.refresh({ key }, at(directory))) as Output<'refresh'>,
    release: (directory, clientID) => call.release({ clientID }, at(directory)),
    onChange: options.onChange,
  });
  const timer = setInterval(() => {
    client.heartbeat();
    options.heartbeat?.();
  }, HEARTBEAT);
  const stop = rpc.events.on('status', (event) => {
    const { directory, key, snapshot } = event.data as EventData<'status'>;
    client.receive(directory, key, snapshot);
  });
  return {
    client,
    dispose() {
      clearInterval(timer);
      stop();
      client.dispose();
    },
  };
}

// A client ID for leases. `crypto.randomUUID` needs a secure context, which a
// browser on a plain-HTTP address lacks.
export const clientID = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
