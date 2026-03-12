import { openSync, writeSync } from 'fs';
import type { Plugin } from '@opencode-ai/plugin';
import type { EventSessionStatus } from '@opencode-ai/sdk';

type Terminal = 'iterm2' | 'wezterm' | 'windows-terminal';

function detectTerminal(): Terminal | undefined {
  const env = process.env;
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

function createOsc(): ((payload: string) => void) | undefined {
  const inTmux = !!process.env['TMUX'];
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'w');
  } catch {
    return undefined;
  }
  return (payload: string) => {
    const esc = inTmux ? `\x1bPtmux;\x1b\x1b]${payload}\x07\x1b\\` : `\x1b]${payload}\x07`;
    writeSync(fd, esc);
  };
}

export const TerminalProgressPlugin: Plugin = async () => {
  const progressEnv = process.env['OPENCODE_TERMINAL_PROGRESS'];
  if (progressEnv && /^(0|false|no)$/i.test(progressEnv)) return {};
  if (!detectTerminal()) return {};

  const maybeOsc = createOsc();
  if (!maybeOsc) return {};
  const osc = maybeOsc;

  let waitingForInput = false;

  function progress(code: string): void {
    osc(`9;4;${code}`);
  }

  function pause(): void {
    waitingForInput = true;
    progress('4;50');
  }

  function resume(): void {
    waitingForInput = false;
  }

  function showBusy(): void {
    if (waitingForInput) return;
    progress('3');
  }

  return {
    event: async ({ event }) => {
      switch (event.type as string) {
        case 'session.status': {
          const { status } = (event as EventSessionStatus).properties;
          switch (status.type) {
            case 'busy':
              showBusy();
              break;
            case 'idle':
              resume();
              progress('0');
              break;
          }
          break;
        }
        case 'session.idle':
          resume();
          progress('0');
          break;
        case 'session.error':
          resume();
          progress('2');
          break;
        case 'permission.asked':
          pause();
          break;
        case 'permission.replied':
          resume();
          showBusy();
          break;
      }
    },
    'permission.ask': async () => {
      pause();
    },
    'tool.execute.before': async (input) => {
      if (input.tool === 'question') {
        pause();
      }
    },
  };
};
