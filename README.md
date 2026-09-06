# clickup-mcp-read

A **strictly read-only** ClickUp MCP server. It answers questions about a
workspace — including a whole nested subtask tree, or a task's whole activity
history, in **one call** — and it cannot change anything.

This is [`clickup-mcp-full`](https://github.com/breckenreed/clickup-mcp-full)
with every write path removed. Like that server, it wraps
[`@twofeetup/clickup-mcp`](https://www.npmjs.com/package/@twofeetup/clickup-mcp)
rather than forking it, so upstream fixes arrive with a dependency bump.

Use it for agents that should analyse, report on, or plan against ClickUp —
standups, audits, roadmap questions, "what changed last week" — without any
chance of a stray tool call editing a task.

## What it cannot do

Refused outright, at three independent layers: **create, update, delete, move
or duplicate a task; create, update or delete a list or folder; post a comment;
start, stop, add or delete a time entry; create, rename or delete a tag, or add
one to a task; upload an attachment; create or edit a document.**

## Why this is a separate server rather than a flag

Upstream consolidated nineteen tools into a handful of multi-action ones, so
the read/write line does not fall between tools — it falls *inside* them.
`task_comments` both reads comments and posts them. `task_time_tracking` both
reports time and starts timers. `operate_tags` both lists tags and deletes
them. A tool allowlist cannot express "reads only"; the unit that has to be
filtered is the **(tool, action) pair**, and that filtering has to live
somewhere the calling agent cannot reach.

Three layers hold the line, so no single mistake opens a write:

1. **The child never registers the write tools.** The wrapped server is started
   with `ENABLED_TOOLS` pinned to the read-capable set, so `manage_task` and
   friends have no handler at all.
2. **Every call is checked here first.** A `tools/call` is matched against the
   tool allowlist *and* the per-tool action allowlist before it is forwarded —
   so a client that names a tool it was never offered is still refused.
3. **The advertised schema is pruned.** `tools/list` drops the write tools,
   strips write actions out of each surviving `action` enum, and removes the
   parameters that exist only to carry a write. An agent is never shown an
   affordance it would then be denied.

The two tools implemented in this server reach ClickUp through a single helper
that hardcodes `GET` and takes a path, not a method, so they cannot become
writes either.

> **This is not a substitute for a read-only token.** ClickUp issues one
> personal token with the full rights of the user who created it; anything else
> holding that token can still write. This bounds what *this server* will do
> with it. For a hard guarantee, create the token under a view-only ClickUp
> account and use it here.

## Why the subtask tree

Upstream's only route to subtasks is `search_tasks` with `include_subtasks`,
which calls `GET /task/{id}?subtasks=true` and returns **full task objects for
the direct children only**. On a task with fifty subtasks nested several levels
deep that is both incomplete and ruinous for an agent's context window. The
alternative, one request per node, is worse.

`get_task_tree` walks the containing list once instead. ClickUp's
`GET /list/{id}/task?subtasks=true` returns every task in the list along with
its `parent` pointer, so the tree is reassembled locally: two requests total
regardless of depth or width, and the output is one compact line per task.

```
Task tree for 86capt3b: 23 task(s) including the root.
Statuses: in progress: 3, open: 14, complete: 6
List: Q3 Delivery

86capt3b  [in progress]  Migrate billing service  <ivan>
  86captk1  [complete]  Audit current schema  <olena>
  86captk2  [in progress]  Write migration scripts  <ivan>
    86captm7  [open]  Handle partial refunds
    86captm8  [open]  Backfill historical rows
  86captk3  [open]  Cutover plan
```

## Why the activity log

Upstream's `task_comments` reads comments and nothing else, so "who moved this
deadline", "when did it go to in progress", "who added that tag" are simply
unanswerable — those events live in ClickUp's **task history**, which the
documented v2 API does not expose at any endpoint.

`get_task_activity` reads the history the ClickUp web app itself reads
(`GET /v1/task/{id}/history`), merges it with the comments, de-duplicates the
comments that appear in both, and renders one chronological log: every status
change, due and start date move, assignee, watcher, tag, priority, name and
description edit, custom field, list or folder move, attachment, checklist,
time estimate and task relationship, with who did it and when.

```
Activity for 86capt3b (DEV-12): Migrate billing service
7 event(s).
Kinds: Comment: 2, Due date: 1, Tags: 1, Assignee added: 1, Status: 1, Custom field: 1

2026-03-06 12:00  ivan  —  Cutover moved to next week.
2026-03-05 09:00  ivan  —  Due date: 2026-03-10 12:00 → 2026-03-24 12:00
2026-03-04 15:30  olena  —  Tags: blocked, billing
2026-03-04 11:05  olena  —  Assignee added: ivan
2026-03-03 08:00  ivan  —  Status: to do → in progress
2026-03-02 17:45  olena  —  Schema audit done, moving on.
2026-03-01 10:00  ivan  —  Custom field "Sprint": S-14
```

Narrow it with `fields` (raw ClickUp field names: `status`, `due_date`,
`assignee_add`, `tag`, `custom_field`, ...), `since` (ISO date or millisecond
timestamp), `limit`, `include_comments` and `oldest_first`. Timestamps are UTC.

## Install

Nothing to clone or build. Point your agent at the package and it is fetched on
first launch.

**Claude Code**

```bash
claude mcp add clickup_read \
  --env CLICKUP_API_KEY=pk_your_token \
  --env CLICKUP_TEAM_ID=9012345678 \
  -- npx -y github:breckenreed/clickup-mcp-read
```

**Claude Desktop, Cursor, Windsurf, or any client using `mcpServers` JSON**

```json
{
  "mcpServers": {
    "clickup_read": {
      "command": "npx",
      "args": ["-y", "github:breckenreed/clickup-mcp-read"],
      "env": {
        "CLICKUP_API_KEY": "pk_your_token",
        "CLICKUP_TEAM_ID": "9012345678"
      }
    }
  }
}
```

**Hermes** (`~/.hermes/config.yaml`)

```yaml
mcp_servers:
  clickup_read:
    command: npx
    args: ["-y", "github:breckenreed/clickup-mcp-read"]
    env:
      CLICKUP_API_KEY: "${CLICKUP_API_KEY}"
      CLICKUP_TEAM_ID: "${CLICKUP_TEAM_ID}"
    connect_timeout: 60
    keepalive_interval: 60
    idle_timeout_seconds: 1800
```

**Global install**, if you would rather not resolve from GitHub on every launch:

```bash
npm install -g github:breckenreed/clickup-mcp-read
```

then use `clickup-mcp-read` as the command with no arguments.

Running this alongside `clickup-mcp-full` is fine — give them different server
names and the agent sees two distinct tool sets.

## Credentials

| Variable | Where to get it |
|---|---|
| `CLICKUP_API_KEY` | ClickUp, Settings, Apps, API Token. Starts with `pk_`. |
| `CLICKUP_TEAM_ID` | The number in your ClickUp URL, or `curl -H "Authorization: $CLICKUP_API_KEY" https://api.clickup.com/api/v2/team` and read `.teams[].id`. |

## Tools

Every tool here is read-only. Nine are exposed by default.

| Tool | What it does |
|---|---|
| `get_task_tree` | Task plus all nested subtasks, any depth, one call |
| `get_task_activity` | Full history of a task: system events plus comments |
| `get_workspace_hierarchy` | Spaces, folders, lists as a tree |
| `search_tasks` | One task by id, one list, or workspace-wide filters |
| `get_container` | Details of a single list or folder |
| `find_members` | Resolve a name or email to an assignee id |
| `task_comments` | Read comments (`get` only) |
| `task_time_tracking` | Read time entries (`get_entries`, `get_current`) |
| `operate_tags` | List the tags in a space (`list` only, space scope) |

With `DOCUMENT_SUPPORT=true`, two more appear: `list_documents`, and
`manage_document_page` narrowed to its `get` and `list` actions.

Upstream's `manage_task`, `manage_container`, `attach_file_to_task` and
`manage_document` are **not present and cannot be enabled**.

## Options

| Variable | Default | Effect |
|---|---|---|
| `ENABLED_TOOLS` | the nine tools above | Comma-separated allowlist. May only **narrow** the read-only set; write tools listed here are ignored with a warning on stderr. `get_task_tree` and `get_task_activity` are implemented here, so they are always available. |
| `DISABLED_TOOLS` | unset | Comma-separated blocklist. Only ever subtracts. |
| `REQUEST_SPACING` | `100` | Milliseconds between ClickUp API calls. See below. |
| `DOCUMENT_SUPPORT` | `false` | `true` exposes the two read-only document tools. |

**Raise `REQUEST_SPACING` on a shared workspace.** The default allows about ten
requests per second, while ClickUp's per-token limit is roughly 100 per minute
on most plans. The limit is counted against the token, not the tool, so an
agent that exhausts it also breaks every other integration running under the
same token. `700` keeps you under a 100 per minute ceiling.

## Notes on behaviour

**Refusals are tool errors, not transport errors.** A blocked call comes back
as a normal tool result with `isError` and a sentence saying the server is
read-only and the write is not possible here. Agents read that and move on;
a JSON-RPC error tends to get retried.

**Subtasks in another list.** The tree is built by walking the list that
contains the root task. If your workspace places subtasks in a different list
from their parent, those will not appear, and the server falls back to the
direct children reported by the task endpoint. Open an issue if you hit this
and it matters.

**Argument spellings are forgiving.** `get_task_tree` and `get_task_activity`
accept `task_id`, `taskid`, a bare `id` or `task` wherever the schema says
`taskId`, and the same folding applies to every other argument (`maxDepth` for
`max_depth`, `includeComments` for `include_comments`). Values are coerced to
the declared type, so `"true"`, `"15"` and `"status,due_date"` work where a
boolean, a number and an array are expected. Smaller models get these wrong
constantly, and the failures were silent rather than loud: an unread `taskId`
surfaced as "taskId is required", and `include_comments: "false"` is a non-empty
string, so it read as true. The alias used is logged to stderr. This leniency
covers those two tools only — the read-only policy gate is not folded or
coerced, so a mis-spelled `action` on a proxied tool is still refused rather
than guessed at.

**The activity endpoint is undocumented.** `GET /v1/task/{id}/history` is what
the ClickUp web app calls, not part of the published v2 API: a personal token
can read it today, but ClickUp does not promise that, and some plans or tokens
get a 403. That failure is not fatal — `get_task_activity` then returns the
comments plus a line saying the system events were unavailable, so the tool
never simply breaks. It pages up to ten pages of history and ten of comments,
spaced by `REQUEST_SPACING`.

**`search_tasks` descriptions.** The upstream description ("Works 3 ways")
leads smaller models to put a plain id like `86capt3b` into `customTaskId`,
which is only for prefixed ids like `DEV-123`. Such a call falls through to the
workspace-search branch and fails with "At least one filter parameter is
required", an error that names the wrong problem, after which the model tends
to invent filters instead of fixing the field. This server replaces that
description with the single rule the model actually needs.

**Running inside Docker with a bind-mounted home.** If your agent launches MCP
servers with `HOME` pointing at a bind mount, `npx` rebuilds its package cache
across that mount on every connect, which can take minutes and time out. Install
globally inside the image instead and point `command:` at the binary.

## Troubleshooting

Check that the server starts and lists its tools:

```bash
CLICKUP_API_KEY=pk_... CLICKUP_TEAM_ID=... npx -y github:breckenreed/clickup-mcp-read --help
```

`Missing required environment` means the variables did not reach the process:
most clients require them in the server's own `env` block, not your shell.

A 401 from any tool means the token is wrong or was revoked. A 429 means you
are hitting the rate limit, so raise `REQUEST_SPACING`.

## License

MIT, like the upstream server it wraps. `@twofeetup/clickup-mcp` is the
MIT-licensed community continuation of the pre-paid tree of
`@taazkareem/clickup-mcp-server`.
