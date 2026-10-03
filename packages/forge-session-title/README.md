# opencode-forge-session-title

An [OpenCode](https://opencode.ai) plugin that automatically prefixes session titles with forge
issue and PR/MR references from the session's active task, with the current Git branch as a fallback.

Requires OpenCode 2. For OpenCode 1, install the `opencode-v1` dist-tag
(`npm install opencode-forge-session-title@opencode-v1`).

## Supported forges

| Forge  | Detection              | CLI used       | Example prefix |
| ------ | ---------------------- | -------------- | -------------- |
| GitHub | `github.com` in remote | `gh pr list`   | `[#42, #108]`  |
| GitLab | `gitlab` in remote     | `glab mr list` | `[#42, !108]`  |

For branch-based naming, the forge is detected from `git remote get-url origin`.
Explicit session targets work independently of the checked-out branch or remote.

## How it works

The plugin registers `set_session_target` and adds instructions to the agent's context.
When you establish or change the primary issue, PR, or MR, the agent sets its full URL as the
session target. Background references, comparisons, and dependencies keep the current target.

For example, if the title starts with `[#123, !45]` and you ask the agent to review MR `!456`,
the prefix becomes `[!456]`. The previous issue number is removed. The agent can provide
`issue_url` when it has established the new MR's related issue. Without `issue_url`, the plugin
reads the PR/MR source branch with `gh api` or `glab api` and extracts the issue number from it
(see patterns below), so reviewing an MR from `321-fix-timeout` produces `[#321, !456]`.

The agent is also instructed to set the new PR/MR as the target after creating one for the
current task, so a session targeting issue `#123` becomes `[#123, !456]` once the MR exists.

Targets persist per session across plugin reloads. The context includes the current target on
each agent request. Calling `set_session_target` with `target: "branch"` returns to automatic
branch-based naming. This behavior depends on the agent following the injected instructions.

When no explicit target is set, the plugin:

1. Reads the current git branch
2. Extracts an issue number from the branch name (see patterns below)
3. Looks up an open PR (GitHub) or MR (GitLab) for that branch
4. Prefixes the session title: `[#issue, !MR] original title`

If no PR/MR exists yet, the reference shows as `#N/A` (GitHub) or `!N/A` (GitLab) and is
automatically replaced once one is created.

The plugin reconciles the prefix after target changes, title changes, and successful agent runs.
It preserves the title text and replaces stale managed prefixes.

Child sessions and untitled sessions are skipped. Branch-based naming skips the repository's
default branch and branches named `main`, `master`, `develop`, or `HEAD`. Explicit targets also
work on these branches. Resetting to branch mode there removes the managed prefix.

## RPC

Other plugins and clients can read a session's explicit target through the
`opencode-forge-session-title` [RPC](https://opencode.ai/v2/docs/build/plugins/rpc), for
example to show the status of the session's MR. Copy this definition into the caller:

```ts
const ForgeSessionTitleRpc = {
  id: 'opencode-forge-session-title',
  methods: {
    target: {
      input: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        required: ['sessionID'],
      },
      output: {
        type: 'object',
        properties: { url: { type: 'string' }, issueUrl: { type: 'string' } },
      },
    },
  },
  events: {
    targetChanged: {
      schema: {
        type: 'object',
        properties: {
          sessionID: { type: 'string' },
          url: { type: 'string' },
          issueUrl: { type: 'string' },
        },
        required: ['sessionID'],
      },
    },
  },
} as const;
```

- `target` returns `{ url, issueUrl? }` for a session with an explicit target, and `{}` in
  automatic branch mode.
- `targetChanged` fires after `set_session_target` runs. It omits `url` when the session
  returns to branch mode.

```ts
const forge = context.client.rpc(ForgeSessionTitleRpc);
const { url } = await forge.target({ sessionID }, { location: session.location });
const stop = forge.events.on('targetChanged', (event) => refresh(event.data.sessionID));
```

The call fails when the plugin isn't loaded on the server, so callers should fall back to
another source, such as the session title prefix.

## Branch name patterns

The plugin extracts issue numbers from these common branch naming conventions:

| Pattern                           | Example branch          | Extracted |
| --------------------------------- | ----------------------- | --------- |
| `<prefix>/<number>-<description>` | `feature/123-add-login` | `123`     |
| `<number>-<description>`          | `123-fix-typo`          | `123`     |
| `<description>-<number>`          | `fix-typo-123`          | `123`     |
| `<prefix>/<number>/<description>` | `user/123/some-work`    | `123`     |
| `issue-<number>`, `gh-<number>`   | `gh-42-improve-perf`    | `42`      |
| `fix-<number>`, `feat-<number>`   | `fix-99`                | `99`      |
| `hotfix/<number>-<description>`   | `hotfix/501-critical`   | `501`     |

If no issue number can be extracted, the full branch name is used instead.

## Installation

```bash
opencode plugin add opencode-forge-session-title
```

This adds the plugin to your `~/.config/opencode/opencode.json`:

```json
{
  "plugins": ["opencode-forge-session-title"]
}
```

### Prerequisites

- **GitHub**: [gh CLI](https://cli.github.com/) installed and authenticated
- **GitLab**: [glab CLI](https://gitlab.com/gitlab-org/cli) installed and authenticated

## License

[MIT](LICENSE)
