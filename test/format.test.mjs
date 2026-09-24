import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  actorName,
  clip,
  commentText,
  customFieldValue,
  formatDuration,
  formatStamp,
  indexByParent,
  normaliseHistoryEntry,
  parseSince,
  renderStatuses,
  renderTaskCard,
  renderTree,
  valueLabel,
} from '../src/format.mjs';

const task = (id, name, parent = null, extra = {}) => ({
  id,
  name,
  parent,
  status: { status: 'open' },
  ...extra,
});

test('renderTree nests every level, not just the direct children', () => {
  const root = task('a', 'root');
  const pool = [
    root,
    task('b', 'child', 'a'),
    task('c', 'grandchild', 'b'),
    task('d', 'great-grandchild', 'c'),
  ];
  const { text, count } = renderTree(root, indexByParent(pool), 10);

  assert.equal(count, 4);
  assert.match(text, /^a {2}\[open] {2}root$/m);
  assert.match(text, /^ {2}b {2}\[open] {2}child$/m);
  assert.match(text, /^ {4}c/m);
  assert.match(text, /^ {6}d/m);
});

test('renderTree tallies statuses and renders assignees and custom ids', () => {
  const root = task('a', 'root', null, {
    custom_id: 'DEV-1',
    assignees: [{ username: 'olena' }, { email: 'ivan@example.com' }],
  });
  const pool = [root, task('b', 'child', 'a', { status: { status: 'complete' } })];
  const { text, summary, count } = renderTree(root, indexByParent(pool), 10);

  assert.equal(count, 2);
  assert.match(text, /a \(DEV-1\) {2}\[open] {2}root {2}<olena, ivan@example\.com>/);
  assert.match(summary, /open: 1/);
  assert.match(summary, /complete: 1/);
});

test('renderTree stops at max_depth and says how much it hid', () => {
  const root = task('a', 'root');
  const pool = [root, task('b', 'child', 'a'), task('c', 'hidden', 'b')];
  const { text, count } = renderTree(root, indexByParent(pool), 1);

  assert.equal(count, 2);
  assert.match(text, /\.\.\. 1 more, depth limit reached/);
  assert.doesNotMatch(text, /hidden/);
});

test('renderTree survives a parent cycle instead of recursing forever', () => {
  const root = task('a', 'root', 'b');
  const pool = [root, task('b', 'child', 'a')];
  const { count } = renderTree(root, indexByParent(pool), 10);

  assert.equal(count, 2);
});

test('indexByParent ignores tasks with no parent', () => {
  const byParent = indexByParent([task('a', 'root'), task('b', 'child', 'a')]);

  assert.deepEqual([...byParent.keys()], ['a']);
  assert.equal(byParent.get('a').length, 1);
});

test('valueLabel reduces the shapes ClickUp history actually returns', () => {
  assert.equal(valueLabel('status', { status: 'in progress' }), 'in progress');
  assert.equal(valueLabel('tag', [{ name: 'blocked' }, { name: 'billing' }]), 'blocked, billing');
  assert.equal(valueLabel('assignee_add', { username: 'ivan' }), 'ivan');
  assert.equal(valueLabel('status', null), 'none');
  assert.equal(valueLabel('tag', []), 'none');
  assert.equal(valueLabel('due_date', '1772496000000'), formatStamp('1772496000000'));
});

