#!/usr/bin/env node
/**
 * clickup-mcp-read — a strictly read-only ClickUp MCP server.
 *
 * This is clickup-mcp-full with every write path removed. It is a thin stdio
 * proxy in front of @twofeetup/clickup-mcp: it spawns that server as a child,
 * speaks the same newline-delimited JSON-RPC in both directions, and:
 *
 *   1. refuses every tool and every tool action that can change anything in
 *      ClickUp — see the read-only policy below;
 *   2. adds `get_task_tree`, implemented here, which reads a task and ALL of
 *      its nested subtasks at every depth in one call;
 *   3. adds `get_task_activity`, which reads the full activity log of a task —
 *      every system event (status changes, due-date moves, assignees, tags,
 *      priority, custom fields, moves, attachments, ...) merged with the
 *      comments, in one chronological view;
 *   4. rewrites the `search_tasks` description, whose "Works 3 ways" phrasing
 *      reliably walks smaller models into a dead end (see below).
 *
 * Why a separate server rather than a flag
 * ----------------------------------------
 * Upstream consolidated its nineteen tools into a handful of multi-action ones,
 * so the read/write line does not fall between tools: `task_comments` both
 * reads comments and posts them, `task_time_tracking` both reports time and
 * starts timers, `operate_tags` both lists tags and creates them. A tool
 * allowlist therefore cannot express "reads only" — the unit that has to be
 * filtered is the (tool, action) pair. That filtering has to happen somewhere
 * the caller cannot reach, which is this proxy.
 *
 * Three independent layers hold the line, so no single mistake opens a write:
 *
 *   1. the child is started with ENABLED_TOOLS pinned to the read-capable
 *      tools only, so the write tools are never registered at all. A
 *      user-supplied ENABLED_TOOLS can narrow that set but never widen it;
 *   2. every `tools/call` is checked here before it reaches the child, against
 *      both the tool allowlist and the per-tool action allowlist, so a client
 *      that calls a tool it was never offered still gets refused;
 *   3. `tools/list` is filtered on the way back — write tools are dropped, and
 *      the surviving multi-action tools have their `action` enums pruned and
 *      their write-only parameters stripped, so an agent is never shown a
 *      capability it would then be denied.
 *
 * The two native tools added here reach ClickUp through one helper that
 * hardcodes GET and takes a path, not a method, so they cannot become writes
 * either.
 *
 * What this server can NOT do: create, update, delete, move or duplicate a
 * task; create or delete a list or folder; post a comment; start, stop, add or
 * delete a time entry; create, rename or delete a tag, or add one to a task;
 * upload an attachment; create or edit a document.
 *
 * Why get_task_tree exists
 * ------------------------
 * Upstream's only route to subtasks is search_tasks + include_subtasks, which
 * calls GET /task/{id}?subtasks=true and returns FULL task objects for the
 * DIRECT children only. On a task with fifty nested subtasks that is both
 * incomplete (one level) and ruinous for an agent's context window, and the
 * alternative — one request per node — is worse.
 *
 * This walks the containing list once instead. ClickUp's
 * GET /list/{id}/task?subtasks=true returns every task in the list with its
 * `parent` pointer, so the whole tree is reassembled locally: two-ish requests
 * regardless of depth or width. Output is one indented line per task rather
 * than task objects, because an agent planning work needs ids, names and
 * statuses, not custom-field arrays.
 *
 * Why the search_tasks description is rewritten
 * ---------------------------------------------
 * Upstream says "Works 3 ways: (1) Single task by taskId/taskName/
 * customTaskId". Smaller models read that and put a plain id (86capt3b) into
 * customTaskId, which is only for prefixed ids like DEV-123. Such a call falls
 * through to the workspace-search branch and dies on "At least one filter
 * parameter is required" — an error naming the wrong problem, so the model
 * then invents filters instead of fixing the field, and burns a dozen calls.
 * The rule it actually needs is one sentence, so this states it as one.
 *
 * Why get_task_activity exists
 * ---------------------------
 * Upstream's `task_comments` reads comments and nothing else, so "who moved
 * this deadline", "when did it go to in progress", "who added that tag" are
 * unanswerable — the events that carry those answers live in ClickUp's task
 * history, which the documented v2 API does not expose at all. ClickUp's own
 * web app reads them from `GET /v1/task/{id}/history`, which a personal token
 * can call, so this tool pages that endpoint, merges the result with the
 * comments, and renders one chronological log. The endpoint is undocumented, so
 * a failure there is not fatal: the tool degrades to comments plus a note.
 *
 * A read-only server is not a substitute for a read-only token. ClickUp issues
 * one personal token with full account rights, so anything else holding that
 * token can still write; this bounds what THIS server will do with it.
 *
 * Credential handling
 * -------------------
 * CLICKUP_API_KEY is a personal token with no scopes: it acts as the user who
 * created it, across the whole workspace. So it is kept on a short leash.
 * Native requests are built as URL objects and their origin is checked against
 * api.clickup.com before the Authorization header is attached; the child
 * server is resolved from the installed dependency and CLICKUP_MCP_ENTRY may
 * only point inside it; the child inherits an allowlisted environment rather
 * than the editor's whole one; and SSE stays off, so nothing listens on a
 * socket. See SECURITY.md.
 *
 * MIT licensed, like the upstream server it wraps.
 */

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve as resolvePath, sep } from 'node:path';
import { createInterface } from 'node:readline';

