// End-to-end over the real stdio protocol: the server is spawned exactly as a
// host would spawn it. Credentials are fake and nothing here reaches ClickUp —
// every case is answered before the first request would be made.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const SERVER = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
const ENV = { CLICKUP_API_KEY: 'pk_fake', CLICKUP_TEAM_ID: '9012345678' };

// Feeds the server a list of messages, collects what it writes back, and
// resolves once it has answered every id it was given.
function talk(messages, { env = {}, expected = messages.length } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...ENV, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const replies = [];
    let out = '';
    let err = '';
    const done = (value) => {
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(
      () => done({ replies, stderr: err, code: null, timedOut: true }),
      15000,
    );

    child.stdout.on('data', (chunk) => {
      out += chunk;
      const lines = out.split('\n');
      out = lines.pop();
      for (const line of lines) {
        if (line.trim()) replies.push(JSON.parse(line));
      }
      if (replies.length >= expected) done({ replies, stderr: err, code: null });
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => done({ replies, stderr: err, code }));

    for (const message of messages) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }
  });
}

const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  },
};
const listTools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

let handshake;
const shared = async () => {
  handshake ??= await talk([initialize, listTools]);
  return handshake;
};

const call = (id, name, args) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, ...(args === undefined ? {} : { arguments: args }) },
});

test('initialize answers as this server, not as the one it wraps', async () => {
  const { replies } = await shared();
  const info = replies.find((r) => r.id === 1)?.result?.serverInfo;

  assert.equal(info.name, 'clickup-mcp-read');
  assert.match(info.version, /^\d+\.\d+\.\d+$/);
});

test('tools/list returns the read-only set, native tools included', async () => {
  const { replies } = await shared();
  const names = replies.find((r) => r.id === 2).result.tools.map((t) => t.name);

  assert.equal(names.length, 9);
  for (const expected of [
    'get_task_tree',
    'get_task_activity',
    'get_workspace_hierarchy',
    'search_tasks',
    'task_comments',
    'get_container',
    'find_members',
    'operate_tags',
    'task_time_tracking',
  ]) {
    assert.ok(names.includes(expected), `${expected} is exposed`);
  }
});

test('no write tool is ever advertised', async () => {
  const { replies } = await shared();
  const names = replies.find((r) => r.id === 2).result.tools.map((t) => t.name);

  for (const write of [
    'manage_task',
    'manage_container',
    'attach_file_to_task',
    'manage_document',
  ]) {
    assert.equal(names.includes(write), false, `${write} must not be listed`);
  }
});

test('every exposed tool is annotated read-only and non-destructive', async () => {
  const { replies } = await shared();
  const tools = replies.find((r) => r.id === 2).result.tools;

  for (const tool of tools) {
    const a = tool.annotations;
    assert.ok(a, `${tool.name} carries annotations`);
    assert.equal(a.readOnlyHint, true, `${tool.name} is read-only`);
    assert.equal(a.destructiveHint, false, `${tool.name} is not destructive`);
    for (const hint of ['idempotentHint', 'openWorldHint']) {
      assert.equal(typeof a[hint], 'boolean', `${tool.name}.${hint}`);
    }
  }
});

test('the advertised schema offers no write action', async () => {
  const { replies } = await shared();
  const tools = replies.find((r) => r.id === 2).result.tools;
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  assert.deepEqual(
    byName.task_comments.inputSchema.properties.action.enum,
    ['get'],
  );
  assert.deepEqual(
    byName.task_time_tracking.inputSchema.properties.action.enum,
    ['get_entries', 'get_current'],
  );
  assert.deepEqual(byName.operate_tags.inputSchema.properties.action.enum, ['list']);
  assert.deepEqual(byName.operate_tags.inputSchema.properties.scope.enum, ['space']);
  // the parameters that only exist to carry a write are gone with them
  assert.equal(
    'commentText' in byName.task_comments.inputSchema.properties,
    false,
  );
  assert.equal(
    'timeEntryId' in byName.task_time_tracking.inputSchema.properties,
    false,
  );
});

test('search_tasks carries the rewritten description', async () => {
  const { replies } = await shared();
  const tools = replies.find((r) => r.id === 2).result.tools;
  const search = tools.find((t) => t.name === 'search_tasks');
  const comments = tools.find((t) => t.name === 'task_comments');

  assert.match(search.description, /Pick ONE of three modes/);
  assert.match(comments.description, /call get_task_activity/);
});

