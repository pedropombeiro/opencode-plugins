# opencode-tmux-indicator

An [OpenCode](https://opencode.ai) plugin that sets a tmux window option
(`@opencode-waiting`) when the agent is waiting for user input (permission prompt or question),
and clears it when the agent resumes.

## How it works

Sets `@opencode-waiting 1` on the current tmux window when the agent asks a permission or poses
a question, and unsets it when the agent goes back to work or becomes idle. A 3-second startup
grace period prevents false activations during plugin initialisation.

The plugin also writes a BEL character to the pane TTY so tmux sets the
`window_bell_flag` on the window. This lets you jump to the next waiting window
with `Prefix + M-n` (`next-window -a`).

You can use the option in your tmux status line to show a visual indicator, e.g.:

```
set -g status-right "#{?@opencode-waiting, waiting,} #H"
```

The plugin is a no-op when `$TMUX` or `$TMUX_PANE` are not set.

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
