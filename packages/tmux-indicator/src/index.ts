import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Plugin } from '@opencode-ai/plugin';
import { createAgentStateTracker } from '../../_shared/src/index.ts';
import { createNavigation } from './navigation.ts';

export const TmuxIndicatorPlugin: Plugin = async ({ $, client, directory }) => {
  const tmux = process.env['TMUX'];
  if (!tmux) return {};

  const tmuxPane = process.env['TMUX_PANE'];
  if (!tmuxPane) return {};

  const waiting = new Set<string>();
  const navigation = await createNavigation(client, directory, waiting);
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
    const panes = (await $`tmux list-panes -t ${tmuxPane} -F '#{pane_id}'`.quiet().text())
      .trim()
      .split('\n');
    const options = await Promise.all(
      panes.map((pane) => $`tmux show-options -p -t ${pane}`.quiet().text()),
    );
    if (options.some((value) => /^@opencode-waiting-target-/m.test(value))) {
      await $`tmux set-option -w -t ${tmuxPane} @opencode-waiting 1`.quiet();
    } else {
      await $`tmux set-option -w -u -t ${tmuxPane} @opencode-waiting`.nothrow().quiet();
    }
  };

  const publish = async (): Promise<void> => {
    if (startupGrace || disposed) return;
    if (waiting.size) {
      await $`tmux set-option -p -t ${tmuxPane} ${option} ${navigation.socket}`.quiet();
    } else {
      await $`tmux set-option -p -u -t ${tmuxPane} ${option}`.nothrow().quiet();
    }
    await refreshWindow();
  };

  const ring = async (): Promise<void> => {
    const tty = (
      await $`tmux display-message -t ${tmuxPane} -p '#{pane_tty}'`.quiet().text()
    ).trim();
    if (tty) {
      try {
        writeFileSync(tty, '\x07');
      } catch {
        return;
      }
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

  return {
    event: (input) => enqueue(() => tracker.event(input)),
    'tool.execute.before': (input, output) =>
      enqueue(() => tracker.toolExecuteBefore(input, output)),
    'tool.execute.after': (input) => enqueue(() => tracker.toolExecuteAfter(input)),
    dispose: async () => {
      disposed = true;
      clearTimeout(timer);
      await pending;
      await navigation.close();
      await $`tmux set-option -p -u -t ${tmuxPane} ${option}`.nothrow().quiet();
      await refreshWindow();
    },
  };
};
