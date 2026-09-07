/**
 * Tool definitions, the read-only policy, and the shaping this server applies
 * to the tool list before an agent ever sees it.
 *
 * Kept out of index.mjs so it can be tested without spawning a process or
 * touching the network: everything here is a pure function of its arguments.
 */

export const NATIVE_TOOLS = [
  {
    name: 'get_task_tree',
    description:
      'Read a task together with ALL its nested subtasks, at every depth, in ' +
      'ONE call (READ-ONLY). Use this whenever the question involves subtasks, ' +
      'children, breakdown or progress of a task, and never fetch subtasks one ' +
      'by one. Returns a compact indented tree (id, status, name, assignees) ' +
      'plus a status tally, not full task objects.',
    annotations: {
      title: 'Task tree with all nested subtasks',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
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
    annotations: {
      title: 'Full task activity log',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
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

export const NATIVE_TOOL_NAMES = new Set(NATIVE_TOOLS.map((t) => t.name));

// ── The read-only policy ───────────────────────────────────────────────────
//
// Upstream consolidated its tools into multi-action ones, so the read/write
// line falls inside tools rather than between them: task_comments both reads
// comments and posts them. A tool allowlist cannot express "reads only" — the
// unit that has to be filtered is the (tool, action) pair.
//
// A tool absent from this map is refused outright; a tool present with
// `actions: null` has no write mode to guard; a tool present with a set of
// actions is reachable only for those.
//
// Left out entirely, because every action they offer is a write: manage_task
// (create/update/delete/move/duplicate), manage_container (lists and folders),
// attach_file_to_task (uploads a local file into ClickUp) and manage_document.
export function buildReadOnlyPolicy({ documentSupport = false } = {}) {
  const policy = new Map([
    // No write mode at all.
    ['get_workspace_hierarchy', { actions: null }], // spaces -> folders -> lists
    ['search_tasks',            { actions: null }], // by id, by list, or filters
    ['get_container',           { actions: null }], // details of one list/folder
    ['find_members',            { actions: null }], // name or email -> assignee id
    // Multi-action tools, pinned to their reading actions.
    ['task_comments',      { actions: new Set(['get']) }],
    ['task_time_tracking', { actions: new Set(['get_entries', 'get_current']) }],
    ['operate_tags',       { actions: new Set(['list']) }],
  ]);

  // Upstream registers the document tools only when DOCUMENT_SUPPORT is on, so
  // match that: list_documents reads, and manage_document_page — despite the
  // name — has get and list actions worth keeping. Its create/update are not.
  if (documentSupport) {
    policy.set('list_documents', { actions: null });
    policy.set('manage_document_page', { actions: new Set(['get', 'list']) });
  }
  return policy;
}

// Write-only parameters on the surviving multi-action tools. Left in the
// schema they are an invitation an agent will accept and then be refused for.
export const WRITE_ONLY_PARAMS = {
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

// Non-action enums the policy also narrows. With add and remove gone, scope
// "task" has nothing left to do.
export const ENUM_OVERRIDES = {
  operate_tags: { scope: ['space'] },
};

export const parseToolList = (value) =>
  String(value || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

// ENABLED_TOOLS may narrow the read-only set; it may not put a write tool
// back, which is the whole point of this build. DISABLED_TOOLS only subtracts.
// Returns the surviving policy plus the write tools that were asked for and
// ignored, so the caller can say so on stderr.
export function resolveAllowedTools(env = {}) {
  const policy = buildReadOnlyPolicy({
    documentSupport: String(env.DOCUMENT_SUPPORT).trim() === 'true',
  });

  let names = [...policy.keys()];
  const requested = parseToolList(env.ENABLED_TOOLS);
  const ignored = requested.filter((name) => !policy.has(name));
  if (requested.length) names = names.filter((name) => requested.includes(name));

  const denied = parseToolList(env.DISABLED_TOOLS);
  if (denied.length) names = names.filter((name) => !denied.includes(name));

  return {
    allowed: new Map(names.map((name) => [name, policy.get(name)])),
    ignored,
  };
}

// ── Descriptions ───────────────────────────────────────────────────────────

// Replaced outright for the multi-action tools: upstream's text is a tour of
// actions that are not reachable here, and an agent that reads "create (add
// new comment)" will try it. Each of these describes only what survives.
export const DESCRIPTION_OVERRIDES = {
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
};

// ── Tool annotations ───────────────────────────────────────────────────────
//
// MCP hosts use these to decide what to warn about before a call: a read-only
// tool can run unattended, a destructive one should not. Upstream ships none,
// so they are declared here. Four hints on every tool, explicitly true or
// false — a missing hint is not the same claim as `false`, and directories
// (OpenAI's among them) reject tools that leave any of them out.
//
// On this server every one of them is the same claim, because a tool that
// could make any other claim is not exposed at all. That is the annotation
// this build exists to be able to make honestly.
//
// readOnlyHint    the tool cannot modify the workspace
// destructiveHint the tool can remove or overwrite something that existed
// idempotentHint  repeating the same call changes nothing further
// openWorldHint   the tool reaches an external system (always true here:
//                 every one of them talks to the ClickUp API)
const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const TOOL_ANNOTATIONS = {
  get_workspace_hierarchy: { title: 'Workspace hierarchy', ...READ_ONLY },
  search_tasks: { title: 'Find tasks', ...READ_ONLY },
  get_container: { title: 'Read a list or folder', ...READ_ONLY },
  find_members: { title: 'Find a workspace member', ...READ_ONLY },
  task_comments: { title: 'Read task comments', ...READ_ONLY },
  task_time_tracking: { title: 'Read tracked time', ...READ_ONLY },
  operate_tags: { title: 'List the tags in a space', ...READ_ONLY },
  list_documents: { title: 'List documents', ...READ_ONLY },
  manage_document_page: { title: 'Read document pages', ...READ_ONLY },
};

// ── Shaping the tool list ──────────────────────────────────────────────────

// Prune a tool's advertised schema down to what the policy allows: the action
// enum loses its write values, narrowed enums are replaced, and parameters
// that exist only to carry a write lose their place entirely. An agent should
// never see an affordance this server will refuse.
export function applyReadOnlySchema(tool, policy) {
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

// One pass over the tool list the child returns: drop anything the policy does
// not cover, prune what survives, then rewrite descriptions and fill in
// annotations. Upstream's own annotation wins wherever it declares one — this
// fills gaps, it does not overrule the server that implements the tool.
export function decorateChildTools(tools, allowed = new Map()) {
  if (!Array.isArray(tools)) return tools;
  return tools
    .filter((tool) => tool && typeof tool === 'object' && allowed.has(tool.name))
    .map((tool) => {
      const decorated = applyReadOnlySchema(tool, allowed.get(tool.name));
      const override = DESCRIPTION_OVERRIDES[tool.name];
      const defaults = TOOL_ANNOTATIONS[tool.name];
      if (!override && !defaults) return decorated;

      const out = { ...decorated };
      if (override) out.description = override;
      if (defaults) out.annotations = { ...defaults, ...(tool.annotations || {}) };
      return out;
    });
}

// ── Refusals ───────────────────────────────────────────────────────────────

// Returns null when the call may proceed, or the text to refuse it with. Every
// call is checked, including for tools the child would happily run: a client
// can name a tool it was never offered in tools/list.
export function readOnlyRefusal(name, args, allowed = new Map()) {
  if (NATIVE_TOOL_NAMES.has(name)) return null; // both native tools only read

  const policy = allowed.get(name);
  if (!policy) {
    const offered = [...allowed.keys(), ...NATIVE_TOOL_NAMES].join(', ');
    return (
      `${name} is not available: this ClickUp server is READ-ONLY and exposes ` +
      `no tool that creates, updates or deletes anything. Do not retry it, and ` +
      `do not look for another way to perform the write — report to the user ` +
      `that it is not possible here. Available tools: ${offered}.`
    );
  }

  if (!policy.actions) return null; // nothing to guard on this tool

  const action = String(args?.action ?? '').trim();
  const list = [...policy.actions].map((a) => `"${a}"`).join(' or ');
  if (!action) {
    return `${name} requires an action. On this READ-ONLY server the only ` +
      `accepted value is ${list}.`;
  }
  if (!policy.actions.has(action)) {
    return (
      `${name} action "${action}" is refused: this ClickUp server is READ-ONLY. ` +
      `Only ${list} ${policy.actions.size > 1 ? 'are' : 'is'} accepted. Do ` +
      `not retry, and do not attempt the change through another tool — report ` +
      `to the user that writing is not possible here.`
    );
  }
  return null;
}

// ── Argument normalisation ─────────────────────────────────────────────────
//
// Smaller models spell an argument the way the surrounding prose reads, not
// the way the schema declares it: task_id for taskId, "true" for true, a
// comma-separated string for an array. Every one of those used to fail
// silently — an unread taskId became "taskId is required", and
// include_comments "false" is a non-empty string, so it read as true. The map
// is derived from each tool's own inputSchema, so a new argument is covered
// the moment it is declared.

export const foldKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

// Spellings that do not fold to the canonical name on their own.
export const ARG_SYNONYMS = { id: 'taskId', task: 'taskId' };

const NATIVE_ARG_SPECS = new Map(
  NATIVE_TOOLS.map((tool) => {
    const props = tool.inputSchema?.properties || {};
    const byFold = new Map(
      Object.keys(props).map((name) => [foldKey(name), name]),
    );
    return [tool.name, { byFold, props }];
  }),
);

export function coerceArg(value, type) {
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

export function normaliseArgs(name, args) {
  const spec = NATIVE_ARG_SPECS.get(name);
  if (!spec || !args || typeof args !== 'object') {
    return { args: args && typeof args === 'object' ? args : {}, renamed: [] };
  }

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
  return { args: out, renamed };
}
