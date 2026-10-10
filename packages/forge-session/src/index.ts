// Merges opencode-forge-session-title and forge-review-status. This server
// entry point owns each session's targets: the `set_session_target` tool, the
// agent guidance, and the title prefix. It also watches the PRs/MRs of the
// sessions that CLIs show and tells sessions about their reviews.
// opencode.json loads this directory through a path entry; OpenCode then loads
// tui.tsx, which renders the status that this entry point serves, in the CLI.
//
// The ID is opencode-forge-session-title's, so stored targets carry over.
import type { Plugin } from '@opencode/plugin';
import { exec, execWithTimeout } from './exec';
import { Forges, hostsFrom } from './forges';
import { CONCURRENCY, limitExec } from './limit';
import { createTitleLookups } from './lookups';
import { setupServer } from './server';

export default {
  id: 'opencode-forge-session-title',
  async setup(ctx) {
    const hosts = hostsFrom((ctx.options ?? {}) as Record<string, unknown>);
    // Status polling and feedback fetches share one limit across sessions,
    // and stop running commands once the plugin stops. Title lookups run on
    // their own, so a polling backlog can't delay set_session_target, which
    // waits for the source branch lookup and so also gives up sooner.
    const stopped = new AbortController();
    const statusExec = limitExec(exec, CONCURRENCY, stopped.signal);
    const cleanup = await setupServer(
      ctx,
      createTitleLookups(new Forges(exec, hosts), execWithTimeout(15_000)),
      {
        forges: new Forges(statusExec, hosts),
        exec: statusExec,
      },
    );
    return async () => {
      stopped.abort();
      await cleanup();
    };
  },
} satisfies Plugin.Plugin;
