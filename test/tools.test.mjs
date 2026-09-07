// The read-only policy and the shaping it applies, tested as pure functions:
// no process, no network, no ClickUp.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyReadOnlySchema,
  buildReadOnlyPolicy,
  coerceArg,
  decorateChildTools,
  DESCRIPTION_OVERRIDES,
  NATIVE_TOOLS,
  normaliseArgs,
  readOnlyRefusal,
  resolveAllowedTools,
  TOOL_ANNOTATIONS,
} from '../src/tools.mjs';

const allow = (env = {}) => resolveAllowedTools(env).allowed;

// ── The policy itself ──────────────────────────────────────────────────────

test('no write tool is reachable, by any name', () => {
  const allowed = allow();
  for (const write of [
    'manage_task',
    'manage_container',
    'attach_file_to_task',
    'manage_document',
  ]) {
    assert.equal(allowed.has(write), false, `${write} must not be exposed`);
    assert.match(readOnlyRefusal(write, {}, allowed), /READ-ONLY/);
  }
});

test('every multi-action tool is pinned to reading actions only', () => {
  const allowed = allow();
  assert.deepEqual([...allowed.get('task_comments').actions], ['get']);
  assert.deepEqual(
    [...allowed.get('task_time_tracking').actions],
    ['get_entries', 'get_current'],
  );
  assert.deepEqual([...allowed.get('operate_tags').actions], ['list']);
});

test('a write action on an allowed tool is refused', () => {
  const allowed = allow();
  for (const [name, action] of [
    ['task_comments', 'create'],
    ['task_time_tracking', 'start'],
    ['task_time_tracking', 'delete_entry'],
    ['operate_tags', 'create'],
    ['operate_tags', 'delete'],
    ['operate_tags', 'add'],
  ]) {
    const refusal = readOnlyRefusal(name, { action }, allowed);
    assert.ok(refusal, `${name}/${action} must be refused`);
    assert.match(refusal, /READ-ONLY/);
  }
});

test('a reading action on an allowed tool proceeds', () => {
  const allowed = allow();
  assert.equal(readOnlyRefusal('task_comments', { action: 'get' }, allowed), null);
  assert.equal(
    readOnlyRefusal('task_time_tracking', { action: 'get_current' }, allowed),
    null,
  );
  assert.equal(readOnlyRefusal('search_tasks', {}, allowed), null);
});

test('both native tools are always allowed', () => {
  for (const tool of NATIVE_TOOLS) {
    assert.equal(readOnlyRefusal(tool.name, {}, new Map()), null);
  }
});

test('a missing action is reported rather than passed through', () => {
  const refusal = readOnlyRefusal('task_comments', {}, allow());
  assert.match(refusal, /requires an action/);
});

// ── ENABLED_TOOLS may narrow, never widen ──────────────────────────────────

test('ENABLED_TOOLS cannot put a write tool back', () => {
  const { allowed, ignored } = resolveAllowedTools({
    ENABLED_TOOLS: 'manage_task,search_tasks,attach_file_to_task',
  });
  assert.equal(allowed.has('manage_task'), false);
  assert.equal(allowed.has('attach_file_to_task'), false);
  assert.equal(allowed.has('search_tasks'), true);
  assert.deepEqual(ignored, ['manage_task', 'attach_file_to_task']);
});

test('ENABLED_TOOLS narrows the set', () => {
  const allowed = allow({ ENABLED_TOOLS: 'search_tasks' });
  assert.deepEqual([...allowed.keys()], ['search_tasks']);
});

test('DISABLED_TOOLS only subtracts', () => {
  const allowed = allow({ DISABLED_TOOLS: 'operate_tags,find_members' });
  assert.equal(allowed.has('operate_tags'), false);
  assert.equal(allowed.has('find_members'), false);
  assert.equal(allowed.has('search_tasks'), true);
});

test('the document tools appear only when DOCUMENT_SUPPORT is on', () => {
  assert.equal(buildReadOnlyPolicy().has('list_documents'), false);
  const on = buildReadOnlyPolicy({ documentSupport: true });
  assert.equal(on.has('list_documents'), true);
  assert.deepEqual([...on.get('manage_document_page').actions], ['get', 'list']);
});

// ── Annotations ────────────────────────────────────────────────────────────

test('every native tool declares all four annotation hints as booleans', () => {
  for (const tool of NATIVE_TOOLS) {
    const a = tool.annotations;
    assert.ok(a, `${tool.name} has annotations`);
    for (const hint of [
      'readOnlyHint',
      'destructiveHint',
      'idempotentHint',
      'openWorldHint',
    ]) {
      assert.equal(typeof a[hint], 'boolean', `${tool.name}.${hint}`);
    }
  }
});

