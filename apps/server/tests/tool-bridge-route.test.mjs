import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChatGptBackendClient } from '@mirror/protocol';
import { stubBackend } from './helpers/backend.mjs';

const dir = mkdtempSync(path.join(tmpdir(), 'mirror-tool-bridge-'));
process.env.MIRROR_DATA_DIR = dir;
process.env.MIRROR_API_KEY = 'fixture-mirror-key';
const store = await import('../dist/store.js');
store.saveVerifiedSession('fixture-session', 'tool-bridge-test');
store.updateMintedToken('fixture-access', Date.now() + 3600000, null);
const { buildApp } = await import('../dist/index.js');
const { toolBridgeErrorMessage } = await import('../dist/openai.js');
const tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];

test.describe('server / tool bridge route', () => {
  test('formats Error and non-Error tool-bridge failures', () => {
    assert.equal(toolBridgeErrorMessage(new Error('fixture failure')), 'fixture failure');
    assert.equal(toolBridgeErrorMessage('primitive failure'), 'Tool bridge failed');
  });

  test.after(() => rmSync(dir, { recursive: true, force: true }));
  async function request(stream, text, messages = [{ role: 'user', content: 'Read a.txt' }], options = {}) {
    const app = await buildApp({ worker: true });
    options.onApp?.(app);
    test.mock.method(globalThis, 'fetch', stubBackend('tool-bridge-test'));
    test.mock.method(ChatGptBackendClient.prototype, 'sendMessage', options.sendMessage ?? (async () => ({
      conversationId: 'upstream-test', messageId: 'assistant-test', userMessageId: 'user-test', status: 'done', events: [], text,
    })));
    try {
      return await app.inject({ method: 'POST', url: '/v1/chat/completions', headers: { authorization: 'Bearer fixture-mirror-key' },
        payload: { model: 'auto', messages, tools, stream, stream_options: { include_usage: true }, reasoning_effort: 'high', ...options.payload } });
    } finally { test.mock.restoreAll(); await app.close(); }
  }
  test('defaults missing tool definitions to an empty list when prior tool-call messages are present', async () => {
    const response = await request(false, '{"content":"done"}', [
      { role: 'user', content: 'Read a.txt' },
      { role: 'assistant', content: null, tool_calls: [] },
    ], { payload: { tools: undefined } });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().choices[0].message.content, 'done');
  });

  test('rejects Work Mode models before starting a tool-bridge turn', async () => {
    const response = await request(false, '{"content":"unused"}', undefined, {
      payload: { model: 'g-1', metadata: { mirror_model: 'gpt-5-wm' } },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.match(response.json().error.message, /Work Mode/);
  });

  test('returns a nonstreamed function request', async () => {
    const response = await request(false, '{"tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}', [
      { role: 'user', name: 'requester', content: 'Read a.txt' },
    ]);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().choices[0].finish_reason, 'tool_calls');
    assert.equal(response.json().choices[0].message.tool_calls[0].function.name, 'read_file');
  });
  test('streams a structured SSE error when a tool-bridge turn fails', async () => {
    const response = await request(true, 'not json');
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.body, /\"error\"/);
    assert.match(response.body, /data: \[DONE\]/);
  });

  test('emits a keepalive chunk while a streamed tool-bridge response is pending', async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let heartbeat;
    let release;
    let markStarted;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { markStarted = resolve; });
    try {
      const pending = request(true, '{"content":"done"}', undefined, {
        onApp() {
          globalThis.setInterval = (callback) => { heartbeat = callback; return 123; };
          globalThis.clearInterval = () => {};
        },
        sendMessage: async () => {
          markStarted();
          await gate;
          return {
            conversationId: 'upstream-test', messageId: 'assistant-test', userMessageId: 'user-test',
            status: 'done', events: [], text: '{"content":"done"}',
          };
        },
      });
      await started;
      assert.equal(typeof heartbeat, 'function');
      heartbeat();
      release();
      const response = await pending;
      assert.equal(response.statusCode, 200, response.body);
      assert.match(response.body, /"delta":\{\}/);
      heartbeat();
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test('streams a function request and accepts the following tool result', async () => {
    const response = await request(true, '{"tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}');
    assert.equal(response.statusCode, 200, response.body);
    assert.match(response.body, /"finish_reason":"tool_calls"/);
    assert.match(response.body, /data: \[DONE\]/);
    const next = await request(false, '{"content":"The file says hello."}', [
      { role: 'user', content: 'Read a.txt' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'hello' },
    ]);
    assert.equal(next.statusCode, 200, next.body);
    assert.equal(next.json().choices[0].message.content, 'The file says hello.');
  });
});
