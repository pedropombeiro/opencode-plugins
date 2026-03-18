# opencode-terminal-progress

An [OpenCode](https://opencode.ai) plugin that shows agent progress in your terminal tab using
[OSC 9;4](https://iterm2.com/documentation-escape-codes.html) progress reporting.

## Supported terminals

| Terminal                                                  | Detection                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| [Ghostty](https://ghostty.org)                            | `TERM_PROGRAM=ghostty`                                      |
| [iTerm2](https://iterm2.com)                              | `TERM_PROGRAM=iTerm.app`, `LC_TERMINAL`, `ITERM_SESSION_ID` |
| [WezTerm](https://wezfurlong.org/wezterm/)                | `TERM_PROGRAM=WezTerm`, `WEZTERM_EXECUTABLE`                |
| [Windows Terminal](https://github.com/microsoft/terminal) | `WT_SESSION`                                                |

The plugin automatically detects which terminal is in use and becomes a no-op if none of the above
are found. tmux passthrough is handled transparently when `$TMUX` is set.

Set `OPENCODE_TERMINAL_PROGRESS=0` (or `false`/`no`) to disable progress reporting.

## Progress states

| Agent state       | Progress indicator |
| ----------------- | ------------------ |
| Busy              | Indeterminate      |
| Idle              | Cleared            |
| Error             | Error (red)        |
| Waiting for input | Paused at 50%      |

## Installation

```bash
npm install opencode-terminal-progress
```

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-terminal-progress"]
}
```

## License

[MIT](../../LICENSE)
