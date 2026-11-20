import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SseWriter } from "../dist/sse-writer.js";

function fakeReply() {
  const raw = new EventEmitter();
  raw.destroyed = false;
  raw.writableEnded = false;
  raw.writes = [];
  raw.endCalls = 0;
  raw.write = (chunk) => {
    raw.writes.push(chunk);
    return true;
  };
  raw.end = () => {
    raw.endCalls += 1;
    raw.writableEnded = true;
  };
  raw.destroy = () => {
    raw.destroyed = true;
    raw.emit("close");
  };
  return { raw };
}

const abortError = (error) => error?.name === "AbortError";

test("SseWriter frames data, named events and comments, then ends after flush", async () => {
  const reply = fakeReply();
  const writer = new SseWriter(reply);

  await writer.write({ hello: "world" });
  await writer.write({ type: "response.created" }, "response.created");
  await writer.comment("mirror-conversation-id c1");
  await writer.write("[DONE]");
  await writer.flush();
  await writer.end();

  assert.deepEqual(reply.raw.writes, [
    'data: {"hello":"world"}\n\n',
    'event: response.created\ndata: {"type":"response.created"}\n\n',
    ": mirror-conversation-id c1\n\n",
    "data: [DONE]\n\n",
  ]);
  assert.equal(reply.raw.endCalls, 1);
  assert.equal(reply.raw.writableEnded, true);
  reply.raw.emit("close");
});

test("SseWriter waits for drain before writing queued frames", async () => {
  const reply = fakeReply();
  let first = true;
  reply.raw.write = (chunk) => {
    reply.raw.writes.push(chunk);
    if (first) {
      first = false;
      return false;
    }
    return true;
  };
  const writer = new SseWriter(reply);
  const firstWrite = writer.write("first");
  const secondWrite = writer.write("second");

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(reply.raw.writes, ["data: first\n\n"]);
  reply.raw.emit("drain");
  await Promise.all([firstWrite, secondWrite]);
  assert.deepEqual(reply.raw.writes, ["data: first\n\n", "data: second\n\n"]);
});

test("SseWriter aborts a blocked write when the client closes", async () => {
  const reply = fakeReply();
  reply.raw.write = (chunk) => {
    reply.raw.writes.push(chunk);
    return false;
  };
  const writer = new SseWriter(reply);
  const pending = writer.write("pending");

  await new Promise((resolve) => setImmediate(resolve));
  reply.raw.destroyed = true;
  reply.raw.emit("close");
  await assert.rejects(pending, abortError);
  await assert.rejects(writer.write("after-close"), abortError);
});

test("SseWriter lets a request abort cancel a blocked frame but keeps the socket for a terminal error", async () => {
  const reply = fakeReply();
  reply.raw.write = (chunk) => {
    reply.raw.writes.push(chunk);
    return false;
  };
  const controller = new AbortController();
  const writer = new SseWriter(reply);
  const pending = writer.write("generation", undefined, controller.signal);

  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, abortError);
  assert.equal(reply.raw.destroyed, false);

  await assert.rejects(writer.write("still-aborted", undefined, controller.signal), abortError);
  reply.raw.write = (chunk) => {
    reply.raw.writes.push(chunk);
    return true;
  };
  await writer.write({ error: "generation_aborted" });
  await writer.end();
  assert.deepEqual(reply.raw.writes, ['data: generation\\n\\n', 'data: {"error":"generation_aborted"}\\n\\n']);
  assert.equal(reply.raw.endCalls, 1);
});

test("SseWriter destroys a client that never drains before the stall timeout", async () => {
  const reply = fakeReply();
  reply.raw.write = (chunk) => {
    reply.raw.writes.push(chunk);
    return false;
  };
  const writer = new SseWriter(reply, { stallTimeoutMs: 10 });

  await assert.rejects(writer.write("stalled"), /响应客户端读取过慢/);
  assert.equal(reply.raw.destroyed, true);
});

test("SseWriter can send a terminal error frame after a transient write error", async () => {
  const reply = fakeReply();
  let failFirst = true;
  reply.raw.write = (chunk) => {
    if (failFirst) {
      failFirst = false;
      throw new Error("fixture write failure");
    }
    reply.raw.writes.push(chunk);
    return true;
  };
  const writer = new SseWriter(reply);

  await assert.rejects(writer.write("first"), /fixture write failure/);
  await writer.write({ error: "upstream_failure" });
  await writer.end();
  assert.deepEqual(reply.raw.writes, ['data: {"error":"upstream_failure"}\n\n']);
  assert.equal(reply.raw.endCalls, 1);
});

test("SseWriter rejects writes when the response is already destroyed or ended", async () => {
  const destroyed = fakeReply();
  destroyed.raw.destroyed = true;
  await assert.rejects(new SseWriter(destroyed).write("closed"), abortError);
  await new SseWriter(destroyed).end();
  assert.equal(destroyed.raw.endCalls, 0);

  const ended = fakeReply();
  ended.raw.writableEnded = true;
  await assert.rejects(new SseWriter(ended).write("ended"), abortError);
  await new SseWriter(ended).end();
  assert.equal(ended.raw.endCalls, 0);
});

test("SseWriter observes close after drain and rejects an ended response after drain", async () => {
  const closed = fakeReply();
  closed.raw.write = () => false;
  const closedWriter = new SseWriter(closed);
  const closePending = closedWriter.write("close-after-drain");
  await new Promise((resolve) => setImmediate(resolve));
  closed.raw.emit("drain");
  closed.raw.destroyed = true;
  closed.raw.emit("close");
  await assert.rejects(closePending, abortError);

  const ended = fakeReply();
  ended.raw.write = () => false;
  const endedWriter = new SseWriter(ended);
  const endPending = endedWriter.write("end-after-drain");
  await new Promise((resolve) => setImmediate(resolve));
  ended.raw.emit("drain");
  ended.raw.writableEnded = true;
  await assert.rejects(endPending, abortError);
});

test("SseWriter propagates socket errors while waiting for drain", async () => {
  const reply = fakeReply();
  reply.raw.write = () => false;
  const writer = new SseWriter(reply);
  const pending = writer.write("socket-error");

  await new Promise((resolve) => setImmediate(resolve));
  reply.raw.emit("error", new Error("socket failure"));
  await assert.rejects(pending, /socket failure/);
});
