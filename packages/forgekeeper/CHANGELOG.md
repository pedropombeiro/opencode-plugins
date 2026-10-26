# Changelog

## [2.2.1](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-forgekeeper-2.2.0...opencode-forgekeeper-2.2.1) (2026-10-26)


### Bug Fixes

* **forgekeeper:** open links once and clarify CI check counts ([#100](https://github.com/pedropombeiro/opencode-plugins/issues/100)) ([3524e3d](https://github.com/pedropombeiro/opencode-plugins/commit/3524e3d07367bb1dfaca431087106aa98eff04d6))

## [2.2.0](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-forgekeeper-2.1.1...opencode-forgekeeper-2.2.0) (2026-10-26)


### Features

* **forgekeeper:** monitor GitHub PR feedback and Copilot reviews ([c556f6a](https://github.com/pedropombeiro/opencode-plugins/commit/c556f6a1166d2724b01b9879da3bd7ad852ab742))

## [2.1.1](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-forgekeeper-2.1.0...opencode-forgekeeper-2.1.1) (2026-10-10)


### Bug Fixes

* **forgekeeper:** show unavailable status only for established targets ([54ecb9b](https://github.com/pedropombeiro/opencode-plugins/commit/54ecb9b4c919837c26572ecdfc50a09d091b25fd))

## [2.1.0](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-forgekeeper-2.0.0...opencode-forgekeeper-2.1.0) (2026-10-10)


### Features

* **forgekeeper:** style the review status dialog ([3b49cb2](https://github.com/pedropombeiro/opencode-plugins/commit/3b49cb2f985ad74fa7153bb865425fb266a3637e))

## [2.0.0](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-forgekeeper-1.0.0...opencode-forgekeeper-2.0.0) (2026-10-10)


### ⚠ BREAKING CHANGES

* **forgekeeper:** Nothing stored under opencode-forge-session-title carries over. Sessions return to branch-based naming until their targets are set again, each PR/MR records a new review baseline, and RPC callers need the opencode-forgekeeper ID.

### Features

* **forgekeeper:** use opencode-forgekeeper as the server and RPC ID ([#90](https://github.com/pedropombeiro/opencode-plugins/issues/90)) ([5bd183c](https://github.com/pedropombeiro/opencode-plugins/commit/5bd183c0d29a877481e6c7ab1bc00c96e235fa38))

## 1.0.0 (2026-10-10)


### Features

* **forgekeeper:** rename opencode-forge-session to opencode-forgekeeper ([#88](https://github.com/pedropombeiro/opencode-plugins/issues/88)) ([d81f678](https://github.com/pedropombeiro/opencode-plugins/commit/d81f6781caf9eaebdf08fa6bf49a9df9528688fa))
* **terminal-progress:** add Ghostty terminal detection ([4e6c499](https://github.com/pedropombeiro/opencode-plugins/commit/4e6c499b1e8fd9d5ae74096d1564a24c0ee34555))


### Bug Fixes

* **forge-session-title:** update repository URL to monorepo ([1d2ef1d](https://github.com/pedropombeiro/opencode-plugins/commit/1d2ef1df11373d14797b6bfa002fbdff48197078))
* **homeassistant:** update repository URL to monorepo ([e0bd582](https://github.com/pedropombeiro/opencode-plugins/commit/e0bd582263126b4211dd17595475d40eaf270f02))
* **terminal-progress:** update repository URL to monorepo ([6d72ed2](https://github.com/pedropombeiro/opencode-plugins/commit/6d72ed2572f051feb3ec6e9c253239f845785635))
