# opencode-terminal-progress

An [OpenCode](https://opencode.ai) CLI plugin that shows agent progress in your terminal tab using
[OSC 9;4](https://iterm2.com/documentation-escape-codes.html) progress reporting.

Requires OpenCode 2. For OpenCode 1, install the `opencode-v1` dist-tag
(`npm install opencode-terminal-progress@opencode-v1`).

## Supported terminals

| Terminal                                                  | Detection                                                   |
| --------------------------------------------------------- | ----------------------------------------------------------- |
| [Ghostty](https://ghostty.org)                            | `TERM_PROGRAM=ghostty`                                      |
| [iTerm2](https://iterm2.com)                              | `TERM_PROGRAM=iTerm.app`, `LC_TERMINAL`, `ITERM_SESSION_ID` |
| [kitty](https://sw.kovidgoyal.net/kitty/)                 | `KITTY_WINDOW_ID`, `TERM_PROGRAM=kitty`                     |
| [WezTerm](https://wezfurlong.org/wezterm/)                | `TERM_PROGRAM=WezTerm`, `WEZTERM_EXECUTABLE`                |
| [Windows Terminal](https://github.com/microsoft/terminal) | `WT_SESSION`                                                |

The plugin automatically detects which terminal is in use and becomes a no-op if none of the above
are found. tmux passthrough is handled transparently when `$TMUX` is set.

kitty is supported on **0.47+**: kitty draws an in-window progress bar since 0.47 (see the
`progress_bar` option in `kitty.conf`), while 0.39-0.46 only showed a percentage in the tab title
and earlier versions treated OSC 9;4 as notifications. kitty does not set `TERM_PROGRAM`, so it is
detected via `KITTY_WINDOW_ID` (also inside tmux), unless another terminal nested in kitty has set
`TERM_PROGRAM`. The plugin stays inactive unless it can confirm the version is at least 0.47 by
running `kitty --version` on the running emulator (`/proc/<KITTY_PID>/exe`, Linux) or on the binary
in `KITTY_INSTALLATION_DIR` (Linux and macOS).

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
opencode plugin add opencode-terminal-progress
```

This adds the plugin to `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["opencode-terminal-progress"]
}
```

The plugin runs in the terminal interface, so it keeps working when the CLI connects to a remote
server.

## License

[MIT](../../LICENSE)
