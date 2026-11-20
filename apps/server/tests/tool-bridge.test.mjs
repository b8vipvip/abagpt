import assert from 'node:assert/strict';
import test from 'node:test';
import { validateToolDefinitions, toolBridgePrompt, parseToolBridgeAnswer } from '../dist/tool-bridge.js';

test.describe('server / tool bridge', () => {
  const tools = validateToolDefinitions([{ type: 'function', function: {
    name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } },
  } }]);
  test('prompts with tool definitions and prior tool results', () => {
    const prompt = toolBridgePrompt([{ role: 'tool', tool_call_id: 'call_1', content: 'file data' }], tools, 'auto');
    assert.match(prompt, /read_file/);
    assert.match(prompt, /file data/);
    assert.match(prompt, /你正在处理一个 Chat Completions 轮次/);
    assert.match(prompt, /只能回复一个 JSON 对象/);
    assert.doesNotMatch(prompt, /You are translating a Chat Completions turn/);
  });
  test('returns OpenAI shaped tool calls with JSON argument strings', () => {
    const answer = parseToolBridgeAnswer('{"tool_calls":[{"name":"read_file","arguments":{"path":"a.txt"}}]}', tools, 'auto');
    assert.equal(answer.content, null);
    assert.match(answer.toolCalls[0].id, /^call_/);
    assert.equal(answer.toolCalls[0].function.arguments, '{"path":"a.txt"}');
  });
  test('accepts a final answer after tool results', () => {
    assert.deepEqual(parseToolBridgeAnswer('{"content":"done"}', tools, 'auto'), { content: 'done' });
  });
  test('rejects unknown functions and invalid arguments', () => {
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"shell","arguments":{}}]}', tools, 'auto'), /未定义的函数/);
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"read_file","arguments":"bad"}]}', tools, 'auto'), /函数参数不是有效的 JSON/);
  });

  test('validates the tool list, function shape, unique names, and optional metadata', () => {
    const definition = (fn) => ({ type: 'function', function: fn });
    assert.throws(() => validateToolDefinitions(null), /tools 必须是最多包含 128 个函数的数组/);
    assert.throws(() => validateToolDefinitions(Array(129).fill(definition({ name: 'read_file' }))), /最多包含 128 个函数/);
    assert.throws(() => validateToolDefinitions([null]), /仅支持 function 类型的工具/);
    assert.throws(() => validateToolDefinitions([{ type: 'custom', function: { name: 'read_file' } }]), /仅支持 function 类型的工具/);
    assert.throws(() => validateToolDefinitions([definition(null)]), /工具名称必须唯一/);
    assert.throws(() => validateToolDefinitions([definition({ name: 42 })]), /工具名称必须唯一/);
    assert.throws(() => validateToolDefinitions([definition({ name: 'bad name' })]), /工具名称必须唯一/);
    assert.throws(() => validateToolDefinitions([definition({ name: 'read_file' }), definition({ name: 'read_file' })]), /工具名称必须唯一/);
    assert.throws(() => validateToolDefinitions([definition({ name: 'read_file', description: 42 })]), /description 必须是字符串/);
    assert.throws(() => validateToolDefinitions([definition({ name: 'read_file', parameters: null })]), /parameters 必须是 JSON 对象/);
    assert.throws(() => validateToolDefinitions([definition({ name: 'read_file', parameters: 'object' })]), /parameters 必须是 JSON 对象/);
    assert.throws(() => validateToolDefinitions([definition({ name: 'read_file', parameters: [] })]), /parameters 必须是 JSON 对象/);
    assert.deepEqual(validateToolDefinitions([definition({ name: 'read_file' })]), [
      { type: 'function', function: { name: 'read_file', description: undefined, parameters: undefined } },
    ]);
  });

  test('selects the matching prompt instruction for none, required, and automatic tool choice', () => {
    assert.match(toolBridgePrompt([], tools, 'none'), /本轮不要请求执行任何函数/);
    assert.match(toolBridgePrompt([], tools, 'required'), /本轮至少请求执行一个函数/);
    assert.match(toolBridgePrompt([], tools, 'auto'), /仅在确有需要时请求执行函数/);
  });

  test('rejects malformed JSON and non-object top-level answers', () => {
    assert.throws(() => parseToolBridgeAnswer('not json', tools, 'auto'), /未返回有效的 tool-bridge JSON 对象/);
    assert.throws(() => parseToolBridgeAnswer('null', tools, 'auto'), /tool-bridge 响应无效/);
    assert.throws(() => parseToolBridgeAnswer('42', tools, 'auto'), /tool-bridge 响应无效/);
    assert.throws(() => parseToolBridgeAnswer('[]', tools, 'auto'), /tool-bridge 响应无效/);
  });

  test('rejects disallowed, excessive, malformed, or unselected function calls', () => {
    const oneCall = JSON.stringify({ tool_calls: [{ name: 'read_file', arguments: {} }] });
    assert.throws(() => parseToolBridgeAnswer(oneCall, tools, 'none'), /不允许的工具调用/);
    const manyCalls = JSON.stringify({ tool_calls: Array(17).fill({ name: 'read_file', arguments: {} }) });
    assert.throws(() => parseToolBridgeAnswer(manyCalls, tools, 'auto'), /不允许的工具调用/);
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[null]}', tools, 'auto'), /未定义的函数/);
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":42,"arguments":{}}]}', tools, 'auto'), /未定义的函数/);
    const twoTools = validateToolDefinitions([
      { type: 'function', function: { name: 'read_file' } },
      { type: 'function', function: { name: 'write_file' } },
    ]);
    assert.throws(() => parseToolBridgeAnswer(
      '{"tool_calls":[{"name":"write_file","arguments":{}}]}',
      twoTools,
      { type: 'function', function: { name: 'read_file' } },
    ), /未定义的函数/);
    assert.deepEqual(parseToolBridgeAnswer(oneCall, tools, { type: 'other' }).toolCalls.length, 1);
    assert.deepEqual(parseToolBridgeAnswer(oneCall, tools, null).toolCalls.length, 1);
    assert.deepEqual(parseToolBridgeAnswer(oneCall, tools, { type: 'function', function: { name: 'read_file' } }).toolCalls.length, 1);
  });

  test('parses string arguments and rejects invalid, null, array, or primitive arguments', () => {
    const parsed = parseToolBridgeAnswer(
      '{"tool_calls":[{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}]}',
      tools,
      'auto',
    );
    assert.equal(parsed.toolCalls[0].function.arguments, '{"path":"a.txt"}');
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"read_file","arguments":"bad"}]}', tools, 'auto'), /函数参数不是有效的 JSON/);
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"read_file","arguments":null}]}', tools, 'auto'), /函数参数必须是 JSON 对象/);
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"read_file","arguments":[]}]}', tools, 'auto'), /函数参数必须是 JSON 对象/);
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"read_file","arguments":1}]}', tools, 'auto'), /函数参数必须是 JSON 对象/);
  });

  test('requires a function when selected and requires string content for final answers', () => {
    assert.throws(() => parseToolBridgeAnswer('{"content":"done"}', tools, 'required'), /未调用所要求的函数/);
    assert.throws(() => parseToolBridgeAnswer('{"content":"done"}', tools, { type: 'function', function: { name: 'read_file' } }), /未调用所要求的函数/);
    assert.throws(() => parseToolBridgeAnswer('{"content":42}', tools, 'auto'), /未返回最终回答或函数调用/);
    assert.deepEqual(parseToolBridgeAnswer('{"tool_calls":[],"content":"done"}', tools, 'auto'), { content: 'done' });
    assert.deepEqual(parseToolBridgeAnswer('{"content":"done"}', tools, null), { content: 'done' });
  });
});
