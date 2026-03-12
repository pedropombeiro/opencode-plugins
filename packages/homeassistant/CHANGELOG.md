# Changelog

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
