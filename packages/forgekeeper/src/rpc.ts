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
import type { CleanupResult, CleanupScanResult } from './session-cleanup';

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
// `enabled` is false when the plugin's `status` option is off.
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
    markFeedbackRead: {
      input: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'string' }, maxItems: 500 } },
        required: ['ids'],
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
    actOnFeedback: {
      input: {
        type: 'object',
        properties: { id: { type: 'string' }, retry: { type: 'boolean' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: inboxState,
    },
    // The session's explicit targets, or `{}` when none are set.
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
    cleanupCandidates: {
      input: {
        type: 'object',
        properties: { scanID: { type: 'string' } },
        additionalProperties: false,
      },
      output: { type: 'object', title: 'CleanupScanResult' },
    },
    cleanupSessions: {
      input: {
        type: 'object',
        properties: {
          scanID: { type: 'string' },
          allowClientArchive: { type: 'boolean' },
          finalizeArchived: { type: 'boolean' },
          sessionIDs: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 500,
          },
        },
        required: ['sessionIDs'],
        additionalProperties: false,
      },
      output: { type: 'object', title: 'CleanupResult' },
    },
  },
  events: {
    cleanupProgress: {
      schema: {
        type: 'object',
        properties: {
          scanID: { type: 'string' },
          phase: { type: 'string', enum: ['sessions', 'targets', 'verifying', 'archiving'] },
          checked: { type: 'number' },
          total: { type: 'number' },
        },
        required: ['phase', 'checked', 'total'],
        additionalProperties: false,
      },
    },
    sessionsCleanedUp: {
      schema: {
        type: 'object',
        properties: {
          sessionIDs: { type: 'array', items: { type: 'string' } },
          archive: { type: 'boolean' },
        },
        required: ['sessionIDs'],
        additionalProperties: false,
      },
    },
    feedbackChanged: {
      schema: {
        type: 'object',
        properties: { directory: { type: 'string' } },
        required: ['directory'],
        additionalProperties: false,
      },
    },
    // Fires after targets change. Has only `sessionID` when none are set.
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
          openTab: { type: 'boolean' },
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
      { pattern: { type: 'object'; title: 'CleanupScanResult' }; output: CleanupScanResult },
      { pattern: { type: 'object'; title: 'CleanupResult' }; output: CleanupResult },
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
export type CleanupProgress = EventData<'cleanupProgress'>;

export interface HandlerContext {
  readonly signal?: AbortSignal;
}

export type Handlers = {
  [M in MethodName]: (input: Input<M>, context?: HandlerContext) => Promise<Output<M>>;
};

// OpenCode checks each call against the schemas before it reaches a handler,
// and types the input as `unknown`. This is the one place that narrows it.
export const implement = (handlers: Handlers) => ({
  monitoringStatus: (input: unknown, context?: HandlerContext) =>
    handlers.monitoringStatus(input as Input<'monitoringStatus'>, context),
  feedback: (_input?: unknown, context?: HandlerContext) => handlers.feedback({}, context),
  markFeedbackRead: (input: unknown, context?: HandlerContext) =>
    handlers.markFeedbackRead(input as Input<'markFeedbackRead'>, context),
  acknowledgeFeedback: (input: unknown, context?: HandlerContext) =>
    handlers.acknowledgeFeedback(input as Input<'acknowledgeFeedback'>, context),
  summarizeFeedback: (input: unknown, context?: HandlerContext) =>
    handlers.summarizeFeedback(input as Input<'summarizeFeedback'>, context),
  actOnFeedback: (input: unknown, context?: HandlerContext) =>
    handlers.actOnFeedback(input as Input<'actOnFeedback'>, context),
  pauseFeedback: (input: unknown, context?: HandlerContext) =>
    handlers.pauseFeedback(input as Input<'pauseFeedback'>, context),
  target: (input: unknown, context?: HandlerContext) =>
    handlers.target(input as Input<'target'>, context),
  watch: (input: unknown, context?: HandlerContext) =>
    handlers.watch(input as Input<'watch'>, context),
  release: (input: unknown, context?: HandlerContext) =>
    handlers.release(input as Input<'release'>, context),
  refresh: (input: unknown, context?: HandlerContext) =>
    handlers.refresh(input as Input<'refresh'>, context),
  cleanupCandidates: (input: unknown, context?: HandlerContext) =>
    handlers.cleanupCandidates((input ?? {}) as Input<'cleanupCandidates'>, context),
  cleanupSessions: (input: unknown, context?: HandlerContext) =>
    handlers.cleanupSessions(input as Input<'cleanupSessions'>, context),
});
