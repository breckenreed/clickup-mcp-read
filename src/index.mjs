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
const READ_ONLY_TOOLS = new Map([
  // No write mode at all.
  ['get_workspace_hierarchy', { actions: null }], // spaces -> folders -> lists
  ['search_tasks',            { actions: null }], // by id, by list, or filters
  ['get_container',           { actions: null }], // details of one list or folder
  ['find_members',            { actions: null }], // name or email -> assignee id
  // Multi-action tools, pinned to their reading actions. The rejected ones are
  // task_comments/create, every timer and entry mutation, and every tag
  // create/update/delete/add/remove.
  ['task_comments',      { actions: new Set(['get']) }],
  ['task_time_tracking', { actions: new Set(['get_entries', 'get_current']) }],
  ['operate_tags',       { actions: new Set(['list']) }],
]);

// Upstream registers the document tools only when DOCUMENT_SUPPORT is on, so
// match that: list_documents reads, and manage_document_page — despite the
// name — has get and list actions worth keeping. Its create/update are not.
if (String(process.env.DOCUMENT_SUPPORT).trim() === 'true') {
  READ_ONLY_TOOLS.set('list_documents', { actions: null });
  READ_ONLY_TOOLS.set('manage_document_page', { actions: new Set(['get', 'list']) });
}

// Write-only parameters on the surviving multi-action tools. Left in the
// schema they are an invitation an agent will accept and then be refused for,
// so they are stripped from tools/list along with the write actions.
const WRITE_ONLY_PARAMS = {
  task_comments: ['commentText', 'notifyAll', 'assignee'],
  task_time_tracking: [
    'description', 'billable', 'tags', 'start', 'duration', 'timeEntryId',
  ],
  // Everything below the first four belongs to the task scope, which only has
  // add and remove — both writes. Listing a space's tags needs neither a task
  // nor a tag name.
  operate_tags: [
    'newTagName', 'tagBg', 'tagFg', 'colorCommand',
    'taskId', 'customTaskId', 'taskName', 'listName', 'tagName',
  ],
};

// Non-action enums that the policy also narrows. With add and remove gone,
// scope "task" has nothing left to do.
const ENUM_OVERRIDES = {
  operate_tags: { scope: ['space'] },
};

const parseToolList = (value) =>
  String(value || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

// ENABLED_TOOLS may narrow the read-only set; it may not put a write tool back,
// which is the whole point of this build. DISABLED_TOOLS only ever subtracts.
let allowedTools = [...READ_ONLY_TOOLS.keys()];

const requested = parseToolList(process.env.ENABLED_TOOLS);
if (requested.length) {
  const refused = requested.filter((name) => !READ_ONLY_TOOLS.has(name));
  if (refused.length) {
    log(
      `ignoring write-capable ENABLED_TOOLS entries: ${refused.join(', ')}. ` +
        'This server is read-only; use clickup-mcp-full if you need writes.',
    );
  }
  allowedTools = allowedTools.filter((name) => requested.includes(name));
}

const denied = parseToolList(process.env.DISABLED_TOOLS);
if (denied.length) {
  allowedTools = allowedTools.filter((name) => !denied.includes(name));
}

const ALLOWED_TOOLS = new Map(
  allowedTools.map((name) => [name, READ_ONLY_TOOLS.get(name)]),
);

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

// ── Native tools ───────────────────────────────────────────────────────────

const NATIVE_TOOLS = [
  {
    name: 'get_task_tree',
    description:
      'Read a task together with ALL its nested subtasks, at every depth, in ' +
      'ONE call (READ-ONLY). Use this whenever the question involves subtasks, ' +
      'children, breakdown or progress of a task, and never fetch subtasks one ' +
      'by one. Returns a compact indented tree (id, status, name, assignees) ' +
      'plus a status tally, not full task objects.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description:
            'REQUIRED: id of the root task, e.g. "86capt3b". Works with both ' +
            'regular and custom ids.',
        },
        include_closed: {
          type: 'boolean',
          description: 'Include closed/done subtasks (default: true)',
        },
        max_depth: {
          type: 'number',
          description: 'Maximum nesting depth to walk (default: 10)',
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'get_task_activity',
    description:
      'Read the FULL activity log of a task in ONE call (READ-ONLY): every ' +
      'system event — status changes, due/start date moves, assignees, ' +
      'watchers, tags, priority, name and description edits, custom fields, ' +
      'list/folder moves, attachments, checklists, time estimates, task ' +
      'relationships — merged with the comments into one chronological view ' +
      'with who did what and when. Use this for any question about the ' +
      'history of a task ("who changed the deadline", "when did it move to in ' +
      'progress", "who assigned this", "what happened last week"). ' +
      'task_comments only returns comments and answers none of those.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description:
            'REQUIRED: id of the task, e.g. "86capt3b". Works with both ' +
            'regular and custom ids.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of events to return (default: 100)',
        },
        include_comments: {
          type: 'boolean',
          description:
            'Include comments alongside the system events (default: true)',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Only return these event kinds. Use the raw ClickUp field names: ' +
            'status, assignee_add, assignee_rem, watcher_add, watcher_rem, ' +
            'due_date, start_date, priority, tag, name, content, comment, ' +
            'section_moved, subcategory, attachment, checklist, ' +
            'checklist_item, time_estimate, time_spent, custom_field, ' +
            'task_creation, linked_task, dependency. Omit for everything.',
        },
        since: {
          type: 'string',
          description:
            'Only events at or after this point. ISO date ("2026-01-31") or a ' +
            'millisecond timestamp.',
        },
        oldest_first: {
          type: 'boolean',
          description:
            'Render oldest event first instead of newest first (default: false)',
        },
      },
      required: ['taskId'],
    },
  },
];

