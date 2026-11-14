# opencode-atuin-history

An [OpenCode](https://opencode.ai) plugin that records shell commands run by the agent in
[Atuin](https://atuin.sh) shell history, attributed to a dedicated `opencode` author.

Requires OpenCode 2. For OpenCode 1, install the `opencode-v1` dist-tag
(`npm install opencode-atuin-history@opencode-v1`).

## How it works

- Sets `ATUIN_SESSION`, `ATUIN_HOST_NAME`, and `ATUIN_HISTORY_AUTHOR` in the shell environment so
  all agent-spawned shells share a consistent Atuin identity
- After each `shell` tool execution, calls `atuin history start` / `atuin history end` to record
  the command with its exit code and duration
- Marks each entry as agent-run (`--author-kind agent`) and records the tool call's description,
  when OpenCode provides one, as the entry's intent

When the shell tool reports no exit code, the plugin records `124` for a command stopped by its
timeout, `128` plus the signal number for a command stopped by a signal, and `1` otherwise. A
command moved to the background is recorded without an exit code or duration, because it hasn't
finished.

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