import {
  actorName,
  asMillis,
  clip,
  commentText,
  FIELD_LABELS,
  formatStamp,
  indexByParent,
  normaliseHistoryEntry,
  parseSince,
  renderTree,
} from './format.mjs';
import {
  decorateChildTools,
  NATIVE_TOOLS,
  NATIVE_TOOL_NAMES,
  normaliseArgs,
  readOnlyRefusal,
  resolveAllowedTools,
} from './tools.mjs';

const require = createRequire(import.meta.url);
const VERSION = '1.0.0';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stderr.write(
    `clickup-mcp-read ${VERSION}\n\n` +
      'A READ-ONLY ClickUp MCP server. Agents launch it over stdio; there is\n' +
      'nothing to run by hand. It cannot create, update or delete anything.\n\n' +
      'Required environment:\n' +
      '  CLICKUP_API_KEY   ClickUp personal API token (Settings -> Apps -> API Token)\n' +
      '  CLICKUP_TEAM_ID   Workspace id (the number in your ClickUp URL)\n\n' +
      'Optional:\n' +
      '  ENABLED_TOOLS     comma-separated allowlist; may only NARROW the\n' +
      '                    read-only set, never add a write tool back\n' +
      '  DISABLED_TOOLS    comma-separated blocklist\n' +
      '  REQUEST_SPACING   ms between ClickUp API calls (default 100)\n' +
      '  DOCUMENT_SUPPORT  "true" to expose the read-only document tools\n\n' +
      'See https://github.com/breckenreed/clickup-mcp-read\n',
  );
  process.exit(0);
}

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const log = (...parts) => console.error('[clickup-mcp-read]', ...parts);

// ── Configuration ──────────────────────────────────────────────────────────

// The read-only policy. A tool absent from this map is refused outright; a
// tool present with `actions: null` has no write mode to guard; a tool present
// with a set of actions is reachable only for those.
//
// Upstream tools deliberately left out entirely, because every action they
// offer is a write: manage_task (create/update/delete/move/duplicate),
// manage_container (create/update/delete lists and folders),
// attach_file_to_task (uploads a local file into ClickUp) and manage_document
// (create/update).
// The policy itself lives in tools.mjs, where it can be tested without
// spawning anything. Here it is only resolved against the environment.
const { allowed: ALLOWED_TOOLS, ignored } = resolveAllowedTools(process.env);
if (ignored.length) {
  log(
    `ignoring write-capable ENABLED_TOOLS entries: ${ignored.join(', ')}. ` +
      'This server is read-only; use clickup-mcp-full if you need writes.',
  );
}
const allowedTools = [...ALLOWED_TOOLS.keys()];

