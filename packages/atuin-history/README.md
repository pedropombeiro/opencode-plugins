# opencode-atuin-history

An [OpenCode](https://opencode.ai) plugin that records bash commands run by the agent in
[Atuin](https://atuin.sh) shell history, attributed to a dedicated `opencode` author.

## How it works

- Sets `ATUIN_SESSION`, `ATUIN_HOST_NAME`, and `ATUIN_HISTORY_AUTHOR` in the shell environment so
  all agent-spawned shells share a consistent Atuin identity
- After each `bash` tool execution, calls `atuin history start` / `atuin history end` to record
  the command with its exit code and duration

Commands appear in your Atuin history tagged with `opencode@<hostname>`, making them easy to
filter or exclude.

## Prerequisites

[Atuin](https://atuin.sh) must be installed and on `$PATH`.

## Installation

```bash
npm install opencode-atuin-history
```

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-atuin-history"]
}
```

## License

[MIT](../../LICENSE)