const NATIVE_TOOL_NAMES = new Set(NATIVE_TOOLS.map((t) => t.name));

const DESCRIPTION_OVERRIDES = {
  search_tasks:
    'Find tasks. Pick ONE of three modes:\n' +
    '(1) ONE known task: pass taskId. A plain id like "86capt3b" is a taskId — ' +
    'it handles regular AND custom ids, so use it by default. Only use ' +
    'customTaskId for ids with a project prefix like "DEV-123". Putting a ' +
    'plain id in customTaskId fails with a misleading "filter required" error.\n' +
    '(2) One list: pass listId or listName.\n' +
    '(3) Across the workspace: pass at least one real filter (tags, statuses, ' +
    'assignees, list_ids, folder_ids, space_ids, or a date filter). A task id ' +
    'is NOT a filter.\n' +
    'For the subtasks of a task do NOT use this tool — call get_task_tree, ' +
    'which returns the whole nested tree in one compact call.',
};

// Replaced outright for the multi-action tools: upstream's text is a tour of
// actions that are not reachable here, and an agent that reads "create (add
// new comment)" will try it. Each of these describes only what survives.
Object.assign(DESCRIPTION_OVERRIDES, {
  task_comments:
    'Read the comments on a task (READ-ONLY). The only action is "get" — this ' +
    'server cannot post comments. Identify the task with taskId (preferred, ' +
    'handles regular AND custom ids), or taskName plus listName. Use start / ' +
    'startId to page.\n' +
    'This returns comments ONLY. For the history of a task — status changes, ' +
    'due-date moves, assignees, tags, priority, custom fields — call ' +
    'get_task_activity, which returns those events and the comments together.',
  task_time_tracking:
    'Read tracked time (READ-ONLY). Two actions: "get_entries" for the entries ' +
    'on one task (optionally filtered by startDate / endDate, which accept ' +
    'natural language like "last week"), and "get_current" for the timer ' +
    'running right now. This server cannot start or stop timers, or add or ' +
    'delete entries.',
  operate_tags:
    'List the tags defined in a space (READ-ONLY). The only action is "list", ' +
    'with scope "space" and a spaceId or spaceName. This server cannot create, ' +
    'rename or delete tags, or add them to and remove them from tasks. To find ' +
    'the tasks carrying a tag, use search_tasks with its tags filter.',
  list_documents:
    'List and discover ClickUp documents (READ-ONLY). Filter by parent_id plus ' +
    'parent_type (SPACE, FOLDER, LIST, TASK, WORKSPACE), by creator, or by id; ' +
    'page with limit and next_cursor. Detail levels: minimal, standard, ' +
    'detailed.',
  manage_document_page:
    'Read the pages of a ClickUp document (READ-ONLY, despite the name). Two ' +
    'actions: "list" for the page index of a document, and "get" for the ' +
    'content of one or more pages. This server cannot create or edit pages.',
});

const DESCRIPTION_SUFFIXES = {};

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