test('durations and stamps read as time, not as milliseconds', () => {
  assert.equal(formatDuration(3600000), '1h');
  assert.equal(formatDuration(5400000), '1h 30m');
  assert.equal(formatDuration(900000), '15m');
  assert.equal(formatStamp(0), '0');
  assert.match(formatStamp(1772496000000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('clip flattens whitespace and marks what it cut', () => {
  assert.equal(clip('  a\n\n  b  ', 80), 'a b');
  assert.equal(clip('abcdef', 3), 'abc…');
});

test('commentText reads both comment shapes', () => {
  assert.equal(commentText({ comment_text: 'plain' }), 'plain');
  assert.equal(commentText({ comment: [{ text: 'rich ' }, { text: 'text' }] }), 'rich text');
  assert.equal(commentText(null), '');
});

test('actorName falls back through username, email, id', () => {
  assert.equal(actorName({ username: 'olena' }), 'olena');
  assert.equal(actorName({ email: 'ivan@example.com' }), 'ivan@example.com');
  assert.equal(actorName({ id: 7 }), 'user 7');
  assert.equal(actorName(undefined), 'unknown');
});

test('normaliseHistoryEntry renders a change as before → after', () => {
  const event = normaliseHistoryEntry({
    field: 'status',
    date: '1772496000000',
    user: { username: 'ivan' },
    before: { status: 'to do' },
    after: { status: 'in progress' },
  });

  assert.equal(event.who, 'ivan');
  assert.equal(event.detail, 'Status: to do → in progress');
  assert.equal(event.commentId, null);
});

test('normaliseHistoryEntry does not render "none →" for additive events', () => {
  const event = normaliseHistoryEntry({
    field: 'tag',
    date: '1772496000000',
    user: { username: 'olena' },
    after: [{ name: 'blocked' }],
  });

  assert.equal(event.detail, 'Tags: blocked');
});

test('normaliseHistoryEntry names the custom field it touched', () => {
  const event = normaliseHistoryEntry({
    field: 'custom_field',
    date: '1',
    custom_field: { name: 'Sprint' },
    after: 'S-14',
  });

  assert.equal(event.detail, 'Custom field "Sprint": S-14');
});

test('normaliseHistoryEntry carries the comment id, for de-duplication', () => {
  const event = normaliseHistoryEntry({
    field: 'comment',
    date: '1',
    user: { username: 'ivan' },
    comment: { id: 42, comment_text: 'moving on' },
  });

  assert.equal(event.commentId, '42');
  assert.equal(event.detail, 'moving on');
});

test('parseSince accepts an ISO date, a timestamp, and nothing', () => {
  assert.equal(parseSince(undefined), null);
  assert.equal(parseSince(''), null);
  assert.equal(parseSince('1772496000000'), 1772496000000);
  assert.equal(parseSince('2026-03-01'), Date.parse('2026-03-01'));
  assert.throws(() => parseSince('last tuesday'), /could not read "since" as a date/);
});

const dropDown = (value) => ({
  name: 'Stage',
  type: 'drop_down',
  value,
  type_config: {
    options: [
      { id: 'opt-a', name: 'Design', orderindex: 0 },
      { id: 'opt-b', name: 'Build', orderindex: 1 },
    ],
  },
});

test('customFieldValue resolves a drop-down by orderindex or by option id', () => {
  assert.equal(customFieldValue(dropDown(1)), 'Build');
  assert.equal(customFieldValue(dropDown('opt-a')), 'Design');
  assert.equal(customFieldValue(dropDown(7)), '7', 'an unknown option stays visible');
});

test('customFieldValue resolves labels, dates, people, tasks and progress', () => {
  const labels = {
    type: 'labels',
    value: ['l1', 'l2'],
    type_config: { options: [{ id: 'l1', label: 'backend' }, { id: 'l2', label: 'urgent' }] },
  };
  assert.equal(customFieldValue(labels), 'backend, urgent');
  assert.equal(customFieldValue({ type: 'date', value: '1772496000000' }), '2026-03-03 00:00');
  assert.equal(customFieldValue({ type: 'users', value: [{ username: 'olena' }] }), 'olena');
  assert.equal(
    customFieldValue({ type: 'tasks', value: [{ id: '86captk1', name: 'Audit schema' }] }),
    'Audit schema (86captk1)',
  );
  assert.equal(
    customFieldValue({ type: 'automatic_progress', value: { percent_complete: 40 } }),
    '40%',
  );
  assert.equal(customFieldValue({ type: 'checkbox', value: 'true' }), 'yes');
  assert.equal(customFieldValue({ type: 'short_text', value: 'S-14' }), 'S-14');
});

test('customFieldValue returns null for an unset field', () => {
  assert.equal(customFieldValue({ type: 'short_text' }), null);
  assert.equal(customFieldValue({ type: 'short_text', value: '' }), null);
  assert.equal(customFieldValue({ type: 'labels', value: [] }), null);
});

test('renderStatuses orders by board position and names the type', () => {
  const lines = renderStatuses([
    { status: 'complete', type: 'closed', orderindex: 2 },
    { status: 'to do', type: 'open', orderindex: 0 },
    { status: 'in progress', type: 'custom', orderindex: 1 },
  ]);

  assert.deepEqual(lines, ['to do (open)', 'in progress (custom)', 'complete (closed)']);
});

const fullTask = () => ({
  id: '86capt3b',
  custom_id: 'DEV-12',
  name: 'Migrate billing service',
  url: 'https://app.clickup.com/t/86capt3b',
  status: { status: 'in progress' },
  priority: { id: '2', priority: 'high' },
  list: { id: '900100', name: 'Q3 Delivery' },
  folder: { name: 'Platform', hidden: false },
  parent: '86capt00',
  subtasks: [{ id: '86captk1' }, { id: '86captk2' }],
  assignees: [{ username: 'ivan' }],
  watchers: [{ username: 'olena' }],
  creator: { username: 'olena' },
  date_created: '1772359200000',
  due_date: '1773316800000',
  time_estimate: 14400000,
  time_spent: 5400000,
  tags: [{ name: 'billing' }],
  custom_fields: [dropDown(1), { name: 'Notes', type: 'short_text' }],
  checklists: [
    {
      name: 'Cutover',
      items: [
        { name: 'Freeze writes', resolved: true },
        { name: 'Switch DNS', resolved: false },
      ],
    },
  ],
  dependencies: [
    { task_id: '86capt3b', depends_on: '86captk9' },
    { task_id: '86captz1', depends_on: '86capt3b' },
  ],
  linked_tasks: [{ task_id: '86capt3b', link_id: '86captl4' }],
  description: 'plain copy',
  markdown_description: '## Goal\n\nMove billing off the monolith.',
});

test('renderTaskCard shows every field an agent reads before acting', () => {
  const card = renderTaskCard(fullTask(), {
    statuses: [
      { status: 'to do', type: 'open', orderindex: 0 },
      { status: 'done', type: 'closed', orderindex: 1 },
    ],
  });

  assert.match(card, /^Task 86capt3b \(DEV-12\): Migrate billing service$/m);
  assert.match(card, /^Status: in progress {3}Priority: high$/m);
  assert.match(card, /^List: Q3 Delivery \(900100\) {3}Folder: Platform$/m);
  assert.match(card, /^Parent task: 86capt00$/m);
  assert.match(card, /^Subtasks: 2 direct/m);
  assert.match(card, /^Assignees: ivan$/m);
  assert.match(card, /^Created: 2026-03-01 10:00 by olena$/m);
  assert.match(card, /Due: 2026-03-12 12:00/);
  assert.match(card, /^Time estimate: 4h {3}Time tracked: 1h 30m$/m);
  assert.match(card, /^Tags: billing$/m);
  assert.match(card, /^ {2}Stage: Build$/m);
  assert.match(card, /^Checklist "Cutover" \(1\/2\):$/m);
  assert.match(card, /^ {2}\[x] Freeze writes$/m);
  assert.match(card, /^Waiting on: 86captk9$/m);
  assert.match(card, /^Blocking: 86captz1$/m);
  assert.match(card, /^Linked tasks: 86captl4$/m);
  assert.match(card, /^Statuses in this list: to do \(open\), done \(closed\)$/m);
});

test('renderTaskCard leaves unset custom fields out', () => {
  assert.doesNotMatch(renderTaskCard(fullTask()), /Notes/);
});

test('renderTaskCard prints the whole markdown description, last', () => {
  const card = renderTaskCard(fullTask());

  assert.ok(card.endsWith('Description:\n## Goal\n\nMove billing off the monolith.'));
  assert.doesNotMatch(card, /plain copy/, 'the plain duplicate is not repeated');
});

test('renderTaskCard survives a bare task', () => {
  const card = renderTaskCard({ id: 'x1', name: 'bare' });

  assert.match(card, /^Task x1: bare$/m);
  assert.match(card, /^Status: no status$/m);
  assert.match(card, /^Assignees: none$/m);
  assert.ok(card.endsWith('Description:\n(empty)'));
});
