/**
 * Pure rendering helpers for the native tools.
 *
 * Everything here is a plain function over plain data: no network, no process
 * state. get_task_tree and get_task_activity do their I/O in index.mjs and
 * hand the results to these, which is what makes both tools testable without
 * a ClickUp workspace (see test/format.test.mjs).
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