function renderTree(root, childrenBy, maxDepth) {
  const lines = [];
  const tally = new Map();
  const seen = new Set();
  let count = 0;

  const walk = (task, depth) => {
    if (seen.has(task.id)) return; // a cycle would otherwise recurse forever
    seen.add(task.id);

    const status = task.status?.status || 'no status';
    tally.set(status, (tally.get(status) || 0) + 1);
    count++;

    const who = (task.assignees || [])
      .map((a) => a.username || a.email)
      .filter(Boolean)
      .join(', ');
    const custom = task.custom_id ? ` (${task.custom_id})` : '';
    lines.push(
      `${'  '.repeat(depth)}${task.id}${custom}  [${status}]  ${task.name}` +
        (who ? `  <${who}>` : ''),
    );

    const children = childrenBy.get(task.id) || [];
    if (depth >= maxDepth) {
      if (children.length) {
        lines.push(
          `${'  '.repeat(depth + 1)}... ${children.length} more, depth limit reached`,
        );
      }
      return;
    }
    for (const child of children) walk(child, depth + 1);
  };

  walk(root, 0);
  const summary = [...tally.entries()].map(([s, n]) => `${s}: ${n}`).join(', ');
  return { text: lines.join('\n'), count, summary };
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

  const childrenBy = new Map();
  for (const task of pool) {
    if (!task.parent) continue;
    if (!childrenBy.has(task.parent)) childrenBy.set(task.parent, []);
    childrenBy.get(task.parent).push(task);
  }

  const { text, count, summary } = renderTree(root, childrenBy, maxDepth);
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
const FIELD_LABELS = {
  status: 'Status',
  assignee_add: 'Assignee added',
  assignee_rem: 'Assignee removed',
  watcher_add: 'Watcher added',
  watcher_rem: 'Watcher removed',
  due_date: 'Due date',
  start_date: 'Start date',
  date_closed: 'Closed',
  date_done: 'Done',
  priority: 'Priority',
  tag: 'Tags',
  name: 'Name',
  content: 'Description',
  comment: 'Comment',
  section_moved: 'Moved to list',
  subcategory: 'Moved',
  attachment: 'Attachment',
  checklist: 'Checklist',
  checklist_item: 'Checklist item',
  time_estimate: 'Time estimate',
  time_spent: 'Time tracked',
  custom_field: 'Custom field',
  task_creation: 'Created',
  linked_task: 'Linked task',
  dependency: 'Dependency',
  relationship: 'Relationship',
  points: 'Sprint points',
  archived: 'Archived',
  group_assignee_add: 'Team assigned',
  group_assignee_rem: 'Team unassigned',
};

const DATE_FIELDS = new Set([
  'due_date',
  'start_date',
  'date_closed',
  'date_done',
]);
const DURATION_FIELDS = new Set(['time_estimate', 'time_spent']);

const asMillis = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function formatStamp(value) {
  const ms = asMillis(value);
  if (ms === null) return String(value ?? '');
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function formatDuration(value) {
  const ms = asMillis(value);
  if (ms === null) return String(value ?? '');
  const minutes = Math.round(ms / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

const clip = (text, max) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

// History values are wildly polymorphic: a scalar, a status/priority/user
// object, or an array of tags. Reduce whatever arrives to one readable token.
function valueLabel(field, value) {
  if (value === null || value === undefined || value === '') return 'none';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    return value.map((item) => valueLabel(field, item)).join(', ');
  }
  if (typeof value === 'object') {
    const picked =
      value.status ??
      value.priority ??
      value.username ??
      value.email ??
      value.name ??
      value.title ??
      value.tag_name ??
      value.value ??
      value.text_content ??
      value.date;
    if (picked !== undefined && picked !== null && typeof picked !== 'object') {
      return valueLabel(field, picked);
    }
    return clip(JSON.stringify(value), 120);
  }
  if (DATE_FIELDS.has(field)) return formatStamp(value);
  if (DURATION_FIELDS.has(field)) return formatDuration(value);
  return clip(value, field === 'content' ? 120 : 160);
}

function commentText(comment) {
  if (!comment) return '';
  if (typeof comment === 'string') return comment;
  if (comment.comment_text) return comment.comment_text;
  if (Array.isArray(comment.comment)) {
    return comment.comment.map((part) => part?.text || '').join('');
  }
  if (typeof comment.comment === 'string') return comment.comment;
  return '';
}

const actorName = (user) =>
  user?.username || user?.email || (user?.id ? `user ${user.id}` : 'unknown');

// One history entry -> one normalised event. Comments arrive both as history
// entries and from the comment endpoint, so each carries its comment id for
// de-duplication.
function normaliseHistoryEntry(entry) {
  const field = entry?.field || 'unknown';
  const date = asMillis(entry?.date) ?? 0;
  const base = {
    date,
    field,
    who: actorName(entry?.user),
    commentId: entry?.comment?.id ? String(entry.comment.id) : null,
  };

  if (field === 'comment') {
    const text = commentText(entry.comment);
    return { ...base, detail: text ? clip(text, 400) : '(empty comment)' };
  }

  const label =
    field === 'custom_field' && entry?.custom_field?.name
      ? `${FIELD_LABELS.custom_field} "${entry.custom_field.name}"`
      : FIELD_LABELS[field] || field;

  const before = valueLabel(field, entry?.before);
  const after = valueLabel(field, entry?.after);

  // Additive events (a tag, an assignee, an attachment) only carry `after`;
  // rendering "none -> x" for those is noise.
  let detail;
  if (before === 'none' && after === 'none') detail = label;
  else if (before === 'none') detail = `${label}: ${after}`;
  else if (after === 'none') detail = `${label}: ${before} → (cleared)`;
  else if (before === after) detail = `${label}: ${after}`;
  else detail = `${label}: ${before} → ${after}`;

  return { ...base, detail };
}

// The history endpoint pages backwards from `start`/`start_id`, the same way
// the web app scrolls it. Ten pages is roughly a thousand events.
async function fetchHistory(taskId, limit) {
  const collected = [];
  const seen = new Set();
  let cursor = null;

  for (let page = 0; page < 10; page++) {
    if (page > 0) await spaceRequests();
    const query = cursor
      ? `?start=${encodeURIComponent(cursor.date)}&start_id=${encodeURIComponent(cursor.id)}`
      : '';
    const data = await clickupGet(
      `/task/${encodeURIComponent(taskId)}/history${query}`,
      CLICKUP_V1,
    );
    const entries = Array.isArray(data?.history) ? data.history : [];
    let added = 0;
    for (const entry of entries) {
      const id = String(entry?.id ?? '');
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      collected.push(entry);
      added++;
    }
    const last = entries[entries.length - 1];
    if (!added || !last?.id || !last?.date) break;
    if (collected.length >= limit * 3) break; // room to spare for filtering
    cursor = { date: last.date, id: last.id };
  }
  return collected;
}

async function fetchComments(taskId, limit) {
  const collected = [];
  const seen = new Set();
  let cursor = null;

  for (let page = 0; page < 10; page++) {
    if (page > 0) await spaceRequests();
    const query = cursor
      ? `?start=${encodeURIComponent(cursor.date)}&start_id=${encodeURIComponent(cursor.id)}`
      : '';
    const data = await clickupGet(
      `/task/${encodeURIComponent(taskId)}/comment${query}`,
    );
    const comments = Array.isArray(data?.comments) ? data.comments : [];
    let added = 0;
    for (const comment of comments) {
      const id = String(comment?.id ?? '');
      if (id && seen.has(id)) continue;
      if (id) seen.add(id);
      collected.push(comment);
      added++;
    }
    const last = comments[comments.length - 1];
    if (!added || !last?.id || !last?.date) break;
    if (collected.length >= limit * 3) break;
    cursor = { date: last.date, id: last.id };
  }
  return collected;
}

function parseSince(since) {
  if (since === undefined || since === null || since === '') return null;
  const ms = asMillis(since);
  if (ms !== null) return ms;
  const parsed = Date.parse(String(since));
  if (Number.isNaN(parsed)) {
    throw new Error(
      `could not read "since" as a date: pass an ISO date like "2026-01-31" ` +
        'or a millisecond timestamp',
    );
  }
  return parsed;
}

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

// ── Argument normalisation ─────────────────────────────────────────────────
//
// Smaller models spell an argument the way the surrounding prose reads, not the
// way the schema declares it: task_id for taskId, "true" for true, a
// comma-separated string for an array. Every one of those currently fails
// silently — an unread taskId becomes "taskId is required", and include_comments
// "false" is a non-empty string, so it reads as true. None of that is worth a
// retry loop, so accept the spellings and coerce to the declared type. The map
// is derived from each tool's own inputSchema, so a new argument is covered the
// moment it is declared.

const foldKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

// Spellings that do not fold to the canonical name on their own.
const ARG_SYNONYMS = { id: 'taskId', task: 'taskId' };

const NATIVE_ARG_SPECS = new Map(
  NATIVE_TOOLS.map((tool) => {
    const props = tool.inputSchema?.properties || {};
    const byFold = new Map(
      Object.keys(props).map((name) => [foldKey(name), name]),
    );
    return [tool.name, { byFold, props }];
  }),
);

function coerceArg(value, type) {
  if (value === null || value === undefined) return value;
  if (type === 'number' && typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (type === 'boolean' && typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === 'yes' || v === '1') return true;
    if (v === 'false' || v === 'no' || v === '0') return false;
  }
  if (type === 'array' && typeof value === 'string') {
    return value.split(',').map((part) => part.trim()).filter(Boolean);
  }
  if (type === 'array' && !Array.isArray(value)) return [value];
  return value;
}

function normaliseArgs(name, args) {
  const spec = NATIVE_ARG_SPECS.get(name);
  if (!spec || !args || typeof args !== 'object') return args || {};

  const out = {};
  const renamed = [];
  for (const [key, value] of Object.entries(args)) {
    const fold = foldKey(key);
    const canonical = spec.byFold.get(fold) || ARG_SYNONYMS[fold];
    if (!canonical) {
      out[key] = value; // unknown key: hand it over untouched
      continue;
    }
    // Both spellings can arrive at once; the one carrying a value wins.
    const held = out[canonical];
    if (held !== undefined && held !== null && held !== '') continue;
    if (canonical !== key) renamed.push(`${key}->${canonical}`);
    out[canonical] = coerceArg(value, spec.props[canonical]?.type);
  }
  if (renamed.length) log(`${name}: accepted ${renamed.join(', ')}`);
  return out;
}

function runNativeTool(id, name, args) {
  NATIVE_HANDLERS[name](normaliseArgs(name, args))
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
function readOnlyRefusal(name, args) {
  if (NATIVE_TOOL_NAMES.has(name)) return null; // both native tools only read

  const policy = ALLOWED_TOOLS.get(name);
  if (!policy) {
    const offered = [...ALLOWED_TOOLS.keys(), ...NATIVE_TOOL_NAMES].join(', ');
    return (
      `${name} is not available: this ClickUp server is READ-ONLY and exposes ` +
      `no tool that creates, updates or deletes anything. Do not retry it, and ` +
      `do not look for another way to perform the write — report to the user ` +
      `that it is not possible here. Available tools: ${offered}.`
    );
  }

  if (!policy.actions) return null; // nothing to guard on this tool

  const action = String(args?.action ?? '').trim();
  const allowed = [...policy.actions].map((a) => `"${a}"`).join(' or ');
  if (!action) {
    return `${name} requires an action. On this READ-ONLY server the only ` +
      `accepted value is ${allowed}.`;
  }
  if (!policy.actions.has(action)) {
    return (
      `${name} action "${action}" is refused: this ClickUp server is READ-ONLY. ` +
      `Only ${allowed} ${policy.actions.size > 1 ? 'are' : 'is'} accepted. Do ` +
      `not retry, and do not attempt the change through another tool — report ` +
      `to the user that writing is not possible here.`
    );
  }
  return null;
}

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
    const refusal = readOnlyRefusal(name, args);
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
function applyReadOnlySchema(tool) {
  const policy = ALLOWED_TOOLS.get(tool?.name);
  const properties = tool?.inputSchema?.properties;
  if (!policy || !properties) return tool;

  const pruned = { ...properties };
  let changed = false;

  if (policy.actions && pruned.action) {
    const kept = Array.isArray(pruned.action.enum)
      ? pruned.action.enum.filter((value) => policy.actions.has(value))
      : [...policy.actions];
    pruned.action = {
      ...pruned.action,
      enum: kept.length ? kept : [...policy.actions],
      description: `REQUIRED. Read-only server: ${
        [...policy.actions].map((a) => `"${a}"`).join(' or ')
      } only.`,
    };
    changed = true;
  }

  for (const [name, values] of Object.entries(ENUM_OVERRIDES[tool?.name] || {})) {
    if (!pruned[name]) continue;
    pruned[name] = { ...pruned[name], enum: values };
    changed = true;
  }

  for (const name of WRITE_ONLY_PARAMS[tool?.name] || []) {
    if (name in pruned) {
      delete pruned[name];
      changed = true;
    }
  }

  if (!changed) return tool;
  return { ...tool, inputSchema: { ...tool.inputSchema, properties: pruned } };
}

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
      msg.result.tools = msg.result.tools
        // Layer 3. The child should already be filtered, but a tool it offers
        // that the policy does not cover is dropped rather than trusted.
        .filter((tool) => ALLOWED_TOOLS.has(tool?.name))
        .map(applyReadOnlySchema)
        .map((tool) => {
          const override = DESCRIPTION_OVERRIDES[tool?.name];
          const suffix = DESCRIPTION_SUFFIXES[tool?.name];
          if (!override && !suffix) return tool;
          const base = override ?? tool.description ?? '';
          return { ...tool, description: suffix ? `${base}${suffix}` : base };
        });
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
