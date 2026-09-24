import type { Plugin } from '@opencode/plugin/tui';
import { HomeAssistantRpc, type AnswerEvent } from './rpc.ts';

export default {
  id: 'opencode-homeassistant-cli',
  setup(context) {
    const homeAssistant = context.client.rpc(HomeAssistantRpc);
    return homeAssistant.events.on('answer', (event) => {
      const { sessionID, formID, answer } = event.data as unknown as AnswerEvent;
      void context.data.session.form
        .reply({ sessionID, formID, answer }, event.location)
        .catch(() => {});
    });
  },
} satisfies Plugin.Definition;
