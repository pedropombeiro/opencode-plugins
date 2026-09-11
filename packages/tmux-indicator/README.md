# opencode-tmux-indicator

An [OpenCode](https://opencode.ai) plugin that sets a tmux window option
(`@opencode-waiting`) when the agent is waiting for user input (permission prompt or question),
and clears it when the agent resumes.

## How it works

Tracks waiting conversations separately and sets `@opencode-waiting 1` on their tmux window.
The flag stays set until every plugin instance in the window has cleared its waiting sessions.
A 3-second startup grace period delays indicators, preserving requests that remain pending.

The plugin also writes a BEL character to the pane TTY so tmux sets the
`window_bell_flag` on the window. This lets you jump to the next waiting window
with `Prefix + M-n` (`next-window -a`).

You can use the option in your tmux status line to show a visual indicator, e.g.:

```
set -g status-right "#{?@opencode-waiting, waiting,} #H"
```

The plugin is a no-op when `$TMUX` or `$TMUX_PANE` are not set.

## Navigate to a waiting conversation

Each plugin instance publishes a pane option named `@opencode-waiting-target-<instance ID>`.
Its value is an HTTP Unix socket path inside a private temporary directory. Use
`tmux show-options -p -t PANE` to discover the options, then read each value with
`tmux show-option -pqv -t PANE OPTION`.

The socket accepts two requests:

- `GET /waiting` returns a sorted JSON array of currently waiting OpenCode session IDs.
- `POST /select/SESSION_ID` displays a waiting session in the existing OpenCode TUI. It returns
  `true` when the SDK accepts the navigation event, HTTP 404 if the session is no longer waiting,
  or HTTP 502 if navigation fails.

The bridge publishes `tui.session.select` through the plugin's SDK client, preserving its
in-process transport and project directory. OpenCode does not need to expose a TCP port.
Session navigation requires an OpenCode version that supports that event.

Navigators should query each socket, cycle through individual sessions, and remove stale pane
options when the owning process has exited. A navigation response confirms event publication,
not that a TUI has finished rendering the selected conversation.

## Install a local build

Run `mise run install-local tmux-indicator` from the repository root to install a bundled copy
at `~/.config/opencode/plugins/tmux-indicator.js`. Remove the npm plugin entry from your
OpenCode configuration to avoid loading both copies, then restart OpenCode.

## Recommended tmux settings

The BEL trigger works with tmux's default `monitor-bell on` setting. To prevent
the bell from forwarding to your terminal emulator (which may play a sound or
flash), add these to your `tmux.conf`:

```tmux
set -gw window-status-bell-style default  # prevent the bell style from overriding your custom status format
set -g bell-action none                   # suppress BEL forwarding and messages; window_bell_flag is still set
```

## Prerequisites

[tmux](https://github.com/tmux/tmux) must be running and `$TMUX` / `$TMUX_PANE` set in the
environment where OpenCode is launched.

## Installation

```bash
npm install opencode-tmux-indicator
```

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-tmux-indicator"]
}
```

## License

[MIT](../../LICENSE)