test('every tool this server can expose is annotated read-only', () => {
  const names = [
    ...buildReadOnlyPolicy({ documentSupport: true }).keys(),
    ...NATIVE_TOOLS.map((t) => t.name),
  ];
  for (const name of names) {
    const a = TOOL_ANNOTATIONS[name] ?? NATIVE_TOOLS.find((t) => t.name === name)?.annotations;
    assert.ok(a, `${name} has an annotation`);
    assert.equal(a.readOnlyHint, true, `${name} is read-only`);
    assert.equal(a.destructiveHint, false, `${name} is not destructive`);
  }
});

// ── Shaping the advertised list ────────────────────────────────────────────

test('decorateChildTools drops a tool the policy does not cover', () => {
  const out = decorateChildTools(
    [{ name: 'manage_task', description: 'x' }, { name: 'search_tasks', description: 'y' }],
    allow(),
  );
  assert.deepEqual(out.map((t) => t.name), ['search_tasks']);
});

test('decorateChildTools prunes write actions out of the advertised enum', () => {
  const [tool] = decorateChildTools(
    [
      {
        name: 'task_comments',
        description: 'x',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['get', 'create'] },
            commentText: { type: 'string' },
            taskId: { type: 'string' },
          },
        },
      },
    ],
    allow(),
  );
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['get']);
  assert.equal('commentText' in tool.inputSchema.properties, false);
  assert.equal('taskId' in tool.inputSchema.properties, true);
});

test('operate_tags loses the task scope it can no longer act on', () => {
  const [tool] = decorateChildTools(
    [
      {
        name: 'operate_tags',
        description: 'x',
        inputSchema: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['space', 'task'] },
            action: { type: 'string', enum: ['list', 'create', 'add'] },
            spaceId: { type: 'string' },
            taskId: { type: 'string' },
            tagName: { type: 'string' },
          },
        },
      },
    ],
    allow(),
  );
  assert.deepEqual(tool.inputSchema.properties.scope.enum, ['space']);
  assert.deepEqual(tool.inputSchema.properties.action.enum, ['list']);
  assert.equal('taskId' in tool.inputSchema.properties, false);
  assert.equal('tagName' in tool.inputSchema.properties, false);
});

test('decorateChildTools rewrites the description that misleads small models', () => {
  const [tool] = decorateChildTools(
    [{ name: 'search_tasks', description: 'Works 3 ways...' }],
    allow(),
  );
  assert.equal(tool.description, DESCRIPTION_OVERRIDES.search_tasks);
  assert.match(tool.description, /A plain id like "86capt3b" is a taskId/);
});

test('an annotation upstream declares itself wins over ours', () => {
  const [tool] = decorateChildTools(
    [{ name: 'search_tasks', description: 'x', annotations: { title: 'Upstream title' } }],
    allow(),
  );
  assert.equal(tool.annotations.title, 'Upstream title');
  assert.equal(tool.annotations.readOnlyHint, true);
});

test('applyReadOnlySchema leaves a tool with nothing to prune alone', () => {
  const tool = { name: 'search_tasks', inputSchema: { properties: { taskId: {} } } };
  assert.equal(applyReadOnlySchema(tool, { actions: null }), tool);
});

// ── Argument normalisation ─────────────────────────────────────────────────

test('normaliseArgs accepts the spellings a small model reaches for', () => {
  const { args, renamed } = normaliseArgs('get_task_tree', {
    task_id: '86capt3b',
    include_closed: 'false',
    max_depth: '3',
  });
  assert.equal(args.taskId, '86capt3b');
  assert.equal(args.include_closed, false);
  assert.equal(args.max_depth, 3);
  assert.ok(renamed.includes('task_id->taskId'));
});

test('normaliseArgs reads a bare id or task as the task id', () => {
  assert.equal(normaliseArgs('get_task_activity', { id: 'abc' }).args.taskId, 'abc');
  assert.equal(normaliseArgs('get_task_activity', { task: 'abc' }).args.taskId, 'abc');
});

test('normaliseArgs answers a call with no arguments at all', () => {
  assert.deepEqual(normaliseArgs('get_task_tree', undefined), { args: {}, renamed: [] });
  assert.deepEqual(normaliseArgs('get_task_tree', null), { args: {}, renamed: [] });
});

test('coerceArg turns a string into the declared type', () => {
  assert.equal(coerceArg('true', 'boolean'), true);
  assert.equal(coerceArg('no', 'boolean'), false);
  assert.equal(coerceArg('15', 'number'), 15);
  assert.deepEqual(coerceArg('status,due_date', 'array'), ['status', 'due_date']);
});
