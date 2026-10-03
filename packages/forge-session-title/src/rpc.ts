const target = {
  type: 'object',
  properties: {
    url: { type: 'string' },
    issueUrl: { type: 'string' },
  },
  additionalProperties: false,
} as const;

export const ForgeSessionTitleRpc = {
  id: 'opencode-forge-session-title',
  methods: {
    target: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        required: ['sessionID'],
        additionalProperties: false,
      },
      output: target,
    },
  },
  events: {
    targetChanged: {
      schema: {
        type: 'object',
        properties: { sessionID: { type: 'string' }, ...target.properties },
        required: ['sessionID'],
        additionalProperties: false,
      },
    },
  },
} as const;

export type TargetOutput = { url?: string; issueUrl?: string };
