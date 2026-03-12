import type { Plugin } from '@opencode-ai/plugin';

export const MyPlugin: Plugin = async () => {
  return {
    event: async ({ event }) => {
      void event;
    },
  };
};
