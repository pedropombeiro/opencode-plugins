# opencode-session-finder

An [OpenCode](https://opencode.ai) plugin that searches the text of previous sessions. It adds
a **Search sessions** command to the terminal interface, and gives the agent a `search_sessions`
tool to find sessions and an `open_session` tool to switch to them.

The OpenCode session list matches titles only. This plugin reads the messages of every session
in the local database.

Requires OpenCode 2.

## Search from the terminal

Open the search with **`<leader>f`** (**Ctrl+X**, then **F**), from the command palette
(**Ctrl+P**) as **Search sessions**, or with `/search-session <keyword or sentence>`.

- Without arguments, the command asks for a keyword or sentence. A search takes several
  seconds on a large database, longer when it falls back to tool output.
- The results open in a searchable list, with sessions of the current project first. Each entry
  shows the date of its last match and an excerpt, plus the directory for sessions of other
  projects. The title notes when the results come from a fallback search.
- **Enter** focuses the session's tab, or switches to it for child sessions or when tabs are
  off. Sessions of other projects stay closed, and a toast shows the
  `opencode --session <id>` command to reopen them.
- **Ctrl+S** (**Summarize here**) queues a prompt in the current session that asks the agent to
  read the session's matches with `search_sessions` and summarize them.
- When nothing matches, a toast lists the searches that ran.

The search excludes the session on screen and shows at most 30 sessions.

## Search with the agent

Ask the agent which earlier session discussed something. It calls `search_sessions`, presents
the matches, and offers to open one, summarize it, or show more matches.

`search_sessions` accepts these options besides `query`:

| Option                         | Effect                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `words`                        | Matches sessions that contain every word, in any message.                                         |
| `include`                      | Also searches `tools` (commands, file reads, and tool output), `reasoning`, or `system` messages. |
| `fallback`                     | Set to `false` to run only the requested search.                                                  |
| `session_id`                   | Searches one session, for example to read more of its matches.                                    |
| `directory`                    | Searches sessions in a directory and its subdirectories.                                          |
| `current_project`              | Searches sessions of the current project, including its other worktrees.                          |
| `since`, `until`               | Limits matches to a date range (`YYYY-MM-DD`). `until` excludes that day.                         |
| `limit`, `excerpts`, `context` | Sets the number of sessions (10), excerpts per session (3), and characters around a match (100).  |
| `include_current`              | Also searches the calling session.                                                                |

User messages, assistant replies, compaction summaries, and titles are always searched.
Matching is literal and case-insensitive. When a search finds nothing, it's retried with
`words` for a multi-word query, then with tool output included.

`open_session` focuses another session of the current project in the terminal that shows the
calling session. Pass `close_source: true` to close the calling session's tab afterward. Closing
a tab keeps the conversation in history. The tool fails for sessions of other projects, and
after 3 seconds when no terminal shows the calling session.

## How it works

The server plugin reads the OpenCode database read-only with `bun:sqlite`, in a worker thread
so a long search doesn't block other sessions. The terminal interface asks the server to run
its searches, so a terminal attached to a remote server searches that server's sessions.

The server can't drive the terminal, so `open_session` sends an event that the terminal
interface handles. Only the terminal that shows the calling session, or one of its ancestors,
acts on it.

A session is part of the current project when it has the same project ID. Directories outside a
repository share the `global` project, so those sessions must also share a directory. Without a
current session, such as on the home screen, the project comes from the directory.

The search depends on OpenCode's internal database schema: the `session_message` table and
`session_v2`, or `session` on older versions. ASCII letters match in any case; other letters
must match the case of the query.

## Installation

```bash
opencode plugin add opencode-session-finder
```

This adds the plugin to `~/.config/opencode/opencode.json`. OpenCode loads the terminal
interface part along with it:

```json
{
  "plugins": ["opencode-session-finder"]
}
```

## Options

| Option     | Default                                                 | Description                              |
| ---------- | ------------------------------------------------------- | ---------------------------------------- |
| `database` | `${XDG_DATA_HOME:-~/.local/share}/opencode/opencode.db` | Path of the OpenCode database to search. |

```json
{
  "plugins": [
    { "package": "opencode-session-finder", "options": { "database": "/path/to/opencode.db" } }
  ]
}
```

## License

[MIT](../../LICENSE)
