export const HomeAssistantRpc = {
  id: 'opencode-homeassistant',
  methods: {},
  events: {
    answer: {
      schema: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          formID: { type: 'string' },
          answer: { type: 'object' },
        },
        required: ['sessionID', 'formID', 'answer'],
        additionalProperties: false,
      },
    },
  },
} as const;

export interface AnswerEvent {
  sessionID: string;
  formID: string;
  answer: Record<string, string | string[]>;
}
