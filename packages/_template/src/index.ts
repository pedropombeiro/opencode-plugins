import type { Plugin } from '@opencode/plugin';

export default {
  id: 'PLUGIN-NAME',
  setup(ctx) {
    const controller = new AbortController();

    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        void event;
      }
    })();

    return () => controller.abort();
  },
} satisfies Plugin.Plugin;
