# opencode-forge-session-title

An [OpenCode](https://opencode.ai) plugin that automatically prefixes session titles with forge
issue and PR/MR references extracted from the current git branch.

## Supported forges

| Forge  | Detection             | CLI used        | Example prefix          |
| ------ | --------------------- | --------------- | ----------------------- |
| GitHub | `github.com` in remote | `gh pr list`   | `[#42, #108]`           |
| GitLab | `gitlab` in remote     | `glab mr list` | `[#42, !108]`           |

The forge is detected from `git remote get-url origin`. If the remote doesn't match either forge,
the plugin is a no-op.

## How it works

On every `session.idle` event the plugin:

1. Reads the current git branch
2. Extracts an issue number from the branch name (see patterns below)
3. Looks up an open PR (GitHub) or MR (GitLab) for that branch
4. Prefixes the session title: `[#issue, !MR] original title`

If no PR/MR exists yet, the reference shows as `#N/A` (GitHub) or `!N/A` (GitLab) and is
automatically replaced once one is created.

Child sessions and default-titled sessions (e.g. `New session - 2025-01-01T...`) are skipped.
Branches named `main`, `master`, `develop`, or `HEAD` are also skipped.

## Branch name patterns

The plugin extracts issue numbers from these common branch naming conventions:

| Pattern                            | Example branch                  | Extracted |
| ---------------------------------- | ------------------------------- | --------- |
| `<prefix>/<number>-<description>`  | `feature/123-add-login`         | `123`     |
| `<number>-<description>`           | `123-fix-typo`                  | `123`     |
| `<description>-<number>`           | `fix-typo-123`                  | `123`     |
| `<prefix>/<number>/<description>`  | `user/123/some-work`            | `123`     |
| `issue-<number>`, `gh-<number>`    | `gh-42-improve-perf`            | `42`      |
| `fix-<number>`, `feat-<number>`    | `fix-99`                        | `99`      |
| `hotfix/<number>-<description>`    | `hotfix/501-critical`           | `501`     |

If no issue number can be extracted, the full branch name is used instead.

## Installation

Add to your `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-forge-session-title"]
}
```

### Prerequisites

- **GitHub**: [gh CLI](https://cli.github.com/) installed and authenticated
- **GitLab**: [glab CLI](https://gitlab.com/gitlab-org/cli) installed and authenticated

## License

[MIT](LICENSE)
