# Agent Instructions

## Build & development commands

All tasks are run via mise:

- `mise run setup` — install dependencies
- `mise run build [package...]` — build all plugins (or only the named ones) into `packages/*/dist/`
- `mise run dev <package>` — build a single package with inline sourcemaps
- `mise run typecheck` — type-check all packages
- `mise run test` — run all tests
- `mise run lint` — lint with ESLint
- `mise run lint:fix` — lint and auto-fix
- `mise run format` — format with Prettier
- `mise run install-local <package>` — build a plugin into `~/.config/opencode/plugins/<package>/`

There are no npm scripts. Do not add a `"scripts"` key to any `package.json`.

## Code style

- TypeScript strict mode, ESNext target
- Single quotes, semicolons, 100-char line width, 2-space indent, trailing commas
- No `console.log` — ESLint enforces `no-console: error`
- No comments unless explicitly requested
- Imports: use `import type` for type-only imports

## Plugin API

Plugins target the OpenCode 2 plugin API (`@opencode/plugin`). See
<https://opencode.ai/v2/docs/build/plugins>.

- Server plugins live in `src/index.ts`; CLI (TUI) plugins live in `src/tui.ts`. The build compiles
  whichever exist, and packages export them as `.` and `./tui`.
- Import `@opencode/plugin` and `@opencode/plugin/tui` with `import type` only, and default-export
  `{ id, setup } satisfies Plugin.Plugin` (or `Plugin.Definition` for TUI). `Plugin.define` is an
  identity function, so no runtime dependency is needed. The build marks the package as external as
  a safety net.
- Use `exec` from `packages/_shared/` to run subprocesses. Do not rely on Bun's `$`.
- Code that talks to the user's terminal (TTY escape codes, tmux) belongs in a CLI plugin, because
  the server can run in a separate process or on a remote host.

## Monorepo structure

- Root `package.json` is private with `"workspaces": ["packages/*"]`
- All devDependencies live at the root
- Each package has its own `package.json` with name, version, description, and a peerDependency on
  `@opencode/plugin`
- Each package extends `../../tsconfig.base.json` via its own `tsconfig.json`
- Internal shared code lives in `packages/_shared/` without a `package.json`; it is bundled into each plugin

## Adding a new plugin

1. Copy `packages/_template/` to `packages/<name>/` and replace all `PLUGIN-NAME` placeholders
2. Add the package to `release-please-config.json` and `.release-please-manifest.json`
3. Add a publish job in `.github/workflows/release.yml`

## Testing

Verify by running `mise run test`, `mise run build`, and `mise run typecheck` successfully.

## Releasing

Releases are fully automated via [release-please](https://github.com/googleapis/release-please) and GitHub Actions. **Do NOT manually bump versions.**

1. Push commits to `main` using [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `fix:`, `feat:`, `chore:`).
2. Release-please creates separate release PRs per package.
3. Merge the release PR — this creates a GitHub Release and triggers npm publish.

### OpenCode 1 maintenance

The `v1` branch holds the last OpenCode 1 versions (0.x) of every plugin. Releases from `v1` publish
under the npm dist-tag `opencode-v1`; releases from `main` publish under `latest`. npm rejects
dist-tags that are valid semver ranges, such as `v1`.

To ship an OpenCode 1 hotfix, open a PR against `v1` with a `fix:` commit, then merge the
release-please PR that targets `v1`. Do not merge V2 code into `v1`.
