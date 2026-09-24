import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Plugin } from '@opencode/plugin/tui';
import { createAgentStateTracker, exec, type OpenCodeEvent } from '../../_shared/src/v2.ts';
import { createNavigation } from './navigation.ts';

async function tmux(...args: string[]): Promise<string> {
  const result = await exec('tmux', args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

export default {
  id: 'opencode-tmux-indicator',
  async setup(context) {
    if (!process.env['TMUX']) return;
    const tmuxPane = process.env['TMUX_PANE'];
    if (!tmuxPane) return;

    const waiting = new Set<string>();
    const navigation = await createNavigation((sessionID) => {
      if (context.ui.tabs.enabled() && context.ui.tabs.focus(sessionID)) return true;
      context.ui.router.navigate({ type: 'session', sessionID });
      return true;
    }, waiting);
    const option = `@opencode-waiting-target-${randomUUID()}`;
    let startupGrace = true;
    let disposed = false;
    let pending = Promise.resolve();

    const enqueue = (action: () => Promise<void>): Promise<void> => {
      const next = pending.then(action);
      pending = next.catch(() => {});
      return next;
    };

    const refreshWindow = async (): Promise<void> => {
      const panes = (await tmux('list-panes', '-t', tmuxPane, '-F', '#{pane_id}'))
        .trim()
        .split('\n');
      const options = await Promise.all(
        panes.map((pane) => tmux('show-options', '-p', '-t', pane)),
      );
      if (options.some((value) => /^@opencode-waiting-target-/m.test(value))) {
        await tmux('set-option', '-w', '-t', tmuxPane, '@opencode-waiting', '1');
      } else {
        await exec('tmux', ['set-option', '-w', '-u', '-t', tmuxPane, '@opencode-waiting']);
      }
    };

    const publish = async (): Promise<void> => {
      if (startupGrace || disposed) return;
      if (waiting.size) {
        await tmux('set-option', '-p', '-t', tmuxPane, option, navigation.socket);
      } else {
        await exec('tmux', ['set-option', '-p', '-u', '-t', tmuxPane, option]);
      }
      await refreshWindow();
    };

    const ring = async (): Promise<void> => {
      const tty = (await tmux('display-message', '-t', tmuxPane, '-p', '#{pane_tty}')).trim();
      if (!tty) return;
      try {
        writeFileSync(tty, '\x07');
      } catch {
        return;
      }
    };

    const activate = async (sessionID: string): Promise<void> => {
      waiting.add(sessionID);
      await publish();
      if (!startupGrace && !disposed) await ring();
    };

    const deactivate = async (sessionID: string): Promise<void> => {
      if (waiting.delete(sessionID)) await publish();
    };

    const timer = setTimeout(() => {
      void enqueue(async () => {
        startupGrace = false;
        if (!waiting.size || disposed) return;
        await publish();
        await ring();
      }).catch(() => {});
    }, 3000);
    timer.unref();

    const tracker = createAgentStateTracker({
      onWaiting: activate,
      onBusy: deactivate,
      onIdle: deactivate,
      onError: deactivate,
    });

    const handle = (event: OpenCodeEvent) => enqueue(() => tracker.handle(event));
    const stop = context.data.listen(({ details }) => {
      void handle(details).catch(() => {});
    });

    return async () => {
      stop();
      disposed = true;
      clearTimeout(timer);
      await pending;
      await navigation.close();
      await exec('tmux', ['set-option', '-p', '-u', '-t', tmuxPane, option]);
      await refreshWindow().catch(() => {});
    };
  },
} satisfies Plugin.Definition;