const missing = ['CLICKUP_API_KEY', 'CLICKUP_TEAM_ID'].filter(
  (key) => !String(process.env[key] || '').trim(),
);
if (missing.length) {
  log(
    `missing required environment: ${missing.join(', ')}. ` +
      'Set them in your MCP client config and restart. Run with --help for details.',
  );
  process.exit(1);
}

// Whatever this process spawns is handed the ClickUp token, so the child is
// resolved from the installed dependency and nothing else. CLICKUP_MCP_ENTRY
// remains as an escape hatch for odd install layouts, but it may only point
// INSIDE that package: an environment variable must not be able to redirect a
// live credential into arbitrary code.
const realOf = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return resolvePath(path);
  }
};

let installedEntry = null;
try {
  installedEntry = require.resolve('@twofeetup/clickup-mcp/build/index.js');
} catch {
  installedEntry = null;
}

const entryOverride = String(process.env.CLICKUP_MCP_ENTRY || '').trim();
let childEntry;
if (entryOverride && installedEntry) {
  const packageRoot = realOf(dirname(dirname(installedEntry))) + sep;
  const candidate = realOf(resolvePath(entryOverride));
  if (!candidate.startsWith(packageRoot)) {
    log(
      `refusing CLICKUP_MCP_ENTRY=${entryOverride}: it points outside the ` +
        'installed @twofeetup/clickup-mcp, and the child is started with the ' +
        'ClickUp token. Unset it to use the installed server.',
    );
    process.exit(1);
  }
  childEntry = candidate;
} else if (entryOverride) {
  // The dependency is missing entirely; the override is the only way to start.
  log('using CLICKUP_MCP_ENTRY: @twofeetup/clickup-mcp is not installed here.');
  childEntry = resolvePath(entryOverride);
} else if (installedEntry) {
  childEntry = installedEntry;
} else {
  log(
    'could not resolve @twofeetup/clickup-mcp. Reinstall this package so its ' +
      'dependency is present (npx -y github:breckenreed/clickup-mcp-read).',
  );
  process.exit(1);
}

// A stdio MCP server inherits the entire environment of the editor that
// launched it — every other integration's tokens included. The child gets only
// the variables it actually reads, plus what Node needs to start. NODE_OPTIONS
// is deliberately absent: it can inject code into the process holding the key.
//
// ENABLED_TOOLS and DISABLED_TOOLS are absent on purpose too. Both are read
// from this process's environment when the policy above is computed, and the
// child is told the result; passing the raw values through would let the
// child's own filtering disagree with the policy.
const CHILD_ENV_KEYS = [
  // upstream's own configuration
  'CLICKUP_API_KEY',
  'CLICKUP_TEAM_ID',
  'DISABLED_COMMANDS',
  'DOCUMENT_SUPPORT',
  'DOCUMENT_MODULE',
  'DOCUMENT_MODEL',
  'REQUEST_SPACING',
  'LOG_LEVEL',
  // runtime essentials (POSIX and Windows)
  'PATH',
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'SystemRoot',
  'SYSTEMROOT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'COMSPEC',
  'PATHEXT',
];

const childEnv = {};
for (const key of CHILD_ENV_KEYS) {
  if (process.env[key] !== undefined) childEnv[key] = process.env[key];
}

// Layer 1: the child only ever registers the tools that survived the policy,
// so the write handlers are unreachable even if this proxy were bypassed.
// An empty ENABLED_TOOLS means "no filter" to upstream — i.e. every tool,
// writes included — so an empty result has to be spelled as a name that
// matches nothing rather than as an empty string.
childEnv.ENABLED_TOOLS = allowedTools.length
  ? allowedTools.join(',')
  : '__clickup_mcp_read_none__';
// stdio only: an inherited ENABLE_SSE must not open a listening socket.
childEnv.ENABLE_SSE = 'false';
childEnv.ENABLE_STDIO = 'true';

const child = spawn(process.execPath, [childEntry], {
  stdio: ['pipe', 'pipe', 'inherit'], // child stderr flows to ours, for host logs
  env: childEnv,
});

child.on('error', (err) => {
  log(`could not spawn ${childEntry}: ${err.message}`);
  process.exit(1);
});

