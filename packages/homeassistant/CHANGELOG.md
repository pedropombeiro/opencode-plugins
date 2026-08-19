# Changelog

## [0.7.4](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-homeassistant-0.7.3...opencode-homeassistant-0.7.4) (2026-08-19)


### Bug Fixes

* **homeassistant:** explain why an entity read failed ([#58](https://github.com/pedropombeiro/opencode-plugins/issues/58)) ([f0d19eb](https://github.com/pedropombeiro/opencode-plugins/commit/f0d19eb264b2469a2b147a877195a2ad5db6d65c))

## [0.7.3](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-homeassistant-0.7.2...opencode-homeassistant-0.7.3) (2026-08-19)


### Bug Fixes

* **homeassistant:** name the missing token variable ([#56](https://github.com/pedropombeiro/opencode-plugins/issues/56)) ([9e559f3](https://github.com/pedropombeiro/opencode-plugins/commit/9e559f320b6ae5e246834b4d088ad84ed1a7a2ec))

## [0.7.2](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-homeassistant-0.7.1...opencode-homeassistant-0.7.2) (2026-08-18)


### Bug Fixes

* **homeassistant:** surface question reply failures and trace the reply lifecycle ([#54](https://github.com/pedropombeiro/opencode-plugins/issues/54)) ([5594e6a](https://github.com/pedropombeiro/opencode-plugins/commit/5594e6a320425157ed0c63c93680d4c7872a6a43))

## [0.7.1](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-homeassistant-0.7.0...opencode-homeassistant-0.7.1) (2026-08-18)


### Bug Fixes

* **homeassistant:** send question webhook once the request ID exists ([#52](https://github.com/pedropombeiro/opencode-plugins/issues/52)) ([b9c3fda](https://github.com/pedropombeiro/opencode-plugins/commit/b9c3fdac2f3989ec5b0b8e50793c05cc7f88bdbf))

## [0.7.0](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-homeassistant-0.6.0...opencode-homeassistant-0.7.0) (2026-08-18)


### Features

* **homeassistant:** answer questions from Home Assistant ([76c3e8e](https://github.com/pedropombeiro/opencode-plugins/commit/76c3e8e4a5883cece6adc8772e128b730ac8932a))

## [0.6.0](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-homeassistant-0.5.2...opencode-homeassistant-0.6.0) (2026-08-13)


### ⚠ BREAKING CHANGES

* **homeassistant:** requires @opencode-ai/plugin >=1.15.11 for the awaited dispose hook

### Bug Fixes

* **homeassistant:** flush webhooks on dispose ([f71fd78](https://github.com/pedropombeiro/opencode-plugins/commit/f71fd78558fe863801f83765311fafb3f4486bc5))
* **homeassistant:** sweep stale sessions periodically ([efd33b6](https://github.com/pedropombeiro/opencode-plugins/commit/efd33b6ce4cc3b77cc59bedf1c2aef43646371aa))

## [0.5.2](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-homeassistant-0.5.1...opencode-homeassistant-0.5.2) (2026-08-07)


### Bug Fixes

* **homeassistant:** use shared agent state tracker ([6393ed1](https://github.com/pedropombeiro/opencode-plugins/commit/6393ed1f2e562c6d32175ca9b6e8dcbfbb4a113b))

## [0.5.1](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-homeassistant-0.5.0...opencode-homeassistant-0.5.1) (2026-08-05)


### Bug Fixes

* **homeassistant:** handle reply IDs and question states ([bf5154a](https://github.com/pedropombeiro/opencode-plugins/commit/bf5154a3f5dd1271fa01f4c4ccf4ee570fbf2d33))

## [0.5.0](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-homeassistant-0.4.3...opencode-homeassistant-0.5.0) (2026-05-11)


### Features

* **homeassistant:** emit busy state on permission.replied ([1513300](https://github.com/pedropombeiro/opencode-plugins/commit/151330069a6f260d2cd42a2df3183e436d3e2bc8))
* **terminal-progress:** add Ghostty terminal detection ([4e6c499](https://github.com/pedropombeiro/opencode-plugins/commit/4e6c499b1e8fd9d5ae74096d1564a24c0ee34555))

## [0.4.3](https://github.com/pedropombeiro/opencode-plugins/compare/opencode-homeassistant-0.4.2...opencode-homeassistant-0.4.3) (2026-03-12)


### Bug Fixes

* **forge-session-title:** update repository URL to monorepo ([1d2ef1d](https://github.com/pedropombeiro/opencode-plugins/commit/1d2ef1df11373d14797b6bfa002fbdff48197078))
* **homeassistant:** update repository URL to monorepo ([e0bd582](https://github.com/pedropombeiro/opencode-plugins/commit/e0bd582263126b4211dd17595475d40eaf270f02))
* **terminal-progress:** update repository URL to monorepo ([6d72ed2](https://github.com/pedropombeiro/opencode-plugins/commit/6d72ed2572f051feb3ec6e9c253239f845785635))

## [0.4.2](https://github.com/pedropombeiro/opencode-homeassistant/compare/opencode-homeassistant-v0.4.1...opencode-homeassistant-v0.4.2) (2026-03-10)


### Bug Fixes

* track session start time only on first busy event ([3ae5455](https://github.com/pedropombeiro/opencode-homeassistant/commit/3ae54558a0f572ca34bec1fdf619ab6ebc0c258b))

## [0.4.1](https://github.com/pedropombeiro/opencode-homeassistant/compare/opencode-homeassistant-v0.4.0...opencode-homeassistant-v0.4.1) (2026-03-10)


### Bug Fixes

* serialize webhook delivery to prevent busy/waiting race condition ([4012369](https://github.com/pedropombeiro/opencode-homeassistant/commit/4012369facd58ea42e7de2c4ac1c3aa600f48871))

## [0.4.0](https://github.com/pedropombeiro/opencode-homeassistant/compare/opencode-homeassistant-v0.3.2...opencode-homeassistant-v0.4.0) (2026-03-10)


### Features

* remote permission response and question choices ([#14](https://github.com/pedropombeiro/opencode-homeassistant/issues/14)) ([0477975](https://github.com/pedropombeiro/opencode-homeassistant/commit/0477975361cb9ee7398e979c85a52b5cfd44f311))

## [0.3.2](https://github.com/pedropombeiro/opencode-homeassistant/compare/opencode-homeassistant-v0.3.1...opencode-homeassistant-v0.3.2) (2026-03-09)


### Bug Fixes

* parse question tool args when received as JSON string ([dc6fec3](https://github.com/pedropombeiro/opencode-homeassistant/commit/dc6fec3aa958a4a03cd41d4c9d3ec0ad7bc17f96))

## [0.3.1](https://github.com/pedropombeiro/opencode-homeassistant/compare/opencode-homeassistant-v0.3.0...opencode-homeassistant-v0.3.1) (2026-03-09)


### Bug Fixes

* include question title in waiting payload ([3b8ba00](https://github.com/pedropombeiro/opencode-homeassistant/commit/3b8ba0082b6a8696a0126f9a5798a77813adda68))

## [0.3.0](https://github.com/pedropombeiro/opencode-homeassistant/compare/opencode-homeassistant-v0.2.7...opencode-homeassistant-v0.3.0) (2026-03-08)


### Features

* enrich webhook payloads with session duration and waiting details ([4b672cb](https://github.com/pedropombeiro/opencode-homeassistant/commit/4b672cb557201df8d8247d6fa903effed8e7fbd1))
* hot-reload configuration via the config hook ([58db3c0](https://github.com/pedropombeiro/opencode-homeassistant/commit/58db3c0c96843912fd288274c752f4a4e0680dc4))
* support per-state webhook routing and multiple targets ([542ca1e](https://github.com/pedropombeiro/opencode-homeassistant/commit/542ca1e4ed8b2d12b999e1d2169f9da2762059a4))

## [0.2.7](https://github.com/pedropombeiro/opencode-homeassistant/compare/opencode-homeassistant-v0.2.6...opencode-homeassistant-v0.2.7) (2026-03-06)


### Bug Fixes

* **docs:** link LICENSE file from README ([1437cab](https://github.com/pedropombeiro/opencode-homeassistant/commit/1437cab99f9b02dcf20f5df99c61bf95d9119c94))

## [0.2.6](https://github.com/pedropombeiro/opencode-homeassistant/compare/opencode-homeassistant-v0.2.5...opencode-homeassistant-v0.2.6) (2026-03-06)


### Bug Fixes

* **ci:** remove workarounds for trusted publishing OIDC ([8002069](https://github.com/pedropombeiro/opencode-homeassistant/commit/80020696260519b379e241c754355ac59243a408))

## [0.2.5](https://github.com/pedropombeiro/opencode-homeassistant/compare/opencode-homeassistant-v0.2.4...opencode-homeassistant-v0.2.5) (2026-03-06)


### Bug Fixes

* **ci:** strip authToken from .npmrc for trusted publishing ([0e6d6e1](https://github.com/pedropombeiro/opencode-homeassistant/commit/0e6d6e1e7d4e732cc2384f47b0505825894ad4ba))

## [0.2.4](https://github.com/pedropombeiro/opencode-homeassistant/compare/opencode-homeassistant-v0.2.3...opencode-homeassistant-v0.2.4) (2026-03-06)


### Bug Fixes

* **ci:** unset NODE_AUTH_TOKEN for OIDC trusted publishing ([a24924d](https://github.com/pedropombeiro/opencode-homeassistant/commit/a24924ddb6c85e28fa4a4ddf13312d66b131232d))

## [0.2.3](https://github.com/pedropombeiro/opencode-homeassistant/compare/opencode-homeassistant-v0.2.2...opencode-homeassistant-v0.2.3) (2026-03-06)


### Bug Fixes

* **ci:** clear setup-node auth token for OIDC publishing ([729a0f5](https://github.com/pedropombeiro/opencode-homeassistant/commit/729a0f54800e4b17c0edbba12df861c30839063b))

## [0.2.2](https://github.com/pedropombeiro/opencode-homeassistant/compare/opencode-homeassistant-v0.2.1...opencode-homeassistant-v0.2.2) (2026-03-06)


### Bug Fixes

* **ci:** restore setup-node for registry config ([1cb6cd7](https://github.com/pedropombeiro/opencode-homeassistant/commit/1cb6cd75725b3671d572214b2d1f5f5444963bc7))

## [0.2.1](https://github.com/pedropombeiro/opencode-homeassistant/compare/opencode-homeassistant-v0.2.0...opencode-homeassistant-v0.2.1) (2026-03-06)


### Bug Fixes

* **ci:** remove setup-node to let npm OIDC handle auth ([7c11fff](https://github.com/pedropombeiro/opencode-homeassistant/commit/7c11fffa42a1c041a900601e2b8e8b0138e0e27b))

## [0.2.0](https://github.com/pedropombeiro/opencode-homeassistant/compare/opencode-homeassistant-v0.1.0...opencode-homeassistant-v0.2.0) (2026-03-06)


### Features

* initial release ([3d771a0](https://github.com/pedropombeiro/opencode-homeassistant/commit/3d771a079bba72f87410016271b3b5f6218bf0c6))


### Bug Fixes

* **ci:** correct pinned action SHAs ([146237f](https://github.com/pedropombeiro/opencode-homeassistant/commit/146237f0041d11c2fd6d55ecf30da6642313ee4d))
* **ci:** grant id-token permission in release workflow ([e556aae](https://github.com/pedropombeiro/opencode-homeassistant/commit/e556aae23251b8504ed4bce7c6f8166f1a837513))

## Changelog
