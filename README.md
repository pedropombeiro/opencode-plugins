# opencode-plugins

A collection of [OpenCode](https://opencode.ai) plugins.

## Plugins

| Plugin | Description | npm |
| ------ | ----------- | --- |
| [terminal-progress](packages/terminal-progress/) | Shows agent progress in terminal tabs (iTerm2, WezTerm, Windows Terminal) | [![npm](https://img.shields.io/npm/v/opencode-terminal-progress)](https://www.npmjs.com/package/opencode-terminal-progress) |
| [homeassistant](packages/homeassistant/) | Sends agent status to Home Assistant via webhooks | [![npm](https://img.shields.io/npm/v/opencode-homeassistant)](https://www.npmjs.com/package/opencode-homeassistant) |
| [forge-session-title](packages/forge-session-title/) | Prefixes session titles with forge issue/PR/MR references | [![npm](https://img.shields.io/npm/v/opencode-forge-session-title)](https://www.npmjs.com/package/opencode-forge-session-title) |
| [atuin-history](packages/atuin-history/) | Records agent bash commands in Atuin shell history | [![npm](https://img.shields.io/npm/v/opencode-atuin-history)](https://www.npmjs.com/package/opencode-atuin-history) |
| [tmux-indicator](packages/tmux-indicator/) | Sets a tmux window option when the agent is waiting for input | [![npm](https://img.shields.io/npm/v/opencode-tmux-indicator)](https://www.npmjs.com/package/opencode-tmux-indicator) |

## Development

This is a bun workspace monorepo. All tasks are run via [mise](https://mise.jdx.dev/):

```bash
mise run setup       # install dependencies
mise run build       # build all plugins
mise run lint        # lint with ESLint
mise run typecheck   # type-check all packages
mise run format      # format with Prettier
```

## License

[MIT](LICENSE)
