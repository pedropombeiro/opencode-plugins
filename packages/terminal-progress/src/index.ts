import { openSync, writeSync } from 'fs';
import type { Plugin } from '@opencode-ai/plugin';
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

  function progress(code: string): void {
    osc(`9;4;${code}`);
  }

  function pause(): void {
    progress('4;50');
  }

  function showBusy(): void {
    progress('3');
  }

  const tracker = createAgentStateTracker({
    onWaiting: pause,
    onBusy: showBusy,
    onIdle: () => progress('0'),
    onError: () => progress('2'),
  });

  return {
    event: tracker.event,
    'tool.execute.before': tracker.toolExecuteBefore,
    'tool.execute.after': tracker.toolExecuteAfter,
  };
};
