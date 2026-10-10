// Contract between the server, which stores each session's targets and
// watches their PRs/MRs, and the CLI, which renders their status. Other
// plugins can call `target` and listen for `targetChanged` too.
//
// Status keys are session IDs, or "" for the checkout outside a session. A
// key is relative to the location the call or event names, because each
// checkout's server plugin instance watches its own sessions.
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
// A `Snapshot` from src/store.ts.
const snapshot = { type: 'object' } as const;
// `enabled` is false when the plugin's `reviewStatus` option is off.
const status = {
  type: 'object',
  properties: { enabled: { type: 'boolean' }, snapshot },
  required: ['enabled', 'snapshot'],
} as const;

export const ForgeSessionRpc = {
  id: 'opencode-forgekeeper',
  methods: {
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
        properties: { enabled: { type: 'boolean' }, statuses: { type: 'object' } },
        required: ['enabled', 'statuses'],
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
      output: { type: 'object' },
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

export type TargetUrls = { url: string; issueUrl?: string };
export type TargetOutput = { url?: string; issueUrl?: string; targets?: TargetUrls[] };
export type Notice = {
  sessionID?: string;
  title?: string;
  message: string;
  variant: 'info' | 'error';
};
