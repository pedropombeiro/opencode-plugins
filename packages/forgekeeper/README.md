# opencode-forgekeeper

An [OpenCode](https://opencode.ai) plugin that tracks the issues or PRs/MRs a session works on.
It prefixes the session title with their references, shows the PR/MR status in the prompt
footer, and surfaces new review feedback in a persistent inbox. It supports GitLab and GitHub. The status
and review notifications are optional; see [Keep only session titles](#keep-only-session-titles).

Requires OpenCode 2.2 or later. It replaces
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
context. The current target is stored in the `forgekeeper-session-target` session instruction
entry. Updates take effect at the next step without changing the system prompt.
When you establish or change the primary issue, PR, or MR, the agent sets its full
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

Sessions in the same checkout share cached status and human-feedback fetches for the same
forge, host, project, and PR/MR number. Overlapping requests share one in-flight fetch.
Successful status results remain fresh for the polling interval, capped at 30 seconds
while an automated review runs. Complete human-feedback results remain fresh for 60 seconds.
Failures and incomplete feedback are not retained for reuse. Each cache keeps at most
1,000 entries and is cleared when the plugin stops.

Session timers, review baselines, and acknowledgements remain independent. Manual refresh
invalidates the selected session's target caches and feedback fetch timestamps. Completed turns invalidate the checkout's caches
before notifying watched sessions, so changes such as pushes can be observed. Caches are
not shared between checkouts, whose CLI credentials and repository context may differ.

### Which sessions the server watches

The server discovers recent sessions at startup, every 5 minutes, and after target changes
or completed turns. A session qualifies when it is a non-archived root session in the
checkout, has an explicit PR/MR target, and has a user message in the last 72 hours.
A compaction drops earlier messages from the session's context, so when the context has no
user message, the newest compaction counts instead, since compactions run only during
turns. Viewing a tab, changing its title, or receiving a background notification does not
extend that window. Sessions without readable conversation activity are skipped. Discovery
reads conversation timestamps locally; it does not send conversations to a model.

Discovered sessions poll without a CLI lease while at least one explicit target is open.
Targets that couldn't be resolved, such as while the forge returns nothing for them, keep
being retried with the same backoff as failed lookups. When all targets close or merge,
polling stops. Discovery reevaluates the activity window
every 5 minutes. It runs only while OpenCode has this checkout's plugin instance loaded;
it is not a separate scheduler and cannot wake an unloaded location or stopped service.

The server also watches sessions that a CLI has shown since it started. The CLI renews a
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

After that read, the server checks the targets again and records feedback for the
PRs/MRs that are still targets. A target removed in the meantime isn't mentioned.

When the server plugin stops, such as on a reload, no new lookup, fetch, notification,
title update, or target change starts, and queued `glab` and `gh` commands don't run. A
title update that is still looking up its branch doesn't rename the session or store
anything, because the replacement instance owns the session's state by then. Notifications
that were already being sent can finish and store their outcome, so the replacement instance
doesn't send them again. Cleanup waits up to 5 seconds for them. One that takes longer may be
sent again.

## Review notifications

For each explicit target that is an open PR/MR, the server records new review feedback.
A target that merges or closes gets no more notifications, and a notification waiting for a
retry is dropped.
Feedback goes to a persistent inbox. The `reviewFeedbackDelivery` option sets what else
an update does:

- `inbox`, the default, posts nothing to the session.
- `passive` queues a session message with `resume: false`, which starts no turn. It
  doesn't mark the session unread, because the TUI marks sessions unread only when a
  turn ends. When something else wakes the session, the message can run as its own
  step; Forgekeeper then sends only the notice, without tools or the session's history.
- `summary` queues a message that starts a summary turn, described below. A turn that
  ends marks the session unread. Updates without comments, such as Copilot reviews,
  get a passive message instead.

Session messages contain the notification title, when the newest comment was written, and
links, not review bodies or instructions to act. Updates without comments, such as Copilot
reviews, show when Forgekeeper detected them instead. Times are absolute and local, with
their time zone, such as `Oct 28, 2026 at 3:25 PM GMT+1`, so they stay accurate in the
session's history. `/forge-feedback` shows the same time, and a summary starts by saying it.

Each update keeps the mode it was recorded in, so changing `reviewFeedbackDelivery`
affects later updates only: switching to `summary` never starts turns for updates already
in the inbox. Summarize those with Ctrl+R instead. Stable message IDs deduplicate
automatic retries, including after reloads. Updates that haven't reached their session are
retried every minute and after a reload, each on its own, so one that keeps failing doesn't
hold the others back. Delivery doesn't hold up the inbox: `/forge-feedback`, pausing, and
acknowledging work while a summary reads its comments, and an update in flight isn't sent
again by a retry. An update whose session was deleted, archived, or moved, or that no
longer targets the PR/MR, is dropped, including when that changed while its comments were
read. Switching `reviewFeedbackDelivery` to `inbox` stops retries of review updates, and
leaves them undelivered, so they go again once it's switched back. Merge request updates
follow `lifecycleDelivery` the same way. A summary requested from `/forge-feedback` is a
new request each time.

### Summary turns

A summary turn runs after any active turn finishes, including its tool calls. Forgekeeper
reads the announced comments, at most 20 of them and 4,000 characters each, with context
the summary can't fetch itself:

- Earlier replies in each comment's thread, at most 5 of 1,000 characters each. GitHub
  provides only the comment a reply answers.
- The code an inline comment is on, at most 3,000 characters. On GitLab, that's 10 lines
  on either side of the commented line, from the MR's head commit, or from its base commit
  for a removed line, for at most 10 files. On GitHub, it's the end of the diff hunk. A
  file that can't be read leaves out only its code.

The PR/MR's author wrote that code, so the summary treats it as untrusted, like the
comments. Forgekeeper keeps all of this in plugin storage until the next user prompt, or for
at most 7 days. It never enters the session's history, where later turns with tools could
read it.

#### Linked notes

On GitLab, review comments often link to supporting notes, such as an issue in another
project with further details. A summary can read those with one tool,
`fetch_linked_review_note(url)`, which accepts only links that the announced comments'
own text contains:

- HTTPS links without credentials or a port, on the MR's GitLab host, to an issue, work
  item, or MR note (`…/-/issues/1#note_2`). Notes in other projects count. Links in thread
  replies, in code, or in a linked note don't, so nothing a linked note says can widen
  what the summary reads.
- At most 5 links per summary, each at most 300 characters, without duplicates or links
  to the announced comments.

Forgekeeper stores these links with the summary's record before posting its message. The
tool reads a note with one fixed GraphQL query through `glab`, and keeps it only if the
note GitLab returns, of any note type, has the link's note ID and names the same project,
issue or MR, and note. GitLab returns nothing for notes you can't read. The model supplies
only the link: never a host, query, method, or header.

Each summary gets 5 calls. Every call counts, including repeats, refused links, and failed
reads, and is spent before the read, so neither concurrent calls nor a reload restore it.
A linked note keeps at most 4,000 characters, and all of them together at most 12,000.
The comments come first in the request's 40,000-character budget. Linked notes, with
their links and status lines, get only what the comments leave; notes that don't fit are
reported as left out, and without room for the readable links, the request offers no tool.

The tool returns only a receipt that names the link, which is what stays in the session's
history. The note's text goes to the summary's record, and from there only into the
summary's next requests, as a `<linked-note>` block. Every request that can hold linked
notes, including the last one, which has no tool, keeps the instructions that treat them
as untrusted like the comments.

The tool works only for the summary of the session's latest model request, and checks
the session's context again on each call, so a user prompt ends its access even before
the next request. A record older than 7 days counts as missing in every check, not just
at the next startup. After a reload, the tool refuses until the next request. A stopped
instance writes nothing, and cleanup waits for its calls, so a late call can't overwrite
the budget its replacement uses. Ordinary requests never include the tool, and summaries
without links, notices, and steps whose summary can't be read get no tools at all.
GitHub summaries don't read linked notes.

Forgekeeper recognizes a step whose input is one of its messages in two independent ways:

- Every message it posts ends with a tag naming its ID, such as
  `[forgekeeper:msg_forgekeeper_…]`, which the context hook finds in the request it's
  about to send. This doesn't depend on stored state, so a failed restore or an expired
  record can't let the message run as an ordinary request.
- It tracks every message it posts until a user prompt follows that message, and reads the
  session's context before each request. A message still in the queue stays tracked while
  earlier steps run, and a reminder sent after the message doesn't end its step.

Before each model request that either way identifies, its context hook:

- removes every tool from the request, except the linked-note tool while the summary has
  links left to read;
- replaces the system prompt with summary instructions that treat comments as untrusted;
- replaces the conversation with one message holding the comments and the linked notes
  read so far, or the notice, so the request resends neither the session's history nor
  the step's own tool calls;
- caps the output at 1,200 tokens.

If the review text is missing, such as after its record expired, the request asks for a
short reply saying so, still without tools or history. If the hook can't build the
replacement message, the request fails rather than keeping any of the session's messages.

As backstops, Forgekeeper refuses every tool execution other than the linked-note tool,
which checks its own calls and asks for no permissions, and every permission request,
while the session's latest model request was one of these, and treats a step it can't classify as
one, such as when the session's context can't be read, or when a compaction left no
input in it. The turn ends at the next user prompt. A later turn that another plugin starts
without a user prompt also runs without tools. The summary is the only part that stays in
the session's history.

`/forge-feedback` lists pending feedback for
the current checkout. Select an update to open its PR/MR or comment links, press Ctrl+D
to acknowledge it, press Ctrl+R to summarize it in its session in any delivery mode, or
press Ctrl+S to pause or resume review monitoring. Acknowledgement
only dismisses the local update; it does not reply to or resolve a remote discussion.
The home and session footers show the pending count, and connected CLIs in the checkout
show a toast even when the session's tab has never been visited.

An update leaves the inbox when you acknowledge it, or when it no longer needs attention:

- Once every comment it announced is resolved, by anyone. Comments that can't be resolved,
  such as GitLab comments outside a thread or GitHub review bodies, need acknowledging,
  and so do updates without comments, such as Copilot reviews.
- Once its PR/MR merges or closes, or its session stops targeting it.

Forgekeeper checks resolution and PR/MR state only for sessions it monitors. Resolution
counts only from a fetch that no later change made obsolete, and state only after a lookup
finishes, so a reload doesn't clear updates before the session's targets are known. A
target change clears that target's updates right away, whether or not Forgekeeper
monitors the session. Working on the feedback, with or without the agent, doesn't clear an
update by itself.

The inbox retains the newest 500 updates per checkout across plugin reloads. It stores
session IDs, target URLs, notification titles, comment URLs, and timestamps, not comment
bodies or credentials. A pause persists across reloads and leaves status display available.

PRs/MRs from the title or the branch don't get review notifications.

Before it sends a notification, the server checks that the PR/MR is still one of the
session's targets. A lookup that started before the targets changed is discarded, so a
removed target never triggers a notification.

| Notification                               | GitLab                           | GitHub         |
| ------------------------------------------ | -------------------------------- | -------------- |
| An automated review finished with feedback | GitLab Duo                       | GitHub Copilot |
| Comments from review bots                  | Security reviewers, `reviewBots` | `reviewBots`   |
| New human review feedback                  | MR comments                      | PR comments    |

- **Duo reviews**: new unresolved inline findings from the GitLab Duo bot create inbox
  updates after the findings remain unchanged for five minutes. Forgekeeper does not need
  to observe the review running. Summary-only reviews, approvals without inline findings,
  system notes, and resolved findings send nothing. Comment IDs persist independently of
  human feedback, including an empty baseline when monitoring starts without findings.
  Existing findings become the initial baseline; new findings posted while OpenCode is
  offline are detected after monitoring resumes if a baseline was already stored.
  When available, `duoCreatedSession.id` groups findings by code-review workflow run.
  A linked workflow must be terminal before delivery, and the watcher refetches before
  notifying. Older GitLab versions and permission-hidden workflows use comment IDs and
  the settling window without a workflow link. Separate runs use distinct inbox IDs.
- **Copilot reviews**: the server notifies when a submitted, undismissed review has at least
  one inline comment. A review without inline comments, such as one that
  found nothing or couldn't run for lack of quota, sends nothing. Copilot reviews are
  identified, so a review that started and finished between two polls is announced too. A
  review that the server finds on a PR's first look isn't announced. Observed and delivered
  review IDs persist across restarts. A completed review can be announced while another
  review is requested.
- **Human reviews**: new comments and replies from people other than you and bots are
  announced once none of their unresolved comments has changed for 5 minutes. Expect one
  update 5 to 7 minutes after the review goes quiet. Resolved threads are skipped.
- **Review bots**: comments from the bot accounts that `reviewBots` names are announced
  like human reviews, including comments without a file or line, such as a security
  review's findings. `reviewBots` maps each host to exact usernames, ignoring case. By
  default, it names GitLab.com's security reviewers for `gitlab-org`:

  ```json
  {
    "reviewBots": {
      "gitlab.com": ["duo-security-review-gitlab-org", "ai-appsec-security-mr-reviewer-gitlab-org"]
    }
  }
  ```

  Duo Security Review has one account per top-level group, so add yours, such as
  `duo-security-review-acme`, and a self-managed instance's accounts under its host. Your
  list replaces the defaults, and `{}` turns this off. Names have no wildcards, since a
  group owner can create a bot account with any free name, such as one that starts like
  a security reviewer's. Only accounts that the forge flags as bots count, and only on the
  host they're listed for. They count as automated reviews, so `notifyAutomatedReviews`
  controls them, whether or not `notifyHumanReviews` is on. GitLab Duo's code review
  findings always go through their own watcher instead. Internal notes, such as Duo
  Security Review's, count when your account can read them.

The first look at a PR/MR records its newest comment as a baseline, so older comments never
count as new. Announced comments are stored per session and PR/MR, so a restart replays
nothing but still catches comments posted in the meantime.

A failed send shows an error toast and is retried after 10 minutes. Failed Duo and human
feedback deliveries leave their comment IDs unannounced, so a restart can retry them.
Failed Copilot notifications stay pending in storage while the review still has feedback
and the PR remains an open target. Legacy state-only Duo pending notifications are discarded.

Every checkout's server plugin instance shares the plugin's storage, so each baseline and
each pending notification has its own storage key. Instances never overwrite each other's
records. A failed storage write shows an error toast once.

On GitLab, the server reads the newest 2,000 comments. On busier MRs, edits to older
comments don't count as activity.

### Live comment subscriptions

GitLab feedback monitoring attempts an outbound TLS WebSocket connection to the MR's host,
using GitLab's internal `Noteable::NotesChannel` Action Cable interface. Sessions targeting
the same MR share one subscription within a checkout. No webhook receiver or project
administration permission is required. This interface is not a public GraphQL subscription
and can differ across GitLab versions.

After the server confirms a subscription, comment events trigger a feedback fetch. Events
within a one-second window share a refresh. Quiet connections reconcile comments every
15 minutes, on the next scheduled status check. The five-minute settling window still
applies, and the watcher fetches again before delivering pending feedback. Initial connection
and reconnection also trigger a fetch to catch changes while disconnected.

GitHub and hosts that cannot establish a subscription keep polling. Connection failures,
rejections, and missing heartbeats restore normal feedback polling. Reconnection attempts
back off from 30 seconds to 15 minutes. Pausing feedback, removing the last session watching
an MR, or unloading the plugin closes its connection. Subscriptions only accelerate comment
monitoring; status, pipeline, and automated-review polling continue at their existing intervals.

On HTTP 429, subscription retries honor `Retry-After` and GitLab's `RateLimit-Reset` and
`RateLimit-ResetTime` headers, even when the wait exceeds 15 minutes. The cooldown applies
to all MR subscriptions on that origin within the checkout and survives removing and
re-adding a target during the plugin instance's lifetime. Other origins remain independent.
Bun's native WebSocket client hides rejected-handshake headers, so a failed handshake
triggers one HTTP upgrade probe with a 10-second timeout and redirects disabled. The probe
reads the reset headers and discards the body. A 429 without usable headers delays retries
by at least one minute. Normal authenticated API polling continues during this subscription
cooldown.

GitLab can classify bearer-authenticated `/-/cable` requests as unauthenticated for rate
limiting: its rate-limit authentication checks API and feed routes, while Action Cable
authenticates the bearer token later. A valid API token therefore does not necessarily
avoid the unauthenticated per-IP limit on this route.

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

## Merge request updates

Forgekeeper also watches each session's explicit PR/MR targets for three changes:

- **Conflicts:** a target that could merge starts to conflict with its target branch.
- **Failed jobs:** a job fails in a target's head pipeline, even while the pipeline still
  runs.
- **Merges:** a target merges.

All come from the forge's own state, compared between two lookups, never from comments
such as GitLab's "can no longer be merged" note. The first lookup of a target only records
it, so nothing that happened earlier is announced, including after a restart. A
mergeability the forge hasn't settled yet, such as while GitLab rechecks an MR after a
push, keeps the last known state. A conflict that ends and starts again is a new update.
Sessions are watched the same way as for review feedback, without visiting their tabs.

Failed jobs don't wait for the pipeline to finish, which can take much longer than the
job. Each lookup reads the pipeline's failed jobs:

- On GitLab, the first 10 failed jobs that aren't retried, with the MR, and no other
  query. One that isn't allowed to fail is enough to know the pipeline fails. When all
  10 are allowed to fail and more failed, an unread one may fail the pipeline, but none
  counts as failing it while the pipeline runs. Once the pipeline finishes as failed,
  which jobs allowed to fail never cause, the update reports that a job past those 10
  failed it.
- On GitHub, the head commit's failed checks, which count as one pipeline.

Each job attempt counts once. A lookup that finds new failed jobs makes one update for
them, which names and links them, lists the jobs that failed earlier in that pipeline,
and says whether the pipeline still runs. That update replaces the pipeline's earlier one
in the inbox, and reaches the session again. A retry that fails again is a new attempt,
so it's a new failure. Forgekeeper remembers the newest 500 attempts it saw in a pipeline,
so one that newer failures push past the jobs it reads isn't new when it comes back.
Another pipeline that fails, such as after a push, is new too. At
most 10 jobs are named, and more are counted. Records stored before Forgekeeper told job
attempts apart only record the jobs, without an update. The update clears once the
pipeline no longer has failed jobs, another pipeline replaces it, or the PR/MR closes.
Forgekeeper only reports failed jobs: it doesn't retry or fix them.

Each change waits in the target's record until it reaches the inbox, in the same storage
write as the record. A merge stops polling, so waiting changes are retried every minute
and after a reload, without another lookup. Updates go to `/forge-feedback`, and
`lifecycleDelivery` sets what else they do: `"inbox"`, the default, `"passive"`, or
`"summary"`, as for [review feedback](#review-notifications). Each change keeps the mode
from when it was detected, so turning on summaries never starts turns for changes found
earlier. A summary turn has no tools, and gets only Forgekeeper's facts about the change,
never comments.

A conflict update clears once the conflict ends or the PR/MR closes. A merge update stays
until you acknowledge it, because the merge is the news. Updates for targets the session
drops clear right away. Turning `notifyLifecycle` off stops all three kinds.

### Stacked PRs/MRs

A target **builds on** another of the session's targets when it targets that one's source
branch in the same project, on the same host. Forgekeeper links them only when exactly one
target matches, and keeps the link once the parent merges, because forges may retarget the
dependent PR/MR or delete the merged branch at that point. Sharing a session doesn't make
two PRs/MRs a stack.

When a parent merges, its update lists each dependent, and `lifecycleExecution.parentMerged`
sets what Forgekeeper does about them:

| Mode        | What happens                                                                         |
| ----------- | ------------------------------------------------------------------------------------ |
| `"notify"`  | The default. The update names the dependents and the branch they target.             |
| `"prepare"` | Forgekeeper reads each dependent again and says how it would retarget it, if at all. |
| `"apply"`   | It also retargets them, but only with `"actions": ["retarget"]`.                     |

```json
{
  "lifecycleExecution": { "parentMerged": { "mode": "apply", "actions": ["retarget"] } }
}
```

Forgekeeper retargets a dependent to the branch the parent merged into, and only when it
still targets the parent's source branch in the same project. It reads the dependent from
the forge right before and after, so one the forge already retargeted counts as done, and
one that targets something else, closed, or merged keeps its target. A parent from a fork
isn't retargeted to, since its branch lives in another project.

Only dependents the session still targets count. Right before the change, Forgekeeper
checks again that the session exists, isn't archived, belongs to this checkout, and still
targets the dependent, so one dropped while it was read keeps its target.

Each retarget's progress is stored: a reload doesn't repeat a finished one, and a retarget
whose response was lost counts as done once the dependent targets the new branch. A failed
read or retarget is tried again every minute and after a reload, at most 3 times, failed
reads included. Until then, the merge's update waits, so it reports the outcome. After the
last attempt, the update reports the failure. A reload during the last attempt doesn't
earn another: Forgekeeper only reads the dependent again to report what that attempt did. The update's details report each outcome.

This is Forgekeeper's own action, through one fixed forge operation: no model or agent
tool takes part, and nothing touches your checkout, so it doesn't wait for the session to
be idle. It changes no reviewers, assignments, or discussions, and never merges anything.
Each event keeps the policy it happened under, and the stricter of that and the current
policy applies, so enabling `apply` never acts on earlier merges. GitLab supports
retargeting; GitHub dependents get a proposal instead. GitLab has no conditional update,
so a change made in the moment between Forgekeeper's read and its retarget is
overwritten; the read afterwards reports what the MR targets then.

`lifecycleExecution.conflict` supports only `"notify"` for now. Preparing or resolving
conflicts needs your checkout, so it needs a lock across OpenCode instances and a way to
tie tool calls to their step, which OpenCode's plugin API doesn't provide yet. An invalid or
unsupported policy, such as `"apply"` without actions, falls back to `"notify"`, and
Forgekeeper shows an error toast saying which options it ignored.

## Options

### Monitoring security boundary

Monitoring uses the existing authenticated `gh` and `glab` clients for fixed read-only
GraphQL queries and GitLab MR REST lookups. GitLab subscriptions read the host's token with
`glab config get token --host` and send it in the WebSocket authorization header over TLS.
Tokens are not stored in plugin storage or included in URLs. Subprocesses use argument arrays
rather than shell interpolation, share
the existing concurrency limit of four, and time out after 30 seconds. Their credentials
and environment are those of the OpenCode service; monitoring does not provide OS-level
isolation or reduce those credentials' scopes.

The `inbox` and `passive` modes never invoke a model. The `summary` mode sends review
text to the session's model in a request whose only possible tool reads GitLab notes that
the comments link to, as described in [Linked notes](#linked-notes). It reads with your
`glab` credentials, so it can read private notes in other projects on the same host that
those links name. No mode executes commands from
review content, edits repository files, commits, pushes, posts replies, or resolves
discussions.

The one change Forgekeeper makes on a forge is retargeting a stacked MR after its parent
merges, and only with `lifecycleExecution.parentMerged` set to `"apply"` with the
`retarget` action. It uses GitLab's `mergeRequestUpdate` mutation with only the target
branch, through your `glab` credentials. See [Stacked PRs/MRs](#stacked-prsmrs).
Comment links are opened only after user selection and must use HTTPS on the target's
origin without embedded credentials. Review bodies remain external data, not trusted
instructions. Analysis and remediation are outside this feature's scope.

Pending updates are stored locally through OpenCode's plugin storage. Conversation history
is inspected locally only to find the latest user-message timestamp, with at most four
session checks in flight. The 72-hour window limits monitoring eligibility, not access
rights. OpenCode's provider, integration, and organization policies still apply. This
implementation has not received AppSec approval.

Set options with the object form of the `plugins` entry in `opencode.json`:

```json
{
  "plugins": [{ "package": "opencode-forgekeeper", "options": { "notifyHumanReviews": false } }]
}
```

| Option                   | Default                       | Description                                                                                                                    |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `reviewStatus`           | `true`                        | Show the PR/MR status and monitor review feedback. Set to `false` to keep only session targets and titles.                     |
| `hosts`                  | `["gitlab.com"]`              | GitLab hosts whose remotes are recognized, besides hosts named `gitlab.*`.                                                     |
| `githubHosts`            | `["github.com"]`              | GitHub hosts, including GitHub Enterprise hosts.                                                                               |
| `pollSeconds`            | `120`                         | Normal polling interval. Running automated reviews poll at 30 seconds or this value, whichever is lower.                       |
| `notifyAutomatedReviews` | `true`                        | Surface automated reviews that finish with feedback. The former name, `notifyDuoReview`, still works.                          |
| `notifyHumanReviews`     | `true`                        | Surface new human review feedback.                                                                                             |
| `reviewBots`             | GitLab.com security reviewers | Bot accounts whose comments count as review feedback, by host, with exact usernames. See [Review bots](#review-notifications). |
| `reviewFeedbackDelivery` | `"inbox"`                     | What an update does besides entering the inbox: `"inbox"`, `"passive"`, or `"summary"`. See [Summary turns](#summary-turns).   |
| `notifyLifecycle`        | `true`                        | Surface targets that start to conflict, get failed jobs, or merge. See [Merge request updates](#merge-request-updates).        |
| `lifecycleDelivery`      | `"inbox"`                     | What a merge request update does besides entering the inbox: `"inbox"`, `"passive"`, or `"summary"`.                           |
| `lifecycleExecution`     | all `"notify"`                | What Forgekeeper does about each event: `parentMerged` and `conflict`. See [Stacked PRs/MRs](#stacked-prsmrs).                 |

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

A summary or notice that Forgekeeper queued before you turned review status off can still
start a step. That step still runs without tools, history, or permissions. It doesn't read
the review text: it only says the text is unavailable.

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
- `feedback({})` returns `{ items, paused }` for this checkout's pending feedback.
- `acknowledgeFeedback({ id })` dismisses a local update and returns the updated inbox.
- `summarizeFeedback({ id })` starts a summary turn for an update in its session.
- `monitoringStatus({ sessionID })` reports, without changing anything, whether the
  session is monitored, and each target's fetch health and subscription state.
- `pauseFeedback({ paused })` persists the checkout's review-monitoring pause state.
- `feedbackChanged` fires with `{ directory }` when the inbox or pause state changes.
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

With default options, the footer and review monitoring start right away. All notifications
stay in the feedback inbox, and no session turn starts unless you set
`reviewFeedbackDelivery` to `"summary"`. The former `resumeSession` option has
been removed; saved values have no effect. Set `reviewStatus` to `false` to keep only titles.

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
  `ForgeTraits` with its optional `automatedReview`, `feedback`, and `lifecycle`
  capabilities.
- `src/adapters/gitlab/feedback.ts` and `src/adapters/github/feedback.ts` read each forge's
  comments for its `feedback` capability.
- `src/adapters/gitlab/adapter.ts` and `src/adapters/github/adapter.ts` provide each forge's
  adapter and traits. Adapters own API calls, pagination, error classification, and status
  normalization. Traits cover
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
- `src/lifecycle-watch.ts` finds conflicts, failed jobs, merges, and stack links between lookups, and
  keeps each event until it reaches the inbox. `src/lifecycle-execution.ts` works out and
  carries out retargets of stacked PRs/MRs.
- `src/adapters/gitlab/linked-notes.ts` finds and reads the notes review comments link to.

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
