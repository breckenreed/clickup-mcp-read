/**
 * Pure rendering helpers for the native tools.
 *
 * Everything here is a plain function over plain data: no network, no process
 * state. The native tools do their I/O in index.mjs and hand the results to
 * these, which is what makes them testable without a ClickUp workspace (see
 * test/format.test.mjs).
 */

// ClickUp names history entries by the field they touched. Anything not listed
// is rendered under its raw name rather than dropped, so a field added upstream
// still shows up.
export const FIELD_LABELS = {
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

export const DATE_FIELDS = new Set([
  'due_date',
  'start_date',
  'date_closed',
  'date_done',
]);
export const DURATION_FIELDS = new Set(['time_estimate', 'time_spent']);

export const asMillis = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function formatStamp(value) {
  const ms = asMillis(value);
  if (ms === null) return String(value ?? '');
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

export function formatDuration(value) {
  const ms = asMillis(value);
  if (ms === null) return String(value ?? '');
  const minutes = Math.round(ms / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

export const clip = (text, max) => {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

// History values are wildly polymorphic: a scalar, a status/priority/user
// object, or an array of tags. Reduce whatever arrives to one readable token.
export function valueLabel(field, value) {
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

export function commentText(comment) {
  if (!comment) return '';
  if (typeof comment === 'string') return comment;
  if (comment.comment_text) return comment.comment_text;
  if (Array.isArray(comment.comment)) {
    return comment.comment.map((part) => part?.text || '').join('');
  }
  if (typeof comment.comment === 'string') return comment.comment;
  return '';
}

export const actorName = (user) =>
  user?.username || user?.email || (user?.id ? `user ${user.id}` : 'unknown');

// One history entry -> one normalised event. Comments arrive both as history
// entries and from the comment endpoint, so each carries its comment id for
// de-duplication.
export function normaliseHistoryEntry(entry) {
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

export function parseSince(since) {
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


// ClickUp returns a flat list of tasks, each carrying a `parent` pointer; the
// tree is whatever that pointer says. Kept separate from renderTree so a
// caller can index one pool and render several roots out of it.
export function indexByParent(tasks) {
  const childrenBy = new Map();
  for (const task of tasks || []) {
    if (!task?.parent) continue;
    if (!childrenBy.has(task.parent)) childrenBy.set(task.parent, []);
    childrenBy.get(task.parent).push(task);
  }
  return childrenBy;
}

export function renderTree(root, childrenBy, maxDepth) {
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

// ── get_task ───────────────────────────────────────────────────────────────

const PRIORITY_NAMES = { 1: 'urgent', 2: 'high', 3: 'normal', 4: 'low' };

// A custom field's value is stored in whatever shape its type dictates, and
// the option-backed types store a pointer rather than the label: a drop-down
// holds the option's orderindex (or, on some workspaces, its id), labels hold
// option ids. Resolve those against type_config so the reader sees words.
// Returns null for an unset field, so the caller can leave it out.
export function customFieldValue(field) {
  const value = field?.value;
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value) && value.length === 0) return null;
  const options = field?.type_config?.options || [];
  const optionLabel = (ref) => {
    const hit = options.find(
      (o) => o.id === ref || (o.orderindex !== undefined && String(o.orderindex) === String(ref)),
    );
    return hit ? hit.name ?? hit.label ?? String(ref) : String(ref);
  };

  switch (field.type) {
    case 'drop_down':
      return optionLabel(value);
    case 'labels':
      return [].concat(value).map(optionLabel).join(', ');
    case 'date':
      return formatStamp(value);
    case 'checkbox':
      return value === true || value === 'true' ? 'yes' : 'no';
    case 'users':
    case 'people':
      return [].concat(value).map(actorName).join(', ');
    case 'tasks':
      return [].concat(value).map((t) => (t?.name ? `${t.name} (${t.id})` : String(t?.id ?? t))).join(', ');
    case 'automatic_progress':
    case 'manual_progress':
      return value?.percent_complete !== undefined ? `${value.percent_complete}%` : clip(JSON.stringify(value), 120);
    case 'location':
      return value?.formatted_address || clip(JSON.stringify(value), 120);
    default:
      if (typeof value === 'object') return valueLabel(field.type, value);
      return String(value);
  }
}

const joinNames = (people) =>
  (people || []).map(actorName).filter(Boolean).join(', ');

// A dependency row names both ends; which one is "the other task" depends on
// which side this task is on.
function relationLines(task) {
  const lines = [];
  const waitingOn = [];
  const blocking = [];
  for (const dep of task.dependencies || []) {
    if (dep?.task_id === task.id && dep.depends_on) waitingOn.push(dep.depends_on);
    else if (dep?.depends_on === task.id && dep.task_id) blocking.push(dep.task_id);
  }
  if (waitingOn.length) lines.push(`Waiting on: ${waitingOn.join(', ')}`);
  if (blocking.length) lines.push(`Blocking: ${blocking.join(', ')}`);
  const linked = (task.linked_tasks || [])
    .map((l) => (l?.task_id === task.id ? l.link_id : l?.task_id))
    .filter(Boolean);
  if (linked.length) lines.push(`Linked tasks: ${linked.join(', ')}`);
  return lines;
}

export function renderStatuses(statuses) {
  return [...(statuses || [])]
    .sort((a, b) => (a?.orderindex ?? 0) - (b?.orderindex ?? 0))
    .map((s) => `${s.status}${s.type ? ` (${s.type})` : ''}`);
}

// One task, every field an agent reads before acting on it, as a compact
// card rather than the raw object: the raw read repeats the description
// twice, carries every unset custom field and every avatar URL, and leaves
// drop-down values as bare numbers. `statuses`, when given, are the statuses
// of the task's list — what a status change may be set to.
export function renderTaskCard(task, { statuses } = {}) {
  const out = [];
  const custom = task.custom_id ? ` (${task.custom_id})` : '';
  out.push(`Task ${task.id}${custom}: ${task.name}`);
  if (task.url) out.push(`URL: ${task.url}`);

  const priority = task.priority?.priority ?? PRIORITY_NAMES[task.priority?.id];
  out.push(
    `Status: ${task.status?.status || 'no status'}` +
      (priority ? `   Priority: ${priority}` : '') +
      (task.archived ? '   (archived)' : ''),
  );

  const where = [
    task.list?.name ? `List: ${task.list.name} (${task.list.id})` : null,
    task.folder?.name && !task.folder.hidden ? `Folder: ${task.folder.name}` : null,
  ].filter(Boolean);
  if (where.length) out.push(where.join('   '));
  if (task.parent) out.push(`Parent task: ${task.parent}`);
  if (Array.isArray(task.subtasks)) {
    out.push(`Subtasks: ${task.subtasks.length} direct (get_task_tree for all levels)`);
  }

  const assignees = joinNames(task.assignees);
  out.push(`Assignees: ${assignees || 'none'}`);
  const watchers = joinNames(task.watchers);
  if (watchers) out.push(`Watchers: ${watchers}`);

  out.push(
    `Created: ${formatStamp(task.date_created)}` +
      (task.creator ? ` by ${actorName(task.creator)}` : '') +
      (task.date_updated ? `   Updated: ${formatStamp(task.date_updated)}` : ''),
  );
  const dates = [
    asMillis(task.start_date) ? `Start: ${formatStamp(task.start_date)}` : null,
    asMillis(task.due_date) ? `Due: ${formatStamp(task.due_date)}` : null,
    asMillis(task.date_closed) ? `Closed: ${formatStamp(task.date_closed)}` : null,
  ].filter(Boolean);
  if (dates.length) out.push(dates.join('   '));

  const effort = [
    asMillis(task.time_estimate) ? `Time estimate: ${formatDuration(task.time_estimate)}` : null,
    asMillis(task.time_spent) ? `Time tracked: ${formatDuration(task.time_spent)}` : null,
    task.points !== null && task.points !== undefined ? `Points: ${task.points}` : null,
  ].filter(Boolean);
  if (effort.length) out.push(effort.join('   '));

  const tags = (task.tags || []).map((t) => t?.name).filter(Boolean);
  if (tags.length) out.push(`Tags: ${tags.join(', ')}`);

  const fields = (task.custom_fields || [])
    .map((f) => [f?.name, customFieldValue(f)])
    .filter(([, v]) => v !== null);
  if (fields.length) {
    out.push('Custom fields:');
    for (const [name, value] of fields) out.push(`  ${name}: ${value}`);
  }

  for (const list of task.checklists || []) {
    const items = list?.items || [];
    const done = items.filter((i) => i?.resolved).length;
    out.push(`Checklist "${list?.name}" (${done}/${items.length}):`);
    for (const item of items) out.push(`  [${item?.resolved ? 'x' : ' '}] ${item?.name}`);
  }

  out.push(...relationLines(task));

  const files = (task.attachments || []).filter((a) => a && !a.deleted);
  if (files.length) {
    out.push(`Attachments: ${files.map((a) => a.title || a.id).join(', ')}`);
  }

  if (statuses?.length) {
    out.push(`Statuses in this list: ${renderStatuses(statuses).join(', ')}`);
  }

  const description = task.markdown_description ?? task.description ?? task.text_content ?? '';
  out.push('', 'Description:', description.trim() ? description.trim() : '(empty)');
  return out.join('\n');
}
