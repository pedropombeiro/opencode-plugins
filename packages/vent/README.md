# opencode-vent

An [OpenCode](https://opencode.ai) plugin that exposes a `vent` tool and a `resolve-vent` skill so
agents can record and resolve tooling, documentation, skill, permission, and workflow frictions
encountered during routine work.

Requires OpenCode 2.4 or later.

## How it works

- Registers the `vent` tool (`codemode: false`) and injects concise guidance into sessions when at
  least one destination is configured, so the agent knows when to record actionable friction and
  what to leave out.
- Registers the `resolve-vent` skill through `ctx.skill.transform`, tailored to your configured
  destinations and resolution labels. If you already define a local `resolve-vent` skill on disk,
  your local definition takes precedence.
- Formats each entry with structured Markdown sections (`Friction`, `Context`,
  `Evidence / Reproduction`, `Suggested Improvement`) and a collapsible session metadata block
  (timestamp, category, working directory, repository remote, branch, and session ID).
- Checks existing open items at the target destination before creating a new entry. When an open
  item matches above `similarityThreshold`, `vent` appends a comment or occurrence subsection
  instead of filing a duplicate.
- When no open item matches but a similar closed GitHub or GitLab issue does, `vent` writes
  nothing and returns the closed issue with its labels. The agent asks you first, then calls
  `vent` again with `onClosedMatch`.
- Uses standard OpenCode tool permissions. Keep `vent` on `ask` if you want to review and approve
  the payload before an issue is created or updated.

## Prerequisites

- **GitLab destinations** require [`glab`](https://gitlab.com/gitlab-org/cli) on `$PATH`,
  authenticated with the target GitLab host.
- **GitHub destinations** require [`gh`](https://cli.github.com) on `$PATH`, authenticated with
  the target GitHub host.
- **File destinations** write directly to the local filesystem and need no external CLI.

## Installation

```bash
opencode plugin add opencode-vent
```

Then configure at least one destination in `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-vent",
      "options": {
        "defaultDestination": "local",
        "similarityThreshold": 0.45,
        "destinations": {
          "local": {
            "type": "file",
            "path": "~/.agents/docs/vents.md",
          },
          "gitlab": {
            "type": "gitlab",
            "project": "group/project",
            "epic": "https://gitlab.com/groups/group/-/epics/123",
            "host": "gitlab.com",
            "confidential": true,
            "labels": ["agent-friction"],
            "reopenLabels": ["resolution::cannot-reproduce", "resolution::mitigated"],
            "resolutionLabelPrefix": "resolution::",
          },
          "github": {
            "type": "github",
            "repo": "owner/repo",
            "host": "github.com",
            "labels": ["agent-friction"],
            "acceptsUnrelated": true,
          },
        },
        "routes": [
          { "directoryPrefix": "~/work", "destination": "gitlab", "enforced": true },
          { "remoteContains": "github.com/owner/", "destination": "github" },
        ],
      },
    },
  ],
}
```

## Tool parameters

| Parameter         | Required | Description                                                                                                                                                                                                                      |
| ----------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `title`           | Yes      | Concise summary of the friction (issue title or Markdown `##` heading).                                                                                                                                                          |
| `friction`        | Yes      | Description of what failed, was slow, was undocumented, or caused wasted effort.                                                                                                                                                 |
| `context`         | Yes      | Task or investigation underway when the friction occurred.                                                                                                                                                                       |
| `evidence`        | No       | Error messages, commands, file paths, or reproduction details.                                                                                                                                                                   |
| `suggestion`      | No       | Proposed fix or improvement.                                                                                                                                                                                                     |
| `category`        | No       | One of `tooling`, `documentation`, `skill`, `permissions`, `environment`, `workflow`, `other`. Applied as a label on GitLab and GitHub issues.                                                                                   |
| `labels`          | No       | Extra labels merged with the destination's configured `labels` and `category` (GitLab and GitHub).                                                                                                                               |
| `destination`     | No       | Named destination key. Enforced routes restrict overrides.                                                                                                                                                                       |
| `unrelatedReason` | No       | Why the friction is unrelated to the current checkout. Requires an explicit `destination`. Required to override an enforced route, and only destinations with `acceptsUnrelated: true` accept the override.                      |
| `localReason`     | No       | Deprecated alias for `unrelatedReason`.                                                                                                                                                                                          |
| `onClosedMatch`   | No       | Only after a result reported a similar closed issue, and after asking the user. `reopen` reopens it, removes its resolution labels, and adds this occurrence as a comment. `create` files a new issue that links the closed one. |
| `closedMatchUrl`  | No       | URL of the closed issue approved by the user when calling `vent` again with `onClosedMatch`.                                                                                                                                     |

## Destination resolution order

1. First matching route with `enforced: true`. A different destination is rejected unless it sets
   `acceptsUnrelated: true` and `unrelatedReason` explains why the friction is unrelated to the
   checkout.
2. Explicit `destination` tool argument.
3. First matching non-enforced route.
4. `defaultDestination`, or the sole destination when only one is configured.

Routes match by `directoryPrefix`, `remoteContains`, or `remoteRepository`. If you specify more
than one condition on a route, all must match. Remote rules check fetch URLs, including remotes
other than `origin`. `remoteRepository` matches a full `host/namespace/project` identity across
HTTPS and SSH URLs. An issue destination failure never falls back to another destination.

Any destination can set `acceptsUnrelated: true`. It then accepts vents that an enforced route
would otherwise send elsewhere, as long as the call names it in `destination` and gives an
`unrelatedReason`. Unrelated overrides omit checkout-identifying metadata (`Directory`,
`Repository`, `Branch`, and `Session`) unless the destination sets
`includeCheckoutMetadataOnUnrelated: true`.

## Destination types

- **`gitlab`**: uses `glab api` to list open issues under `epic` (accepting legacy epic URLs, work
  item epic URLs, or `<group>&<iid>` shorthand) or `project`. Comments on a matching open issue, or
  creates a new issue in `project` linked to `epic` via the `/epic` quick action with a REST link
  fallback. If no open issue matches, compares closed issues in the configured project and epic and
  returns the closest one without writing. See [Closed matches](#closed-matches). `confidential`
  defaults to `true`.
- **`github`**: uses `gh api` to list open issues in `repo` (ignoring pull requests). Comments on a
  matching open issue. If none matches, compares closed issues and returns the closest one without
  writing (see [Closed matches](#closed-matches)), or creates a new issue.
- **`file`**: reads and updates a local Markdown file (supporting leading `~/`). Appends a
  `### Occurrence (YYYY-MM-DD)` subsection to a matching `##` section, or appends a new `##`
  section.

## Closed matches

`vent` never writes to a closed issue on its own. When a similar closed issue exists, the result
has `action: "closed-match"`, the issue URL, its labels, and advice. The agent then asks you and
calls `vent` again with `onClosedMatch`:

- `reopen` sets the issue to open, removes labels that start with `resolutionLabelPrefix`, and
  adds the new occurrence as a comment.
- `create` files a new issue that links the closed one.

`reopenLabels` lists labels that mark an issue as closed without a confirmed fix, such as
`resolution::cannot-reproduce`. The advice recommends `reopen` for those. For any other closed
issue it recommends `create`, because a recurrence is likely a regression. Without `reopenLabels`,
the advice offers both. The file destination is unaffected.

## License

[MIT](./LICENSE)
