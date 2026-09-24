import { closeSync, openSync, writeSync } from 'node:fs';
import type { Plugin } from '@opencode/plugin/tui';
import { createAgentStateTracker } from '../../_shared/src/index.ts';

type Terminal = 'iterm2' | 'wezterm' | 'windows-terminal' | 'ghostty';

function detectTerminal(): Terminal | undefined {
  const env = process.env;
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
  setup(context) {
    const progressEnv = process.env['OPENCODE_TERMINAL_PROGRESS'];
    if (progressEnv && /^(0|false|no)$/i.test(progressEnv)) return;
    if (!detectTerminal()) return;

    const osc = createOsc();
    if (!osc) return;

    const progress = (code: string): void => osc.write(`9;4;${code}`);

    const tracker = createAgentStateTracker({
      onWaiting: () => progress('4;50'),
      onBusy: () => progress('3'),
      onIdle: () => progress('0'),
      onError: () => progress('2'),
    });

    const stop = context.data.listen(({ details }) => {
      void tracker.handle(details);
    });

    return () => {
      stop();
      progress('0');
      osc.close();
    };
  },
} satisfies Plugin.Definition;
