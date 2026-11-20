import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import Fastify from "fastify";
import { assistantAddFrame, stubBackend } from "./helpers/backend.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "mirror-stream-lifecycle-"));
process.env.MIRROR_DATA_DIR = dir;
const store = await import("../dist/store.js");
const { registerOpenAiRoutes, remainingStreamText } = await import("../dist/openai.js");
const nativeFetch = globalThis.fetch;
test.describe("server / openai-stream-lifecycle", () => {
test.after(() => rmSync(dir, { recursive: true, force: true }));

for (const responses of [false, true]) test(`a seventh full-history ${responses ? "Responses" : "Chat"} turn sends parseable keepalives while upstream is silent, then continues the same parent`, { timeout: 5000 }, async t => {
  store.saveVerifiedSession("fixture-session", "heartbeat-account");
  store.updateMintedToken("fixture-access", Date.now() + 3600000, null);
  const sent = [];
  const backend = stubBackend("heartbeat-account", { sent });
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  let pause = false;
  globalThis.fetch = async (url, init) => {
    if (pause && String(url).endsWith("/me")) {
      entered.resolve();
      await gate.promise;
    }
    return backend(url, init);
  };
  const app = Fastify();
  await registerOpenAiRoutes(app);
  let reader;
  try {
    const history = [];
    let id;
    for (let turn = 1; turn <= 6; turn++) {
      history.push({ role: "user", content: `turn ${turn}` });
      const response = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { messages: history } });
      assert.equal(response.statusCode, 200, response.body);
      id ??= response.headers["x-mirror-conversation-id"];
      assert.equal(response.headers["x-mirror-conversation-id"], id);
      history.push(response.json().choices[0].message);
    }
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    pause = true;
    t.mock.timers.enable({ apis: ["setInterval"] });
    const response = await nativeFetch(`${address}/v1/${responses ? "responses" : "chat/completions"}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ [responses ? "input" : "messages"]: [...history, { role: "user", content: "seventh turn with apostrophes, (parentheses), and tool call intent" }], stream: true }),
    });
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let output = decoder.decode((await reader.read()).value);
    await entered.promise;
    // Model the extension's data-event -> runtime.Port.postMessage path.
    // SSE comments do not reach that callback and cannot keep its worker alive.
    for (let interval = 0; interval < 4; interval++) {
      t.mock.timers.tick(10000);
      const heartbeat = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("No SSE data heartbeat during upstream preparation")), 100)),
      ]);
      const text = decoder.decode(heartbeat.value);
      const event = JSON.parse(text.split("\n").find(line => line.startsWith("data: ")).slice(6));
      if (responses) {
        assert.equal(event.type, "response.output_text.delta");
        assert.equal(event.delta, "");
      } else {
        assert.equal(event.object, "chat.completion.chunk");
        assert.deepEqual(event.choices, [{ index: 0, delta: { content: "" }, finish_reason: null }]);
      }
      output += text;
    }
    gate.resolve();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value);
    }
    assert.match(output, /reply-7/);
    assert.match(output, responses ? /response.completed/ : /\[DONE\]/);
    assert.match(output, responses ? new RegExp(`"conversation_id":"${id}"`) : new RegExp(`mirror-conversation-id ${id}`));
    const lastTurn = sent.filter(item => item.pathname.endsWith("/f/conversation")).at(-1).body;
    assert.equal(lastTurn.parent_message_id, "assistant-6");
    assert.equal(lastTurn.conversation_id, "upstream-1");
    assert.equal(store.listMessages(id).length, 14);
    assert.equal(store.listMessages(id).at(-1).content, "reply-7");
    // A finished request must not leave a timer writing into the closed socket.
    t.mock.timers.tick(30000);
  } finally {
    gate.resolve();
    await reader?.cancel();
    t.mock.timers.reset();
    globalThis.fetch = nativeFetch;
    await app.close();
  }
});

for (const failure of ["idle deadline", "heartbeat write"]) {
  test(`silent streams terminate on ${failure} and release the conversation for retry`, { timeout: 5000 }, async t => {
    const account = `heartbeat-${failure}`;
    store.saveVerifiedSession("fixture-session", account);
    store.updateMintedToken("fixture-access", Date.now() + 3600000, null);
    process.env.MIRROR_IDLE_TIMEOUT_MS = "100";
    const entered = Promise.withResolvers();
    let upstreamSignal;
    globalThis.fetch = async (_url, init) => {
      upstreamSignal = init.signal;
      entered.resolve();
      return new Promise(() => {});
    };
    let failWrite = false;
    const app = Fastify();
    app.addHook("onRequest", async (_req, reply) => {
      const write = reply.raw.write;
      reply.raw.write = function (...args) {
        if (failWrite) {
          failWrite = false;
          throw new Error("fixture write failure");
        }
        return write.apply(this, args);
      };
    });
    await registerOpenAiRoutes(app);
    let reader;
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      t.mock.timers.enable({ apis: ["setInterval"] });
      const response = await nativeFetch(`${address}/v1/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "silent turn" }], metadata: { conversation_id: failure }, stream: true }),
      });
      reader = response.body.getReader();
      await reader.read();
      await entered.promise;
      failWrite = failure === "heartbeat write";
      t.mock.timers.tick(10000);
      let output = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      assert.match(output, failure === "idle deadline" ? /deadline_exceeded/ : /upstream_failure/);
      assert.doesNotMatch(output, /\[DONE\]|fixture write failure/);
      assert.equal(upstreamSignal.aborted, true);
      assert.equal(store.listMessages(failure).at(-1).status, "error");
      t.mock.timers.tick(30000);
      globalThis.fetch = stubBackend(account);
      const retry = await app.inject({ method: "POST", url: "/v1/chat/completions", payload: { messages: [{ role: "user", content: "retry" }], metadata: { conversation_id: failure } } });
      assert.equal(retry.statusCode, 200, retry.body);
    } finally {
      await reader?.cancel();
      t.mock.timers.reset();
      delete process.env.MIRROR_IDLE_TIMEOUT_MS;
      globalThis.fetch = nativeFetch;
      await app.close();
    }
  });
}


