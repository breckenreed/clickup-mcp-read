import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  actorName,
  clip,
  commentText,
  formatDuration,
  formatStamp,
  indexByParent,
  normaliseHistoryEntry,
  parseSince,
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