// ── ClickUp REST (native tools only) ───────────────────────────────────────

const CLICKUP_ORIGIN = 'https://api.clickup.com';
const CLICKUP_API = `${CLICKUP_ORIGIN}/api/v2`;
// The task history lives outside the documented API, on the same origin the
// ClickUp web app itself calls. See the header comment on get_task_activity.
const CLICKUP_V1 = `${CLICKUP_ORIGIN}/v1`;

// The single network path for native tools. GET is hardcoded, and callers only
// supply a path, so nothing here can become a write.
async function clickupGet(path, base = CLICKUP_API) {
  const url = new URL(`${base}${path}`);
  // A ClickUp personal token carries the whole workspace. Pin it to one
  // origin, so neither a later edit nor a crafted `base` can send it anywhere
  // else — the check is the guarantee, not the constant above it.
  if (url.origin !== CLICKUP_ORIGIN) {
    throw new Error(`refusing to send ClickUp credentials to ${url.origin}`);
  }
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: process.env.CLICKUP_API_KEY || '',
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `ClickUp API ${res.status} ${res.statusText} on ${path}` +
        (body ? `: ${body.slice(0, 200)}` : ''),
    );
  }
  return res.json();
}

// Native tools bypass the child's REQUEST_SPACING, so honour it here too:
// the token's rate limit is shared with every other integration using it.
const SPACING = Math.max(0, Number(process.env.REQUEST_SPACING) || 100);
const spaceRequests = () =>
  SPACING ? new Promise((resolve) => setTimeout(resolve, SPACING)) : undefined;

// ClickUp caps a list page at 100 tasks and flags the end with last_page.
async function fetchListTasks(listId, includeClosed) {
  const collected = [];
  for (let page = 0; page < 25; page++) {
    const data = await clickupGet(
      `/list/${encodeURIComponent(listId)}/task?subtasks=true` +
        `&include_closed=${includeClosed ? 'true' : 'false'}&page=${page}`,
    );
    const tasks = data.tasks || [];
    collected.push(...tasks);
    if (data.last_page || tasks.length === 0) break;
  }
  return collected;
}

async function getTaskTree(args) {
  const taskId = String(args?.taskId || '').trim();
  if (!taskId) throw new Error('taskId is required');
  const includeClosed = args?.include_closed !== false;
  const maxDepth = Number.isFinite(args?.max_depth) ? Number(args.max_depth) : 10;

  const root = await clickupGet(
    `/task/${encodeURIComponent(taskId)}?include_subtasks=true`,
  );
  const listId = root.list?.id;

  // Walking the list yields every descendant with its parent pointer. If the
  // task has no list, or the list read fails, fall back to whatever the task
  // endpoint itself returned: one level, but better than an error.
  let pool = [];
  if (listId) {
    try {
      pool = await fetchListTasks(listId, includeClosed);
    } catch (err) {
      log(`list walk failed (${err.message}); falling back to direct subtasks`);
    }
  }
  if (pool.length === 0) pool = [root, ...(root.subtasks || [])];

  const { text, count, summary } = renderTree(
    root,
    indexByParent(pool),
    maxDepth,
  );
  const header =
    `Task tree for ${root.id}${root.custom_id ? ` (${root.custom_id})` : ''}: ` +
    `${count} task(s) including the root.\n` +
    (summary ? `Statuses: ${summary}\n` : '') +
    (listId ? `List: ${root.list?.name || listId}\n` : '');
  return `${header}\n${text}`;
}

// ── get_task_activity ──────────────────────────────────────────────────────