test('a write tool named directly is refused, not forwarded', async () => {
  const { replies } = await talk(
    [
      call(1, 'manage_task', { action: 'create', name: 'x', listId: '1' }),
      call(2, 'manage_container', { type: 'list', action: 'delete', listId: '1' }),
      call(3, 'attach_file_to_task', { taskId: '1', file_path: '/etc/passwd' }),
      call(4, 'manage_document', { action: 'create', name: 'x' }),
    ],
    { expected: 4 },
  );

  assert.equal(replies.length, 4);
  for (const reply of replies) {
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /READ-ONLY/);
  }
});

test('a write action on an allowed tool is refused, not forwarded', async () => {
  const { replies } = await talk(
    [
      call(1, 'task_comments', { action: 'create', taskId: '1', commentText: 'hi' }),
      call(2, 'task_time_tracking', { action: 'start', taskId: '1' }),
      call(3, 'task_time_tracking', { action: 'delete_entry', timeEntryId: '1' }),
      call(4, 'operate_tags', { scope: 'space', action: 'delete', spaceId: '1' }),
      call(5, 'operate_tags', { scope: 'task', action: 'add', taskId: '1' }),
    ],
    { expected: 5 },
  );

  assert.equal(replies.length, 5);
  for (const reply of replies) {
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /READ-ONLY/);
  }
});

test('a refusal tells the agent to stop rather than route around it', async () => {
  const { replies } = await talk([call(1, 'manage_task', { action: 'create' })], {
    expected: 1,
  });

  const text = replies[0].result.content[0].text;
  assert.match(text, /Do not retry/);
  assert.match(text, /not possible here/);
});

test('ENABLED_TOOLS cannot put a write tool back over the wire', async () => {
  const { replies, stderr } = await talk([initialize, listTools], {
    env: { ENABLED_TOOLS: 'manage_task,search_tasks,attach_file_to_task' },
  });
  const names = replies.find((r) => r.id === 2).result.tools.map((t) => t.name);

  assert.equal(names.includes('manage_task'), false);
  assert.equal(names.includes('attach_file_to_task'), false);
  assert.ok(names.includes('search_tasks'));
  assert.match(stderr, /ignoring write-capable ENABLED_TOOLS entries/);
});

test('a native tool reports a missing taskId instead of calling ClickUp', async () => {
  const { replies } = await talk(
    [call(1, 'get_task_tree', {}), call(2, 'get_task_activity', {})],
    { expected: 2 },
  );

  for (const reply of replies) {
    assert.equal(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /taskId is required/);
  }
});

test('a native tool call with no arguments at all is answered, not dropped', async () => {
  const { replies } = await talk([call(1, 'get_task_tree')], { expected: 1 });

  assert.equal(replies[0].result.isError, true);
});

test('a JSON-RPC batch is refused rather than forwarded', async () => {
  const { replies } = await talk(
    [[{ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }]],
    { expected: 1 },
  );

  assert.equal(replies[0].id, 7);
  assert.equal(replies[0].error.code, -32600);
});

test('missing credentials stop the server with a message naming them', async () => {
  const { code, stderr } = await talk([], { env: { CLICKUP_API_KEY: '' }, expected: 0 });

  assert.equal(code, 1);
  assert.match(stderr, /missing required environment: CLICKUP_API_KEY/);
});

test('CLICKUP_MCP_ENTRY cannot point the token at code outside the package', async () => {
  const { code, stderr } = await talk([], {
    env: { CLICKUP_MCP_ENTRY: '/tmp/not-the-server.js' },
    expected: 0,
  });

  assert.equal(code, 1);
  assert.match(stderr, /refusing CLICKUP_MCP_ENTRY/);
});

test('--version prints the version and exits', async () => {
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER, '--version'], {
      env: { PATH: process.env.PATH, ...ENV },
    });
    let text = '';
    child.stdout.on('data', (c) => (text += c));
    child.on('exit', () => resolve(text));
  });

  assert.match(out.trim(), /^\d+\.\d+\.\d+$/);
});

after(() => {
  handshake = null;
});
