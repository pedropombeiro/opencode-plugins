# opencode-atuin-history

An [OpenCode](https://opencode.ai) plugin that records shell commands run by the agent in
[Atuin](https://atuin.sh) shell history, attributed to a dedicated `opencode` author.

Requires OpenCode 2. For OpenCode 1, install the `v1` dist-tag
(`npm install opencode-atuin-history@v1`).

## How it works

- Sets `ATUIN_SESSION`, `ATUIN_HOST_NAME`, and `ATUIN_HISTORY_AUTHOR` in the shell environment so
  all agent-spawned shells share a consistent Atuin identity
- After each `shell` tool execution, calls `atuin history start` / `atuin history end` to record
  the command with its exit code and duration

Commands appear in your Atuin history tagged with `opencode@<hostname>`, making them easy to
filter or exclude.

## Prerequisites

[Atuin](https://atuin.sh) must be installed and on `$PATH`. If `atuin` can't run, the plugin does
nothing.

## Installation

```bash
opencode plugin add opencode-atuin-history
```

This adds the plugin to your `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["opencode-atuin-history"]
}
```

## License

[MIT](../../LICENSE)
