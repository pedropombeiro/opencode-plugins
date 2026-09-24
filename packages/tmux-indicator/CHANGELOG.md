# Changelog

## [1.0.1](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-tmux-indicator-1.0.0...opencode-tmux-indicator-1.0.1) (2026-09-24)


### Bug Fixes

* **docs:** point OpenCode 1 users to the opencode-v1 dist-tag ([dcaacb7](https://github.com/pedropombeiro/opencode-plugins/commit/dcaacb780dc151fbbfaaf3452a680afe956d58f1))

## [1.0.0](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-tmux-indicator-0.5.0...opencode-tmux-indicator-1.0.0) (2026-09-24)


### ⚠ BREAKING CHANGES

* **tmux-indicator:** Requires OpenCode 2 and loads through `cli.json`. OpenCode 1 users should install the `v1` dist-tag.

### Features

* **tmux-indicator:** port to the OpenCode 2 CLI plugin API ([05388c9](https://github.com/pedropombeiro/opencode-plugins/commit/05388c9a535fd12597ac881710269dedfd1e3d78))

## [0.5.0](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-tmux-indicator-0.4.1...opencode-tmux-indicator-0.5.0) (2026-09-11)


### Features

* **tmux-indicator:** navigate to waiting conversations ([cfd84a4](https://github.com/pedropombeiro/opencode-plugins/commit/cfd84a48e0cf6e0458f343c28bb59cc54c0a34cc))

## [0.4.1](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-tmux-indicator-0.4.0...opencode-tmux-indicator-0.4.1) (2026-08-07)

### Bug Fixes

- clear stale waiting state in terminal plugins ([#44](https://github.com/pedropombeiro/opencode-plugins/issues/44)) ([8b968db](https://github.com/pedropombeiro/opencode-plugins/commit/8b968db066f6d3e99891ee60dca5bf62c05adde2))

## [0.4.0](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-tmux-indicator-0.3.1...opencode-tmux-indicator-0.4.0) (2026-03-18)

### Features

- **terminal-progress:** add Ghostty terminal detection ([4e6c499](https://github.com/pedropombeiro/opencode-plugins/commit/4e6c499b1e8fd9d5ae74096d1564a24c0ee34555))

## [0.3.1](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-tmux-indicator-0.3.0...opencode-tmux-indicator-0.3.1) (2026-03-18)

### Bug Fixes

- **tmux-indicator:** use writeFileSync for BEL and document tmux settings ([f79c7b2](https://github.com/pedropombeiro/opencode-plugins/commit/f79c7b2a591e26af3ee5125df3beccd606e5dd06))

## [0.3.0](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-tmux-indicator-0.2.1...opencode-tmux-indicator-0.3.0) (2026-03-18)

### Features

- **tmux-indicator:** send BEL to pane TTY to set tmux window_bell_flag ([13d22e5](https://github.com/pedropombeiro/opencode-plugins/commit/13d22e5087c051d20690dd59a20e32bb7417b3fd))

## [0.2.1](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-tmux-indicator-0.2.0...opencode-tmux-indicator-0.2.1) (2026-03-14)

### Bug Fixes

- **tmux-indicator:** stop ringing bell on waiting ([5578704](https://github.com/pedropombeiro/opencode-plugins/commit/55787043144a364783e7c81137577e46c2ddbe39))

## [0.2.0](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-tmux-indicator-0.1.0...opencode-tmux-indicator-0.2.0) (2026-03-14)

### Features

- **tmux-indicator:** ring BEL on pane TTY when waiting for input ([056182a](https://github.com/pedropombeiro/opencode-plugins/commit/056182a450a6b2718ad1e8e65b82d017cc1dbb9c))

### Bug Fixes

- **forge-session-title:** update repository URL to monorepo ([1d2ef1d](https://github.com/pedropombeiro/opencode-plugins/commit/1d2ef1df11373d14797b6bfa002fbdff48197078))
- **homeassistant:** update repository URL to monorepo ([e0bd582](https://github.com/pedropombeiro/opencode-plugins/commit/e0bd582263126b4211dd17595475d40eaf270f02))
- **terminal-progress:** update repository URL to monorepo ([6d72ed2](https://github.com/pedropombeiro/opencode-plugins/commit/6d72ed2572f051feb3ec6e9c253239f845785635))
