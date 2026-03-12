# Agent Instructions

## Build & development commands

All tasks are run via mise:

- `mise run setup` — install dependencies
- `mise run build` — build all plugins into `packages/*/dist/`
- `mise run dev <package>` — build a single package with inline sourcemaps
- `mise run typecheck` — type-check all packages
- `mise run lint` — lint with ESLint
- `mise run lint:fix` — lint and auto-fix
- `mise run format` — format with Prettier

There are no npm scripts. Do not add a `"scripts"` key to any `package.json`.

## Code style

- TypeScript strict mode, ESNext target
- Single quotes, semicolons, 100-char line width, 2-space indent, trailing commas
- No `console.log` — ESLint enforces `no-console: error`
- No comments unless explicitly requested
- Imports: use `import type` for type-only imports

## Monorepo structure

- Root `package.json` is private with `"workspaces": ["packages/*"]`
- All devDependencies live at the root
- Each package has its own `package.json` with name, version, description, and peerDependencies only
- Each package extends `../../tsconfig.base.json` via its own `tsconfig.json`

## Adding a new plugin

1. Copy `packages/_template/` to `packages/<name>/` and replace all `PLUGIN-NAME` placeholders
2. Add the package to `release-please-config.json` and `.release-please-manifest.json`
3. Add a publish job in `.github/workflows/release.yml`

## Testing

There are no automated tests. Verify by running `mise run build` and `mise run typecheck` successfully.

## Releasing

Releases are fully automated via [release-please](https://github.com/googleapis/release-please) and GitHub Actions. **Do NOT manually bump versions.**

1. Push commits to `main` using [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `fix:`, `feat:`, `chore:`).
2. Release-please creates separate release PRs per package.
3. Merge the release PR — this creates a GitHub Release and triggers npm publish.
