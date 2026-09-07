# Security

## Reporting

Report a vulnerability through GitHub's private advisory form:
<https://github.com/breckenreed/clickup-mcp-read/security/advisories/new>, or by
opening an issue if the problem is not sensitive. Please do not post working
exploit detail in a public issue.

## What this server handles

`CLICKUP_API_KEY` is a ClickUp *personal* token. It has no scopes: it acts as
the user who created it, with that user's permissions across the whole
workspace. Treat it as a password, and keep it in your MCP client's
configuration rather than in a checked-in file.

**A read-only server is not a read-only token.** This server refuses to write;
the token it holds is still able to. If a hard guarantee matters, create the
token under a view-only ClickUp account — then neither this server nor anything
else holding that token can change the workspace.

`CLICKUP_TEAM_ID` is not secret.

## Where the credential can go

- The token is sent only to `https://api.clickup.com`. Requests are constructed
  as `URL` objects and the origin is compared to that constant *before* the
  `Authorization` header is attached; anything else throws
  (`src/index.mjs`, `clickupGet`).
- The native tools (`get_task_tree`, `get_task_activity`) issue `GET` only. The
  method is hardcoded in the one helper they share, which takes a path rather
  than a method or a host.
- The child process (`@twofeetup/clickup-mcp`) is resolved from this package's
  own dependency. `CLICKUP_MCP_ENTRY` is honoured only when it resolves inside
  that installed package, so it cannot be used to hand the token to arbitrary
  code.
- The child receives an allowlisted environment — the ClickUp variables,
  `REQUEST_SPACING`, `LOG_LEVEL`, `DOCUMENT_*`, and the platform variables Node
  needs — not the full environment of the editor that launched the server.
  `NODE_OPTIONS` is excluded on purpose.
- The token is never written to stdout, stderr, or a tool result. Errors log a
  status code and path.

## Network and transport

The server speaks JSON-RPC over stdio and opens no listening socket:
`ENABLE_SSE=false` and `ENABLE_STDIO=true` are set for the child regardless of
the inherited environment. JSON-RPC batches are refused rather than forwarded.

## Tool surface

Every exposed tool reads. There is no tool, and no reachable tool *action*,
that creates, updates or deletes anything in ClickUp — see the README for why
that has to be enforced per (tool, action) rather than per tool.

Three independent layers enforce it, so no single mistake opens a write:

1. The child server is spawned with `ENABLED_TOOLS` pinned to the read-capable
   tools, so upstream's write handlers are never registered.
2. Every `tools/call` is checked here against the tool allowlist and the
   per-tool action allowlist before it is forwarded — naming a tool that was
   never advertised is still refused.
3. `tools/list` is filtered on the way back: write tools dropped, `action`
   enums pruned to their reading values, write-only parameters stripped.

`ENABLED_TOOLS` may only *narrow* that set. Write tools named there are ignored
with a warning on stderr; there is no environment variable, argument or tool
call that puts them back.

Upstream's `attach_file_to_task` is not present at all. Beyond being a write, it
uploads a local file into ClickUp, which turns any prompt injection an agent
reads into a data-egress path.

An agent reading task descriptions and comments is reading untrusted text. This
server bounds what that text can make the agent *do to ClickUp*; it does not
bound what the agent does with the text elsewhere.

## Supported versions

Fixes land on `main` and are released from it. There are no maintained release
branches.