test("a paused TCP reader stops SSE production until drain and preserves the continuation transcript", { timeout: 25_000 }, async () => {
  const account = "slow-tcp-reader-account";
  store.saveVerifiedSession("fixture-session", account);
  store.updateMintedToken("fixture-access", Date.now() + 3600000, null);

  const largeAnswer = "stream-start-" + "x".repeat(24 * 1024 * 1024) + "-stream-end\n";
  const sent = [];
  let upstreamPulls = 0;
  const fallbackBackend = stubBackend(account, { sent });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/f/conversation")) {
      const requestBody = JSON.parse(String(init?.body ?? "{}"));
      sent.push({ method: init?.method, pathname: url.pathname, body: requestBody });
      const firstFrame = assistantAddFrame(requestBody?.conversation_id ?? "upstream-1", "assistant-1", largeAnswer);
      let frameIndex = 0;
      const upstreamBody = new ReadableStream({
        pull(controller) {
          upstreamPulls += 1;
          if (frameIndex === 0) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(firstFrame)}\\n\\n`));
          } else if (frameIndex === 1) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\\n\\n"));
            controller.close();
          }
          frameIndex += 1;
        },
      }, { highWaterMark: 0 });
      return new Response(upstreamBody, { headers: { "content-type": "text/event-stream" } });
    }
    return fallbackBackend(input, init);
  };

  let blocked = false;
  let writesWhileBlocked = 0;
  let drainCount = 0;
  let resolveBackpressure;
  const backpressure = new Promise(resolve => { resolveBackpressure = resolve; });
  const app = Fastify();
  app.addHook("onRequest", async (_req, reply) => {
    const raw = reply.raw;
    const write = raw.write;
    raw.write = function (...args) {
      if (blocked) writesWhileBlocked += 1;
      const accepted = write.apply(this, args);
      if (!accepted && !blocked) {
        blocked = true;
        resolveBackpressure();
      }
      return accepted;
    };
    raw.on("drain", () => {
      if (blocked) {
        blocked = false;
        drainCount += 1;
      }
    });
  });
  await registerOpenAiRoutes(app);

  let response;
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    response = await new Promise((resolve, reject) => {
      const request = httpRequest(address + "/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", connection: "close" },
      }, incoming => {
        incoming.pause();
        resolve(incoming);
      });
      request.once("error", reject);
      request.end(JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "large streamed answer" }],
        stream: true,
      }));
    });

    let timeout;
    await Promise.race([
      backpressure,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("The real TCP socket never applied backpressure")), 5000);
      }),
    ]).finally(() => clearTimeout(timeout));
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.equal(blocked, true, "the paused peer must keep the server write buffer blocked");
    assert.equal(writesWhileBlocked, 0, "no later SSE frame may overtake a blocked write");
    assert.equal(drainCount, 0, "the socket must not drain while the client is paused");
    assert.equal(upstreamPulls, 1, "the upstream reader must pause while the downstream socket is blocked");

    let output = "";
    const body = new Promise((resolve, reject) => {
      response.setEncoding("utf8");
      response.on("data", chunk => { output += chunk; });
      response.once("end", () => resolve(output));
      response.once("error", reject);
      response.once("aborted", () => reject(new Error("TCP response aborted before completion")));
    });
    response.resume();
    const streamed = await body;

    assert.ok(drainCount >= 1, "resuming the reader must release the blocked writer");
    assert.equal(upstreamPulls, 2, "the upstream reader may advance only after downstream drain");
    assert.equal(writesWhileBlocked, 0);
    assert.ok(streamed.includes("-stream-end\\n"));
    assert.ok(streamed.includes("[DONE]"));
    const conversationId = streamed.match(/: mirror-conversation-id ([^\r\n]+)/)?.[1];
    assert.ok(conversationId, "stream must expose its local continuation id");
    assert.equal(store.listMessages(conversationId).at(-1).content, largeAnswer);

    globalThis.fetch = stubBackend(account, {
      sent,
      turnFrames: body => [assistantAddFrame(body?.conversation_id ?? "upstream-1", "assistant-2", "resumed after drain"), "[DONE]"],
    });
    const retry = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      payload: {
        model: "auto",
        messages: [{ role: "user", content: "continue after drain" }],
        metadata: { conversation_id: conversationId },
      },
    });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json().choices[0].message.content, "resumed after drain");
    assert.equal(store.listMessages(conversationId).at(-1).content, "resumed after drain");
    assert.equal(sent.filter(item => item.pathname.endsWith("/f/conversation")).length, 2);
  } finally {
    response?.destroy();
    globalThis.fetch = nativeFetch;
    await app.close();
  }
});

test("stream output may append to delivered text but cannot replace or truncate it", () => {
  assert.equal(remainingStreamText("hé🙂 complete", "hé🙂"), " complete");
  assert.equal(remainingStreamText("same", "same"), "");
  assert.equal(remainingStreamText("first answer", ""), "first answer");
  for (const replacement of ["different answer", "already", ""]) {
    assert.throws(() => remainingStreamText(replacement, "already delivered"), /上游修改了已发送给客户端的文本/);
  }
});
});
