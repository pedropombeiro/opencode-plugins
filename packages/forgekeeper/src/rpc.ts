// Contract between the server, which stores each session's targets and
// watches their PRs/MRs, and the CLI, which renders their status. Other
// plugins can call `target` and listen for `targetChanged` too.
//
// Status keys are session IDs, or "" for the checkout outside a session. A
// key is relative to the location the call or event names, because each
// checkout's server plugin instance watches its own sessions.
//
// The schemas are plain JSON Schema, so OpenCode types their values as
// `unknown`. The types at the bottom of this file derive from them instead,
// so the schemas stay the single description of what crosses the RPC.
import type { FromSchema, JSONSchema } from 'json-schema-to-ts';
import type { Snapshot } from './store';
import type { InboxState } from './feedback-inbox';
import type { MonitoringStatus } from './monitoring-status';

const urls = {
  url: { type: 'string' },
  issueUrl: { type: 'string' },
} as const;

// `url` and `issueUrl` describe the first target, for callers that expect a
// single target. `targets` lists every target in order.
const target = {
  type: 'object',
  properties: {
    ...urls,
    targets: {
      type: 'array',
      items: { type: 'object', properties: urls, required: ['url'], additionalProperties: false },
    },
  },
  additionalProperties: false,
} as const;

const key = { type: 'string' } as const;
// A `Snapshot` from src/store.ts. Its title lets `Deserialize` map it to that
// type, so the schema doesn't repeat the lookup's shape.
const snapshot = { type: 'object', title: 'Snapshot' } as const;
const inboxState = { type: 'object', title: 'InboxState' } as const;
// `enabled` is false when the plugin's `reviewStatus` option is off.
const status = {
  type: 'object',
  properties: { enabled: { type: 'boolean' }, snapshot },
  required: ['enabled', 'snapshot'],
  additionalProperties: false,
} as const;

export const ForgeSessionRpc = {
  id: 'opencode-forgekeeper',
  methods: {
    monitoringStatus: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        required: ['sessionID'],
        additionalProperties: false,
      },
      output: { type: 'object', title: 'MonitoringStatus' },
    },
    feedback: {
      input: { type: 'object', additionalProperties: false },
      output: inboxState,
    },
    acknowledgeFeedback: {
      input: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: inboxState,
    },
    // Starts a tool-free summary turn for an update in its session.
    summarizeFeedback: {
      input: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: inboxState,
    },
    pauseFeedback: {
      input: {
        type: 'object',
        properties: { paused: { type: 'boolean' } },
        required: ['paused'],
        additionalProperties: false,
      },
      output: inboxState,
    },
    // The session's explicit targets, or `{}` in automatic branch mode.
    target: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        required: ['sessionID'],
        additionalProperties: false,
      },
      output: target,
    },
    // Renews the CLI's leases on the keys it has shown, and returns their
    // snapshots. `visible` is the key on screen, which polls even without
    // reviews to watch. Keys the CLI no longer lists lose its lease.
    watch: {
      input: {
        type: 'object',
        properties: {
          clientID: { type: 'string' },
          keys: { type: 'array', items: key },
          visible: key,
        },
        required: ['clientID', 'keys'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          statuses: { type: 'object', additionalProperties: snapshot },
        },
        required: ['enabled', 'statuses'],
        additionalProperties: false,
      },
    },
    // Drops every lease the CLI holds, when it exits.
    release: {
      input: {
        type: 'object',
        properties: { clientID: { type: 'string' } },
        required: ['clientID'],
        additionalProperties: false,
      },
      output: { type: 'object', additionalProperties: false },
    },
    // Looks the key up now and returns the result.
    refresh: {
      input: {
        type: 'object',
        properties: { key },
        required: ['key'],
        additionalProperties: false,
      },
      output: status,
    },
  },
  events: {
    feedbackChanged: {
      schema: {
        type: 'object',
        properties: { directory: { type: 'string' } },
        required: ['directory'],
        additionalProperties: false,
      },
    },
    // Fires after set_session_target runs. Has only `sessionID` in branch mode.
    targetChanged: {
      schema: {
        type: 'object',
        properties: { sessionID: { type: 'string' }, ...target.properties },
        required: ['sessionID'],
        additionalProperties: false,
      },
    },
    // A key's snapshot changed.
    status: {
      schema: {
        type: 'object',
        properties: { directory: { type: 'string' }, key, snapshot },
        required: ['directory', 'key', 'snapshot'],
        additionalProperties: false,
      },
    },
    // A toast for the CLIs, such as after telling a session about a review.
    // Without `sessionID`, it concerns no session in particular.
    notice: {
      schema: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          title: { type: 'string' },
          message: { type: 'string' },
          variant: { type: 'string', enum: ['info', 'error'] },
        },
        required: ['message', 'variant'],
        additionalProperties: false,
      },
    },
  },
} as const;

// The status key for the checkout outside a session, such as on the home screen.
export const HOME = '';
// A CLI renews the leases of the keys it has shown this often, and a lease
// that isn't renewed ends after LEASE_TIME, such as after the CLI exits.
export const HEARTBEAT = 60_000;
export const LEASE_TIME = 3 * HEARTBEAT;

type Methods = typeof ForgeSessionRpc.methods;
type Events = typeof ForgeSessionRpc.events;
type Typed<S extends JSONSchema> = FromSchema<
  S,
  {
    deserialize: [
      { pattern: { type: 'object'; title: 'Snapshot' }; output: Snapshot },
      { pattern: { type: 'object'; title: 'InboxState' }; output: InboxState },
      { pattern: { type: 'object'; title: 'MonitoringStatus' }; output: MonitoringStatus },
    ];
  }
>;

export type MethodName = keyof Methods;
export type EventName = keyof Events;
export type Input<M extends MethodName> = Typed<Methods[M]['input']>;
export type Output<M extends MethodName> = Typed<Methods[M]['output']>;
export type EventData<E extends EventName> = Typed<Events[E]['schema']>;

export type TargetOutput = Output<'target'>;
export type TargetUrls = NonNullable<TargetOutput['targets']>[number];
export type Notice = EventData<'notice'>;

export type Handlers = { [M in MethodName]: (input: Input<M>) => Promise<Output<M>> };

// OpenCode checks each call against the schemas before it reaches a handler,
// and types the input as `unknown`. This is the one place that narrows it.
export const implement = (handlers: Handlers) => ({
  monitoringStatus: (input: unknown) =>
    handlers.monitoringStatus(input as Input<'monitoringStatus'>),
  feedback: () => handlers.feedback({}),
  acknowledgeFeedback: (input: unknown) =>
    handlers.acknowledgeFeedback(input as Input<'acknowledgeFeedback'>),
  summarizeFeedback: (input: unknown) =>
    handlers.summarizeFeedback(input as Input<'summarizeFeedback'>),
  pauseFeedback: (input: unknown) => handlers.pauseFeedback(input as Input<'pauseFeedback'>),
  target: (input: unknown) => handlers.target(input as Input<'target'>),
  watch: (input: unknown) => handlers.watch(input as Input<'watch'>),
  release: (input: unknown) => handlers.release(input as Input<'release'>),
  refresh: (input: unknown) => handlers.refresh(input as Input<'refresh'>),
});
