# opencode-tmux-indicator

An [OpenCode](https://opencode.ai) plugin that sets a tmux window option
(`@opencode-waiting`) when the agent is waiting for user input (permission prompt or question),
and clears it when the agent resumes.

## How it works

Sets `@opencode-waiting 1` on the current tmux window when the agent asks a permission or poses
a question, and unsets it when the agent goes back to work or becomes idle. A 3-second startup
grace period prevents false activations during plugin initialisation.

You can use the option in your tmux status line to show a visual indicator, e.g.:

```
set -g status-right "#{?@opencode-waiting, waiting,} #H"
```

The plugin is a no-op when `$TMUX` or `$TMUX_PANE` are not set.

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