// ClickUp names history entries by the field they touched. Anything not listed
// is rendered under its raw name rather than dropped, so a field added upstream
// still shows up.
async function getTaskActivity(args) {
  const taskId = String(args?.taskId || '').trim();
  if (!taskId) throw new Error('taskId is required');
  const limit = Number.isFinite(args?.limit)
    ? Math.max(1, Math.min(500, Number(args.limit)))
    : 100;
  const includeComments = args?.include_comments !== false;
  const oldestFirst = args?.oldest_first === true;
  const since = parseSince(args?.since);
  const wanted = Array.isArray(args?.fields) && args.fields.length
    ? new Set(args.fields.map((f) => String(f).trim()).filter(Boolean))
    : null;

  // A custom id ("DEV-123") is not accepted by the history endpoint, and the
  // task read gives us the name and the canonical id in one go.
  const task = await clickupGet(`/task/${encodeURIComponent(taskId)}`);
  const realId = task?.id || taskId;

  const events = [];
  const commentIdsFromHistory = new Set();
  let historyNote = '';

  try {
    for (const entry of await fetchHistory(realId, limit)) {
      const event = normaliseHistoryEntry(entry);
      if (event.commentId) commentIdsFromHistory.add(event.commentId);
      events.push(event);
    }
  } catch (err) {
    historyNote =
      `System events unavailable (${err.message}). ` +
      'ClickUp\'s history endpoint is undocumented and can be blocked for ' +
      'some tokens or plans; comments below are unaffected.';
    log(`task history failed for ${realId}: ${err.message}`);
  }

  if (includeComments) {
    try {
      for (const comment of await fetchComments(realId, limit)) {
        const id = String(comment?.id ?? '');
        if (id && commentIdsFromHistory.has(id)) continue; // already in history
        const text = commentText(comment);
        events.push({
          date: asMillis(comment?.date) ?? 0,
          field: 'comment',
          who: actorName(comment?.user),
          commentId: id || null,
          detail: text ? clip(text, 400) : '(empty comment)',
        });
      }
    } catch (err) {
      historyNote +=
        `${historyNote ? '\n' : ''}Comments unavailable (${err.message}).`;
      log(`comments failed for ${realId}: ${err.message}`);
    }
  }

  const filtered = events.filter((event) => {
    if (!includeComments && event.field === 'comment') return false;
    if (wanted && !wanted.has(event.field)) return false;
    if (since !== null && event.date < since) return false;
    return true;
  });

  filtered.sort((a, b) => (oldestFirst ? a.date - b.date : b.date - a.date));
  const shown = filtered.slice(0, limit);

  const tally = new Map();
  for (const event of filtered) {
    tally.set(event.field, (tally.get(event.field) || 0) + 1);
  }
  const summary = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([field, n]) => `${FIELD_LABELS[field] || field}: ${n}`)
    .join(', ');

  const lines = shown.map(
    (event) =>
      `${event.date ? formatStamp(event.date) : '(no date)'}  ${event.who}  —  ${event.detail}`,
  );

  const header =
    `Activity for ${realId}${task?.custom_id ? ` (${task.custom_id})` : ''}` +
    `${task?.name ? `: ${task.name}` : ''}\n` +
    `${filtered.length} event(s)` +
    (shown.length < filtered.length
      ? `, showing the ${oldestFirst ? 'oldest' : 'newest'} ${shown.length}`
      : '') +
    `.\n` +
    (summary ? `Kinds: ${summary}\n` : '') +
    (historyNote ? `${historyNote}\n` : '');

  return `${header}\n${lines.join('\n') || '(no matching events)'}`;
}

const NATIVE_HANDLERS = {
  get_task_tree: getTaskTree,
  get_task_activity: getTaskActivity,
};

// ── JSON-RPC plumbing ──────────────────────────────────────────────────────

const writeLine = (stream, msg) => stream.write(`${JSON.stringify(msg)}\n`);
const toClient = (msg) => writeLine(process.stdout, msg);
const toChild = (msg) => writeLine(child.stdin, msg);

// ids may be numbers or strings; keep the type in the key so 1 and "1" differ.
const idKey = (id) => `${typeof id}:${id}`;
const pendingListTools = new Set();
const pendingInitialize = new Set();

function runNativeTool(id, name, rawArgs) {
  const { args, renamed } = normaliseArgs(name, rawArgs);
  if (renamed.length) log(`${name}: accepted ${renamed.join(', ')}`);

  NATIVE_HANDLERS[name](args)
    .then((text) => {
      toClient({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    })
    .catch((err) => {
      log(`${name} failed: ${err.message}`);
      toClient({
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: `${name} failed: ${err.message}` }],
        },
      });
    });
}

