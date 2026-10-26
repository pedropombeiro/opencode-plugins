# opencode-forgekeeper

An [OpenCode](https://opencode.ai) plugin that tracks the issues or PRs/MRs a session works on.
It prefixes the session title with their references, shows the PR/MR status in the prompt
footer, and tells the agent about new review feedback. It supports GitLab and GitHub. The status
and review notifications are optional; see [Keep only session titles](#keep-only-session-titles).

Requires OpenCode 2. It replaces
[`opencode-forge-session-title`](https://www.npmjs.com/package/opencode-forge-session-title); see
[Migrating from opencode-forge-session-title](#migrating-from-opencode-forge-session-title).

## Installation

```bash
opencode plugin add opencode-forgekeeper
```

This adds the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-forgekeeper"]
}
```

The package has a server entry point and a CLI entry point, which OpenCode loads automatically.
The server owns session targets, title prefixes, forge lookups, polling, and notification
delivery. The CLI holds leases on the sessions it has shown, their latest snapshots, and each
directory's settings. It renders the status that the server serves and shows its notices as
toasts.

### Requirements

- [`glab`](https://gitlab.com/gitlab-org/cli) for GitLab and [`gh`](https://cli.github.com/)
  for GitHub, on the `PATH` of the OpenCode server. Each is only needed for its forge.
- Each CLI logged in to every host it's used for: `glab auth login --hostname <host>` and
  `gh auth login --hostname <host>`. The plugin uses their credentials and has none of its
  own.
- For self-managed GitLab hosts not named `gitlab.*`, and for GitHub Enterprise, the
  `hosts` and `githubHosts` [options](#options).

Without a forge CLI, titles still follow targets and branches, and `/forge-status` reports
what's missing, such as `glab is not installed`.

## Session targets

The server registers the `set_session_target` tool and adds instructions to the agent's
context. When you establish or change the primary issue, PR, or MR, the agent sets its full
URL as the session target. Background references, comparisons, and dependencies keep the
current target. After the agent creates a PR/MR for the current task, it sets the new PR/MR
as the target, passing the current issue as `issue_url`.

For example, if the title starts with `[#123, !45]` and you ask the agent to review MR `!456`,
the prefix becomes `[!456]`. Without `issue_url`, the server reads the PR/MR's source branch
and takes the issue number from its name, so reviewing an MR from `321-fix-timeout` produces
`[#321, !456]`.

Targets persist per session across plugin reloads. Calling `set_session_target` with
`target: "branch"` returns to branch-based naming. Child sessions and untitled sessions are
skipped.

### Several targets

A session can work on up to 50 issues and PRs/MRs at once, such as a set of related MRs
under review. Pass their full URLs in `targets` instead of `target`, and choose how they
change the current targets with `operation`:

| `operation`         | Effect                                                                         |
| ------------------- | ------------------------------------------------------------------------------ |
| `replace` (default) | Sets exactly the given targets.                                                |
| `add`               | Appends the given targets and keeps the current ones.                          |
| `remove`            | Drops the given targets. Removing the last one returns to branch-based naming. |

```json
{
  "targets": [
    "https://gitlab.com/group/project/-/merge_requests/101",
    "https://gitlab.com/group/other/-/merge_requests/102"
  ],
  "operation": "add"
}
```

The server normalizes and deduplicates the URLs, which can come from different projects.

With `targets`, `issue_url` relates every listed target to the same issue, such as a set of
MRs for one issue. Every target must then be a PR/MR from the issue's forge. With
`operation: "add"`, only the added targets get the issue.

The agent guidance is generic. When you ask the agent to work on several issues or PRs/MRs,
it sets all of them as targets. If you describe them instead of linking them, the agent
finds them first, then sets them. After it creates a PR/MR for a task with several targets,
it adds the new one instead of replacing the others.

With several targets, the title prefix lists their own references, such as `[!101, !102]`.
When every target has the same related issue, from `issue_url` or from its source branch
name, the issue comes first, such as `[#12, !101, !102]`. More than four targets list the
first three and count the rest, such as `[!101, !102, !103, +3]`.

Target URLs can name a GitLab MR, issue, or work item on any host, or a GitHub PR or issue.
GitHub URLs are accepted on any host that isn't recognizably GitLab, so GitHub Enterprise
targets work.

## Branch-based naming

Without an explicit target, the title follows the checked-out branch:

1. The prefix starts with the issue number from the branch name, or the branch name
   without one.
2. It adds the newest open PR/MR from the branch, or `!N/A` (GitLab) or `#N/A` (GitHub)
   until one exists.

The title is reconciled after target changes, title changes, and successful agent runs.
Text you add to the title, including your own bracketed prefixes, is kept.

Branch names longer than 40 characters are shortened with an ellipsis in the prefix. Titles
stay within 100 characters by shortening the text after the prefix, never the prefix
itself, so the plugin can still find and replace its prefix later.

The default branch and branches named `main`, `master`, `develop`, or `HEAD` get no prefix.

The branch's remote, pushed branch name, and forge come from the same repository discovery
as the status footer. That discovery uses the branch's push or upstream remote, recognizes
forks, and classifies hosts with the `hosts` and `githubHosts` options.

| Pattern                           | Example branch          | Issue |
| --------------------------------- | ----------------------- | ----- |
| `<prefix>/<number>-<description>` | `feature/123-add-login` | `123` |
| `<number>-<description>`          | `123-fix-typo`          | `123` |
| `<description>-<number>`          | `fix-typo-123`          | `123` |
| `<prefix>/<number>/<description>` | `user/123/some-work`    | `123` |
| `issue-<number>`, `gh-<number>`   | `gh-42-improve-perf`    | `42`  |
| `fix-<number>`, `feat-<number>`   | `fix-99`                | `99`  |

## Status footer

The server picks each session's PRs/MRs in this order:

1. The explicit targets.
1. A PR/MR number in a title prefix that you wrote, such as `!456` in `[!456] Review`.
1. The checked-out branch's open PRs/MRs.

A prefix that the plugin wrote from the branch doesn't count as a title reference, so the
footer follows the branch when its PR/MR closes and another opens. The title prefix itself
reuses a branch's PR/MR number for up to 10 minutes.

Explicit targets that aren't PRs/MRs, such as issues, show no status. Unresolved explicit
PRs/MRs never fall back to the branch.

Without a PR/MR to show, the footer stays empty, even when a lookup fails, such as in a new
session before the server answers. It shows `PR/MR status unavailable` only when none of
the session's explicit PR/MR targets can be looked up or found. `/forge-status` explains
why.

The server runs at most four `glab` or `gh` commands at once for status and review
feedback, across all sessions. When some target lookups fail, the footer shows the others
and counts the failures as `N unavailable`. A target whose lookup failed with an error
keeps its previous status until a later poll succeeds. A GitLab response that reports an
error counts as a failed lookup, never as a missing MR, so it's retried with backoff.

When the CLI can't reach the server, such as while the server plugin reloads, the footer
keeps the last status and marks it `stale`. The CLI never looks PRs/MRs up itself, so it
can't show another project's PR/MR with the same number as a target.

With several PR/MR targets, the footer shows counts instead of one PR/MR's status, such as
`5 MRs · 🤖 2 reviewing · 1 CI failed · 1 conflict · 1 merged`. Clicking it opens the
status dialog, which lists each PR/MR.

The footer shows checks or the pipeline, unresolved threads, conflicts, approval, and a
running automated review, from GitLab Duo or GitHub Copilot. GitHub also shows a requested
change. Unknown mergeability stays unknown rather than appearing conflict-free.

The footer shows `approved` only when GitLab reports that approval requirements are met,
at least one person approved, and every human reviewer approved. Bot approvals, such as
Duo's, don't count. While human reviewers haven't approved, it shows `awaiting @username`,
or `awaiting N reviewers` for more than two.

Clicking the PR/MR number or pipeline opens it in the browser. Clicking any other indicator
opens the status dialog. These commands are also available from the command palette:

- `/forge-status` opens a dialog with full status and a refresh action. Aliases:
  `/mr-status` and `/pr-status`.
- `/forge-open` opens the PR/MR in the browser. Aliases: `/mr-open` and `/pr-open`.

The server caches each session's status and polls every 2 minutes while a CLI shows an open
PR/MR, or every 30 seconds while an automated review runs. Each change reaches the CLIs as
an RPC event.

### Which sessions the server watches

The server watches only sessions that a CLI has shown since it started. The CLI renews a
lease on each of them every minute, and a lease that isn't renewed for 3 minutes ends, such
as after the CLI exits. A session keeps polling while it's on screen in any CLI. A hidden
session with a lease keeps polling while it has a running automated review, human feedback
to watch, or a notification to retry.

A hidden session that the server hasn't looked up yet, such as after the server plugin
reloads, is looked up once to find out whether it has reviews to watch. A target change
also looks up a hidden session that isn't polling.

Each checkout's server plugin instance watches only the sessions in that checkout. When a
session moves to another worktree, the CLI moves its lease to that checkout's instance. The
old instance stops watching the session, even if another CLI still leases it there. Before
each notification, the server reads the session again, so a session that moved while a
lookup or fetch ran is left to its new checkout. A review that finishes during the move can
go unannounced, because the new instance never saw it running. If the session can't be
read, the notification is retried later instead of being dropped.

After that read, the server checks the targets again and writes the message for the
PRs/MRs that are still targets. A target removed in the meantime isn't mentioned.

When the server plugin stops, such as on a reload, no new lookup, fetch, notification,
title update, or target change starts, and queued `glab` and `gh` commands don't run. A
title update that is still looking up its branch doesn't rename the session or store
anything, because the replacement instance owns the session's state by then. Notifications
that were already being sent can finish and store their outcome, so the replacement instance
doesn't send them again. Cleanup waits up to 5 seconds for them. One that takes longer may be
sent again.

## Review notifications

For each explicit target that is an open PR/MR, the server tells the agent about reviews.
A target that merges or closes gets no more notifications, and a notification waiting for a
retry is dropped.
Each notification is a queued synthetic message, followed by a toast in the CLIs that have
shown the session. The message resumes the session unless `resumeSession` is `false`.
Messages include the full URL of each PR/MR. PRs/MRs from the title or the branch don't get
notifications.

Before it sends a notification, the server checks that the PR/MR is still one of the
session's targets. A lookup that started before the targets changed is discarded, so a
removed target never triggers a notification.

| Notification                               | GitLab      | GitHub         |
| ------------------------------------------ | ----------- | -------------- |
| An automated review finished with feedback | GitLab Duo  | GitHub Copilot |
| New human review feedback                  | MR comments | PR comments    |

- **Automated reviews**: for GitLab, Duo's final state of `REVIEWED` or `REQUESTED_CHANGES`
  asks the agent to read its comments. Other final states, such as `APPROVED`, send nothing.
  The server notifies when it sees a review go from running to finished, so a Duo review
  that finished before the server first saw it running isn't announced. Reviews that finish
  in the same poll share one message.
- **Copilot reviews**: the server notifies when a submitted, undismissed review has at least
  one inline comment. A review without inline comments, such as one that
  found nothing or couldn't run for lack of quota, sends nothing. Copilot reviews are
  identified, so a review that started and finished between two polls is announced too. A
  review that the server finds on a PR's first look isn't announced. Observed and delivered
  review IDs persist across restarts. A completed review can be announced while another
  review is requested.
- **Human reviews**: new comments and replies from people other than you and bots are
  announced once none of their unresolved comments has changed for 5 minutes. Expect one
  message 5 to 7 minutes after the review goes quiet. Resolved threads are skipped.

The first look at a PR/MR records its newest comment as a baseline, so older comments never
count as new. Announced comments are stored per session and PR/MR, so a restart replays
nothing but still catches comments posted in the meantime.

A failed send shows an error toast and is retried after 10 minutes. A failed automated
review notification stays pending in the server's storage, so it's retried even after a
restart, as long as the review still has feedback and the PR/MR is still an open target.

Every checkout's server plugin instance shares the plugin's storage, so each baseline and
each pending notification has its own storage key. Instances never overwrite each other's
records. A failed storage write shows an error toast once.

On GitLab, the server reads the newest 2,000 comments. On busier MRs, edits to older
comments don't count as activity.

On GitHub, the server reads three lists: conversation comments, the text of submitted
reviews, and the inline comments of review threads. It keeps the newest 2,000 of each.
It scans every thread to include recent replies in old threads, within a limit of 200 API
requests per fetch. If it cannot complete that scan, it defers notifications until a complete
fetch succeeds. Review text counts when it isn't empty, whether the
review approves, requests changes, or only comments. Comments from GitHub Apps, such as
Copilot, count as bots. Hidden comments and unsubmitted review comments are skipped.
The baseline also records comment IDs at its timestamp, so a new comment posted in the same
second can still be announced. Baselines stored by older plugin versions retain their
timestamp-only behavior until a new baseline is created.

## Options

Set options with the object form of the `plugins` entry in `opencode.json`:

```json
{
  "plugins": [{ "package": "opencode-forgekeeper", "options": { "notifyHumanReviews": false } }]
}
```

| Option                   | Default          | Description                                                                                                                        |
| ------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `reviewStatus`           | `true`           | Show the PR/MR status and notify the agent about reviews. Set to `false` to keep only session targets and titles.                  |
| `hosts`                  | `["gitlab.com"]` | GitLab hosts whose remotes are recognized, besides hosts named `gitlab.*`.                                                         |
| `githubHosts`            | `["github.com"]` | GitHub hosts, including GitHub Enterprise hosts.                                                                                   |
| `pollSeconds`            | `120`            | Normal polling interval. Running automated reviews poll at 30 seconds or this value, whichever is lower.                           |
| `notifyAutomatedReviews` | `true`           | Tell the agent when an automated review finishes with feedback. The former name, `notifyDuoReview`, still works.                   |
| `notifyHumanReviews`     | `true`           | Tell the agent about new human review feedback.                                                                                    |
| `resumeSession`          | `true`           | Resume the session when telling the agent about a review. Set to `false` to queue the message for the session's next turn instead. |

The server entry point reads every option, so changing one takes effect when the server
plugin reloads. The CLI has no options of its own. Each checkout's server reads the
options for its location, so the CLI can show status in one project and not in another.

### Keep only session titles

To keep the behavior of `opencode-forge-session-title` alone, turn off review status:

```json
{
  "plugins": [{ "package": "opencode-forgekeeper", "options": { "reviewStatus": false } }]
}
```

The server still registers `set_session_target`, adds the agent guidance, and maintains the
title prefix. It doesn't poll or send review notifications, and the CLI shows no footer.
`/forge-status` and `/forge-open` explain that the status is off.

## RPC

The server registers an [RPC](https://opencode.ai/v2/docs/build/plugins/rpc) with the ID
`opencode-forgekeeper`, defined in `src/rpc.ts`. The CLI uses it, and other plugins can call
`target` and listen for `targetChanged`:

- `target({ sessionID })` returns `{ url, issueUrl?, targets }` for explicit targets, and
  `{}` in branch mode. `targets` lists every target as `{ url, issueUrl? }`. `url` and
  `issueUrl` describe the first target, for callers that expect a single target.
- `watch({ clientID, keys, visible? })` renews the caller's leases on `keys` and returns
  `{ enabled, statuses }`. A key is a session ID, or `""` for the checkout outside a
  session. `visible` is the key on screen.
- `release({ clientID })` drops the caller's leases.
- `refresh({ key })` looks the key up now and returns `{ enabled, snapshot }`.
- `targetChanged` fires after `set_session_target` runs, with the same fields as `target`
  and the `sessionID`. It has only the `sessionID` in branch mode.
- `status` fires with `{ directory, key, snapshot }` when a key's status changes.
- `notice` fires with `{ sessionID?, title?, message, variant }` for the CLIs to show as a
  toast.

Keys are relative to the location of the call or event, because each checkout's server
plugin instance watches its own sessions.

## Migrating from opencode-forge-session-title

Replace `opencode-forge-session-title` with `opencode-forgekeeper` in `opencode.json`. Upgrading
from `opencode-forgekeeper` 1.x works the same way, because 1.x used the same IDs as
`opencode-forge-session-title`.

| Entry point | Plugin ID                   | Stored state                                                                             |
| ----------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| Server      | `opencode-forgekeeper`      | Session targets, owned title prefixes, human-review baselines, and pending notifications |
| CLI         | `pedropombeiro.forgekeeper` | None                                                                                     |

OpenCode scopes plugin storage by plugin ID, so nothing stored under the former ID,
`opencode-forge-session-title`, carries over:

- Sessions start in branch-based naming. Ask the agent to set their targets again.
- A title that kept a single-reference prefix from before, such as `[!456] Review`, now looks
  like a reference that you wrote. Until you set a target, the status follows that PR/MR, labeled
  "from the session title". Setting a target adds a second prefix, such as
  `[#12, !45] [!456] Review`. Remove the older prefix by hand. Older prefixes with two
  references, such as `[#12, !45]`, are replaced automatically.
- The first look at each PR/MR records a new review baseline, so comments posted before then
  aren't announced.
- Callers of the RPC need the new ID, `opencode-forgekeeper`.

With default options, the new footer and review notifications start right away, and
notifications resume the session. Set `reviewStatus` to `false` to keep only titles, or
`resumeSession` to `false` to queue notifications for the next turn.

## Code layout

- `src/index.ts` wires the server: the forge catalogs from the options, with a shared
  concurrency limit for status, and title lookups.
- `src/server.ts` registers the tool, the agent guidance, title reconciliation, and the RPC.
- `src/status-server.ts` connects the status service to sessions, storage, notifications,
  and RPC events. `src/status-service.ts` holds the leases and decides which keys poll.
- `src/target.ts` parses, normalizes, changes, and formats session targets, and matches
  forge URLs against them.
- `src/limit.ts` bounds how many forge requests run at once.
- `src/title.ts` extracts branch issue numbers and reconciles title prefixes.
- `src/options.ts` reads the plugin's status options.
- `src/lookups.ts` answers the title's forge questions: the branch's newest PR/MR number
  and a PR/MR's source branch.
- `src/status-client.ts` holds the CLI's leases, snapshots, and per-directory settings.
  `src/tui.tsx` connects it to the RPC and renders the footer, dialog, commands, and notices.
- `src/forge.ts` defines the forge-neutral types, the `Forge` adapter interface, and
  `ForgeTraits` with its optional `automatedReview` and `feedback` capabilities.
- `src/gitlab-feedback.ts` and `src/github-feedback.ts` read each forge's comments for its
  `feedback` capability.
- `src/gitlab.ts` and `src/github.ts` provide each forge's adapter and traits. Adapters own
  API calls, pagination, error classification, and status normalization. Traits cover
  everything else: hosts, URL parsing, reference syntax, vocabulary, and forge-specific
  footer and dialog content.
- `src/forges.ts` registers each forge's traits, classifies hosts, opens adapters, and
  parses URLs.
- `src/git.ts` resolves a checkout's remotes, branch, and pushed branch name.
- `src/locate.ts` picks each key's PRs/MRs. `src/store.ts` caches lookups, polls, backs off
  after failures, and discards lookups that started before a change. `src/format.ts`
  renders the footer and dialog.
- `src/automated-review-watch.ts` and `src/human-review-watch.ts` decide when to notify the
  agent.

Shared code never compares a forge against a specific name. It asks the forge's traits, or
checks for a capability, instead. To add a forge, add its kind to `ForgeKind` and
`ReviewRequest`, implement `Forge` and `ForgeTraits`, and register the traits in
`src/forges.ts`.

## Development

From the repository root:

```bash
mise run test
mise run typecheck
mise run lint
mise run build forgekeeper
```

## License

[MIT](../../LICENSE)
