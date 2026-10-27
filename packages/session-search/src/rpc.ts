const requestSchema = {
  type: 'object',
  properties: {
    requestID: { type: 'string' },
    sourceSessionIDs: { type: 'array', items: { type: 'string' } },
    sessionID: { type: 'string' },
    rootSessionID: { type: 'string' },
    root: { type: 'boolean' },
    closeSource: { type: 'boolean' },
  },
  required: ['requestID', 'sourceSessionIDs', 'sessionID', 'rootSessionID', 'root', 'closeSource'],
  additionalProperties: false,
} as const;

const handledSchema = {
  type: 'object',
  properties: {
    requestID: { type: 'string' },
    action: { type: 'string', enum: ['tab', 'route'] },
  },
  required: ['requestID', 'action'],
  additionalProperties: false,
} as const;

const searchSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1 },
    sessionID: { type: 'string' },
    directory: { type: 'string' },
    limit: { type: 'integer', minimum: 1 },
  },
  required: ['query'],
  additionalProperties: false,
} as const;

export const SessionSearchRpc = {
  id: 'opencode-session-search',
  methods: {
    handled: { input: handledSchema, output: { type: 'object', additionalProperties: false } },
    search: { input: searchSchema, output: { type: 'object' } },
  },
  events: {
    requested: { schema: requestSchema },
  },
} as const;

export type OpenAction = 'tab' | 'route';

export interface OpenRequest {
  requestID: string;
  sourceSessionIDs: string[];
  sessionID: string;
  rootSessionID: string;
  root: boolean;
  closeSource: boolean;
}

export interface SearchRequest {
  query: string;
  sessionID?: string;
  directory?: string;
  limit?: number;
}