// A refusal is returned as a tool result with isError, not as a JSON-RPC
// error: an agent reads the text and picks another tool, where a transport
// error usually just gets retried.
function refuse(id, text) {
  if (id === undefined || id === null) return; // a notification has no reply
  toClient({
    jsonrpc: '2.0',
    id,
    result: { isError: true, content: [{ type: 'text', text }] },
  });
}

// Layer 2. Returns null when the call may proceed, or the refusal text.
function handleFromClient(line) {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log('dropped unparsable client message');
    return;
  }

  // JSON-RPC batching was removed from MCP; refuse rather than let a batch slip
  // past the per-message routing below.
  if (Array.isArray(msg)) {
    log('refused a JSON-RPC batch (not supported)');
    for (const item of msg) {
      if (item && item.id !== undefined && item.id !== null) {
        toClient({
          jsonrpc: '2.0',
          id: item.id,
          error: { code: -32600, message: 'Batched requests are not supported.' },
        });
      }
    }
    return;
  }

  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    const args = msg.params?.arguments || {};

    // Every call is checked, including for tools the child would happily run:
    // a client can name a tool it was never offered in tools/list.
    const refusal = readOnlyRefusal(name, args, ALLOWED_TOOLS);
    if (refusal) {
      log(`refused ${name}${args?.action ? ` action=${args.action}` : ''}`);
      refuse(msg.id, refusal);
      return;
    }

    // Native tools are answered here and never reach the child.
    if (NATIVE_TOOL_NAMES.has(name)) {
      if (msg.id !== undefined && msg.id !== null) {
        runNativeTool(msg.id, name, args);
      }
      return;
    }
  }

  if (msg.id !== undefined && msg.id !== null) {
    if (msg.method === 'tools/list') pendingListTools.add(idKey(msg.id));
    else if (msg.method === 'initialize') pendingInitialize.add(idKey(msg.id));
  }

  toChild(msg);
}

// Prune a tool's advertised schema down to what the policy actually allows:
// the action enum loses its write values, and the parameters that only exist
// to carry a write lose their place entirely. An agent should never see an
// affordance this server will refuse.
function handleFromChild(line) {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log('dropped unparsable server message');
    return;
  }

  const key = msg.id === undefined || msg.id === null ? null : idKey(msg.id);

  if (key !== null && pendingListTools.delete(key)) {
    if (Array.isArray(msg.result?.tools)) {
      // Layer 3. The child should already be filtered, but a tool it offers
      // that the policy does not cover is dropped rather than trusted.
      msg.result.tools = decorateChildTools(msg.result.tools, ALLOWED_TOOLS);
      msg.result.tools.push(...NATIVE_TOOLS);
    }
  } else if (key !== null && pendingInitialize.delete(key)) {
    if (msg.result?.serverInfo?.name) {
      msg.result.serverInfo.name = 'clickup-mcp-read';
      msg.result.serverInfo.version = VERSION;
    }
  }

  toClient(msg);
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

// The upstream server ignores a closed stdin and keeps running, so closing our
// end is not enough to end it: escalate, or a recycled server leaks a process.
function shutdownChild() {
  child.stdin.end();
  setTimeout(() => child.kill('SIGTERM'), 2000).unref();
  setTimeout(() => child.kill('SIGKILL'), 6000).unref();
}

const fromClient = createInterface({ input: process.stdin, crlfDelay: Infinity });
fromClient.on('line', handleFromClient);
fromClient.on('close', shutdownChild);

const fromChild = createInterface({ input: child.stdout, crlfDelay: Infinity });
fromChild.on('line', handleFromChild);

// EPIPE on either pipe just means the other side went away first.
child.stdin.on('error', () => {});
process.stdout.on('error', () => {});

child.on('exit', (code, signal) => {
  if (signal) log(`server exited on ${signal}`);
  // Let the loop drain what is already queued instead of exiting mid-write.
  process.exitCode = code ?? (signal ? 143 : 0);
  fromClient.close();
  process.stdin.pause();
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  });
}
