# Changelog

## [0.4.2](https://github.com/pedropombeiro/opencode-terminal-progress/compare/opencode-terminal-progress-v0.4.1...opencode-terminal-progress-v0.4.2) (2026-03-08)


### Reverts

* replace determinate progress with indeterminate spinner ([81bfd89](https://github.com/pedropombeiro/opencode-terminal-progress/commit/81bfd899fad64e6c54d9bb8f92647a27e1f4cf43))

## [0.4.1](https://github.com/pedropombeiro/opencode-terminal-progress/compare/opencode-terminal-progress-v0.4.0...opencode-terminal-progress-v0.4.1) (2026-03-08)


### Bug Fixes

* write OSC sequences to /dev/tty instead of stderr ([#9](https://github.com/pedropombeiro/opencode-terminal-progress/issues/9)) ([e29b640](https://github.com/pedropombeiro/opencode-terminal-progress/commit/e29b640a98670db000b3968aaa86b01ee44465d1))

## [0.4.0](https://github.com/pedropombeiro/opencode-terminal-progress/compare/opencode-terminal-progress-v0.3.1...opencode-terminal-progress-v0.4.0) (2026-03-08)


### Features

* add OPENCODE_TERMINAL_PROGRESS env var to disable progress bar ([#7](https://github.com/pedropombeiro/opencode-terminal-progress/issues/7)) ([95e8a76](https://github.com/pedropombeiro/opencode-terminal-progress/commit/95e8a767b974e863a8f6ac7f439ac6ae7b978fb2))

## [0.3.1](https://github.com/pedropombeiro/opencode-terminal-progress/compare/opencode-terminal-progress-v0.3.0...opencode-terminal-progress-v0.3.1) (2026-03-07)


### Bug Fixes

* deduplicate tool events to prevent progress bar bouncing ([2fd71be](https://github.com/pedropombeiro/opencode-terminal-progress/commit/2fd71be70a14de12e7ea2512629511507a8fbd9a))

## [0.3.0](https://github.com/pedropombeiro/opencode-terminal-progress/compare/opencode-terminal-progress-v0.2.2...opencode-terminal-progress-v0.3.0) (2026-03-07)


### Features

* show determinate progress based on tool completion tracking ([77f9167](https://github.com/pedropombeiro/opencode-terminal-progress/commit/77f9167da34b053ed6028c0a61b71853f6a05707))

## [0.2.2](https://github.com/pedropombeiro/opencode-terminal-progress/compare/opencode-terminal-progress-v0.2.1...opencode-terminal-progress-v0.2.2) (2026-03-07)


### Bug Fixes

* write OSC sequences to stderr to avoid polluting captured stdout ([#3](https://github.com/pedropombeiro/opencode-terminal-progress/issues/3)) ([343fed9](https://github.com/pedropombeiro/opencode-terminal-progress/commit/343fed9fd5844f29027662d96a9d3e6cfcb4b5dc))

## [0.2.1](https://github.com/pedropombeiro/opencode-terminal-progress/compare/opencode-terminal-progress-v0.2.0...opencode-terminal-progress-v0.2.1) (2026-03-07)


### Bug Fixes

* show paused progress indicator during permission prompts and questions ([9be7550](https://github.com/pedropombeiro/opencode-terminal-progress/commit/9be75503dc34ea65da0a66fe06629911074a0f14))

## [0.2.0](https://github.com/pedropombeiro/opencode-terminal-progress/compare/opencode-terminal-progress-v0.1.0...opencode-terminal-progress-v0.2.0) (2026-03-06)


### Features

* initial plugin with iTerm2, WezTerm, and Windows Terminal support ([fa0a033](https://github.com/pedropombeiro/opencode-terminal-progress/commit/fa0a033e8a63936d670d0d07dbdc712f0be1f4dc))
