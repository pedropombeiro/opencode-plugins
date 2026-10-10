import { closeSync, openSync, writeSync } from 'node:fs';
import type { Plugin } from '@opencode/plugin/tui';
import { createAgentStateTracker, createViewFilter } from '../../_shared/src/index.ts';
import { detectKitty, isKittyHost } from './kitty.ts';

type Terminal = 'iterm2' | 'wezterm' | 'windows-terminal' | 'ghostty' | 'kitty';

async function detectTerminal(): Promise<Terminal | undefined> {
  const env = process.env;
  if (isKittyHost(env)) {
    return (await detectKitty(env)) ? 'kitty' : undefined;
  }
  if (env['TERM_PROGRAM'] === 'ghostty') {
    return 'ghostty';
  }
  if (
    env['TERM_PROGRAM'] === 'iTerm.app' ||
    env['LC_TERMINAL'] === 'iTerm2' ||
    env['ITERM_SESSION_ID']
  ) {
    return 'iterm2';
  }
  if (env['TERM_PROGRAM'] === 'WezTerm' || env['WEZTERM_EXECUTABLE']) {
    return 'wezterm';
  }
  if (env['WT_SESSION']) {
    return 'windows-terminal';
  }
  return undefined;
}

interface Osc {
  write(payload: string): void;
  close(): void;
}

function createOsc(): Osc | undefined {
  const inTmux = !!process.env['TMUX'];
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'w');
  } catch {
    return undefined;
  }
  return {
    write(payload) {
      const esc = inTmux ? `\x1bPtmux;\x1b\x1b]${payload}\x07\x1b\\` : `\x1b]${payload}\x07`;
      try {
        writeSync(fd, esc);
      } catch {
        return;
      }
    },
    close() {
      try {
        closeSync(fd);
      } catch {
        return;
      }
    },
  };
}

export default {
  id: 'opencode-terminal-progress',
  async setup(context) {
    const progressEnv = process.env['OPENCODE_TERMINAL_PROGRESS'];
    if (progressEnv && /^(0|false|no)$/i.test(progressEnv)) return;
    const terminal = await detectTerminal();
    if (!terminal) return;

    const osc = createOsc();
    if (!osc) return;

    const progress = (code: string): void => osc.write(`9;4;${code}`);
    const isKitty = terminal === 'kitty';

    let stateTimer: ReturnType<typeof setInterval> | undefined;
    const clearStateTimer = (): void => {
      if (stateTimer) {
        clearInterval(stateTimer);
        stateTimer = undefined;
      }
    };

    const setState = (code: string): void => {
      clearStateTimer();
      progress(code);
      // kitty clears any progress ~60 s after the last OSC 9;4 report, so while a
      // state is active we re-report it periodically to keep the indicator alive.
      // Other terminals keep the progress state until told otherwise.
      if (isKitty) {
        stateTimer = setInterval(() => progress(code), 30_000);
      }
    };

    const tracker = createAgentStateTracker({
      onWaiting: () => setState('4;50'),
      onBusy: () => setState('3'),
      onIdle: () => {
        clearStateTimer();
        progress('0');
      },
      onError: () => setState('2'),
    });

    const shows = createViewFilter(context, tracker.tracks);
    const stop = context.data.listen(({ details }) => {
      if (shows(details)) void tracker.handle(details);
    });

    return () => {
      stop();
      clearStateTimer();
      progress('0');
      osc.close();
    };
  },
} satisfies Plugin.Definition;
