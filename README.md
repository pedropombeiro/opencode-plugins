# opencode-plugins

A collection of [OpenCode](https://opencode.ai) plugins.

The plugins target OpenCode 2. The last OpenCode 1 versions live on the
[`v1` branch](https://github.com/pedropombeiro/opencode-plugins/tree/v1) and install from the npm
`v1` dist-tag, for example `npm install opencode-homeassistant@v1`.

## Plugins

| Plugin | Description | npm |
| ------ | ----------- | --- |
| [terminal-progress](packages/terminal-progress/) | Shows agent progress in terminal tabs (Ghostty, iTerm2, WezTerm, Windows Terminal) | [![npm](https://img.shields.io/npm/v/opencode-terminal-progress)](https://www.npmjs.com/package/opencode-terminal-progress) |
| [homeassistant](packages/homeassistant/) | Sends agent status to Home Assistant via webhooks | [![npm](https://img.shields.io/npm/v/opencode-homeassistant)](https://www.npmjs.com/package/opencode-homeassistant) |
| [forge-session-title](packages/forge-session-title/) | Prefixes session titles with forge issue/PR/MR references | [![npm](https://img.shields.io/npm/v/opencode-forge-session-title)](https://www.npmjs.com/package/opencode-forge-session-title) |
| [atuin-history](packages/atuin-history/) | Records agent shell commands in Atuin shell history | [![npm](https://img.shields.io/npm/v/opencode-atuin-history)](https://www.npmjs.com/package/opencode-atuin-history) |
| [tmux-indicator](packages/tmux-indicator/) | Sets a tmux window option when the agent is waiting for input | [![npm](https://img.shields.io/npm/v/opencode-tmux-indicator)](https://www.npmjs.com/package/opencode-tmux-indicator) |

## Development

This is a bun workspace monorepo. All tasks are run via [mise](https://mise.jdx.dev/):

```bash
mise run setup       # install dependencies
mise run build       # build all plugins
mise run lint        # lint with ESLint
mise run typecheck   # type-check all packages
mise run test        # run all tests
mise run format      # format with Prettier
```

## License

[MIT](LICENSE)
