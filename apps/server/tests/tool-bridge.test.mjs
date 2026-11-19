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
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"shell","arguments":{}}]}', tools, 'auto'), /unknown function/);
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"read_file","arguments":"bad"}]}', tools, 'auto'), /invalid function arguments/);
  });

  test('validates the tool list, function shape, unique names, and optional metadata', () => {
    const definition = (fn) => ({ type: 'function', function: fn });
    assert.throws(() => validateToolDefinitions(null), /tools must be an array/);
    assert.throws(() => validateToolDefinitions(Array(129).fill(definition({ name: 'read_file' }))), /at most 128/);
    assert.throws(() => validateToolDefinitions([null]), /Only function tools/);
    assert.throws(() => validateToolDefinitions([{ type: 'custom', function: { name: 'read_file' } }]), /Only function tools/);
    assert.throws(() => validateToolDefinitions([definition(null)]), /Tool names/);
    assert.throws(() => validateToolDefinitions([definition({ name: 42 })]), /Tool names/);
    assert.throws(() => validateToolDefinitions([definition({ name: 'bad name' })]), /Tool names/);
    assert.throws(() => validateToolDefinitions([definition({ name: 'read_file' }), definition({ name: 'read_file' })]), /Tool names/);
    assert.throws(() => validateToolDefinitions([definition({ name: 'read_file', description: 42 })]), /Invalid description/);
    assert.throws(() => validateToolDefinitions([definition({ name: 'read_file', parameters: null })]), /Invalid parameters/);
    assert.throws(() => validateToolDefinitions([definition({ name: 'read_file', parameters: 'object' })]), /Invalid parameters/);
    assert.throws(() => validateToolDefinitions([definition({ name: 'read_file', parameters: [] })]), /Invalid parameters/);
    assert.deepEqual(validateToolDefinitions([definition({ name: 'read_file' })]), [
      { type: 'function', function: { name: 'read_file', description: undefined, parameters: undefined } },
    ]);
  });

  test('selects the matching prompt instruction for none, required, and automatic tool choice', () => {
    assert.match(toolBridgePrompt([], tools, 'none'), /Do not request functions this turn/);
    assert.match(toolBridgePrompt([], tools, 'required'), /Request at least one function this turn/);
    assert.match(toolBridgePrompt([], tools, 'auto'), /Request functions only when needed/);
  });

  test('rejects malformed JSON and non-object top-level answers', () => {
    assert.throws(() => parseToolBridgeAnswer('not json', tools, 'auto'), /valid tool-bridge JSON object/);
    assert.throws(() => parseToolBridgeAnswer('null', tools, 'auto'), /invalid tool-bridge response/);
    assert.throws(() => parseToolBridgeAnswer('42', tools, 'auto'), /invalid tool-bridge response/);
    assert.throws(() => parseToolBridgeAnswer('[]', tools, 'auto'), /invalid tool-bridge response/);
  });

  test('rejects disallowed, excessive, malformed, or unselected function calls', () => {
    const oneCall = JSON.stringify({ tool_calls: [{ name: 'read_file', arguments: {} }] });
    assert.throws(() => parseToolBridgeAnswer(oneCall, tools, 'none'), /disallowed tool calls/);
    const manyCalls = JSON.stringify({ tool_calls: Array(17).fill({ name: 'read_file', arguments: {} }) });
    assert.throws(() => parseToolBridgeAnswer(manyCalls, tools, 'auto'), /disallowed tool calls/);
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[null]}', tools, 'auto'), /unknown function/);
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":42,"arguments":{}}]}', tools, 'auto'), /unknown function/);
    const twoTools = validateToolDefinitions([
      { type: 'function', function: { name: 'read_file' } },
      { type: 'function', function: { name: 'write_file' } },
    ]);
    assert.throws(() => parseToolBridgeAnswer(
      '{"tool_calls":[{"name":"write_file","arguments":{}}]}',
      twoTools,
      { type: 'function', function: { name: 'read_file' } },
    ), /unknown function/);
    assert.deepEqual(parseToolBridgeAnswer(oneCall, tools, { type: 'other' }).toolCalls.length, 1);
  });

  test('parses string arguments and rejects invalid, null, array, or primitive arguments', () => {
    const parsed = parseToolBridgeAnswer(
      '{"tool_calls":[{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}]}',
      tools,
      'auto',
    );
    assert.equal(parsed.toolCalls[0].function.arguments, '{"path":"a.txt"}');
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"read_file","arguments":"bad"}]}', tools, 'auto'), /invalid function arguments/);
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"read_file","arguments":null}]}', tools, 'auto'), /arguments must be a JSON object/);
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"read_file","arguments":[]}]}', tools, 'auto'), /arguments must be a JSON object/);
    assert.throws(() => parseToolBridgeAnswer('{"tool_calls":[{"name":"read_file","arguments":1}]}', tools, 'auto'), /arguments must be a JSON object/);
  });

  test('requires a function when selected and requires string content for final answers', () => {
    assert.throws(() => parseToolBridgeAnswer('{"content":"done"}', tools, 'required'), /did not request the required function/);
    assert.throws(() => parseToolBridgeAnswer('{"content":"done"}', tools, { type: 'function', function: { name: 'read_file' } }), /did not request the required function/);
    assert.throws(() => parseToolBridgeAnswer('{"content":42}', tools, 'auto'), /neither a final answer nor function calls/);
    assert.deepEqual(parseToolBridgeAnswer('{"tool_calls":[],"content":"done"}', tools, 'auto'), { content: 'done' });
  });
});
