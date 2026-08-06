import { writeFileSync } from 'node:fs';
import type { Plugin } from '@opencode-ai/plugin';
import { createAgentStateTracker } from '../../_shared/src/index.ts';

export const TmuxIndicatorPlugin: Plugin = async ({ $ }) => {
  const tmux = process.env['TMUX'];
  if (!tmux) return {};

  const tmuxPane = process.env['TMUX_PANE'];
  if (!tmuxPane) return {};

  let windowId: string | undefined;
  let active = false;

  const getWindowId = async (): Promise<string> => {
    if (!windowId) {
      windowId = (
        await $`tmux display-message -t ${tmuxPane} -p '#{window_id}'`.quiet().text()
      ).trim();
    }
    return windowId;
  };

  const activate = async (): Promise<void> => {
    if (active || startupGrace) return;
    const wid = await getWindowId();
    await $`tmux set-option -w -t ${wid} @opencode-waiting 1`.quiet();
    const tty = (
      await $`tmux display-message -t ${tmuxPane} -p '#{pane_tty}'`.quiet().text()
    ).trim();
    if (tty) {
      try {
        writeFileSync(tty, '\x07');
      } catch {
        /* pane TTY may not be writable */
      }
    }
    active = true;
  };

  const deactivate = async (): Promise<void> => {
    if (!active) return;
    const wid = await getWindowId();
    await $`tmux set-option -w -u -t ${wid} @opencode-waiting`.nothrow().quiet();
    active = false;
  };

  let startupGrace = true;
  setTimeout(() => {
    startupGrace = false;
  }, 3000);

  const tracker = createAgentStateTracker({
    onWaiting: activate,
    onBusy: deactivate,
    onIdle: deactivate,
    onError: deactivate,
  });

  return {
    event: tracker.event,
    'tool.execute.before': tracker.toolExecuteBefore,
    'tool.execute.after': tracker.toolExecuteAfter,
  };
};
