import type { Plugin } from '@opencode/plugin';
import { withoutNotices } from './notice';

export default {
  id: 'opencode-cache-coach',
  async setup(ctx) {
    for (const kind of ['context', 'generate', 'compaction', 'title'] as const)
      await ctx.session.hook(kind, (event) => {
        event.messages = withoutNotices(event.messages);
      });
  },
} satisfies Plugin.Plugin;
