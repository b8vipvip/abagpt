import "./dom-setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act } from "react";
import { render, screen, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import App, { localizedRole, localizedStatus } from "../src/App.js";

test.describe("web / App", () => {
  test("preserves unknown status and role values for diagnostics", () => {
    assert.equal(localizedStatus("Upstream pending"), "Upstream pending");
    assert.equal(localizedRole("tool"), "tool");
  });

test.afterEach(() => {
  cleanup();
  localStorage.clear();
});

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

// A tiny fetch router: every test supplies only the routes it cares about;
// anything else (in particular the two mount-time effects - /v1/models and
// /api/conversations - that fire on every single render) gets an
// inoffensive empty 200 so unrelated tests never have to think about them.
function router(handlers: Array<[RegExp, Handler]>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    // A base is required for bare relative fetches (e.g.
    // ConnectionTools/ConversationTools deliberately call fetch("/api/...")
    // directly, unprefixed by the configurable "服务器地址" field,
    // since those always target this local Mirror instance) - harmless
    // for the already-absolute URLs every other call site here builds.
    const url = new URL(href, location.origin);
    for (const [pattern, handler] of handlers) {
      if (pattern.test(url.pathname)) return handler(url, init);
    }
    if (url.pathname === "/v1/models") return jsonResponse({ data: [] });
    if (url.pathname === "/api/conversations") return jsonResponse({ items: [], hasMore: false });
    return jsonResponse({});
  }) as typeof fetch;
}

async function renderApp(handlers: Array<[RegExp, Handler]> = []) {
  globalThis.fetch = router(handlers);
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(React.createElement(App));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return utils;
}

function lastUserTextarea() {
  const textareas = screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA");
  return textareas.at(-1) as HTMLTextAreaElement;
}

function runButton() {
  return screen.getByRole("button", { name: /^运行请求/ });
}

// ---------------------------------------------------------------------------
// Rendering & defaults
// ---------------------------------------------------------------------------

test("renders the platform header, sidebar, and default two-message transcript", async () => {
  await renderApp();
  assert.ok(screen.getByRole("heading", { name: "对话" }));
  const header = screen.getByRole("banner");
  assert.ok(within(header).getByRole("link", { name: "ChatGPT 聊天" }));
  assert.ok(within(header).getByRole("link", { name: /API 测试台/ }));
  assert.ok(within(header).getByRole("link", { name: /模型/ }));
  assert.ok(within(header).getByRole("link", { name: /API 文档/ }));
  assert.ok(within(header).getByRole("link", { name: /OpenAPI 规范/ }));
  assert.equal(screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA").length, 2);
  assert.equal(screen.getByText("就绪").className, "run-status ready");
});

test("Convert actions insert prompts and attachments into the correct chat turn", async () => {
  await renderApp([
    [/^\/api\/convert\/pngspeak\/encode$/, () => jsonResponse({ bytes: 3, dataBase64: "AQID" })],
    [/^\/api\/convert\/gpt-prompt$/, () => jsonResponse({ prompt: "decode this artifact" })],
    [/^\/v1\/chat\/completions$/, () => jsonResponse({ choices: [{ message: { content: "![result](https://cdn.test/result.png)" } }] })],
  ]);

  // Make the last turn an assistant reply first. The conversion callbacks
  // must append a fresh user draft instead of rewriting the assistant row.
  fireEvent.click(screen.getByRole("button", { name: "输出" }));
  fireEvent.click(screen.getByLabelText("流式输出"));
  fireEvent.click(runButton());
  await screen.findAllByText(/result\.png/);
  assert.ok(screen.getAllByRole("img", { name: "result" }).length >= 1);

  fireEvent.click(screen.getByRole("button", { name: "转换工具" }));
  fireEvent.click(screen.getByRole("button", { name: "编码" }));
  await screen.findByAltText(/已编码的 PngSpeak/);
  fireEvent.click(screen.getByRole("button", { name: /将解码提示词插入对话/ }));
  await screen.findByText("已将提示词插入下方当前对话消息。");
  assert.ok(screen.getByDisplayValue("decode this artifact"));

  // A later insertion appends to that user draft, and attachment insertion
  // augments it. Running again makes the latest row an assistant turn so the
  // attachment callback also exercises its fresh-user-message path.
  fireEvent.click(screen.getByRole("button", { name: /添加到对话附件/ }));
  await screen.findByText("已添加到下方当前对话消息的附件中。");
  fireEvent.click(screen.getByRole("button", { name: /将解码提示词插入对话/ }));
  await screen.findByText(/已将提示词插入下方当前对话消息。/);
  fireEvent.click(screen.getByRole("button", { name: "输出" }));
  fireEvent.click(runButton());
  await screen.findAllByText(/result\.png/);
  fireEvent.click(screen.getByRole("button", { name: "转换工具" }));
  fireEvent.click(screen.getByRole("button", { name: "编码" }));
  await screen.findByAltText(/已编码的 PngSpeak/);
  fireEvent.click(screen.getByRole("button", { name: /添加到对话附件/ }));
  await screen.findByText("已添加到下方当前对话消息的附件中。");
});

test("conversion callbacks cannot mutate the transcript once a run is starting", async () => {
  const gate = deferred<Response>();
  await renderApp([
    [/^\/api\/convert\/pngspeak\/encode$/, () => jsonResponse({ bytes: 3, dataBase64: "AQID" })],
    [/^\/api\/convert\/gpt-prompt$/, () => jsonResponse({ prompt: "should not land during run" })],
    [/^\/v1\/chat\/completions$/, () => gate.promise],
  ]);
  fireEvent.click(screen.getByRole("button", { name: "转换工具" }));
  fireEvent.click(screen.getByRole("button", { name: "编码" }));
  await screen.findByAltText(/已编码的 PngSpeak/);
  const originalDraft = lastUserTextarea().value;

  // React has not committed the disabled state yet inside this synchronous
  // event batch, but run() has already raised its ref guard before awaiting
  // the network. This reproduces a fast user double-action on the same turn.
  act(() => {
    fireEvent.click(runButton());
    fireEvent.click(screen.getByRole("button", { name: /将解码提示词插入对话/ }));
    fireEvent.click(screen.getByRole("button", { name: /添加到对话附件/ }));
  });
  assert.equal(lastUserTextarea().value, originalDraft);
  assert.equal(screen.queryByText("should not land during run"), null);
  assert.equal(screen.queryByText(/mirror-convert\.pngspk\.png/), null);
  await act(async () => { gate.resolve(jsonResponse({ choices: [{ message: { content: "finished" } }] })); });
});

test("conversion tools create a fresh user row when the transcript has no user draft", async () => {
  await renderApp([
    [/^\/api\/convert\/pngspeak\/encode$/, () => jsonResponse({ bytes: 3, dataBase64: "AQID" })],
    [/^\/api\/convert\/gpt-prompt$/, () => jsonResponse({ prompt: "fresh prompt row" })],
  ]);
  fireEvent.click(screen.getByRole("button", { name: /添加消息/ }));
  fireEvent.change(screen.getByLabelText("第 3 条消息的角色"), { target: { value: "assistant" } });
  fireEvent.click(screen.getByRole("button", { name: "转换工具" }));
  fireEvent.click(screen.getByRole("button", { name: "编码" }));
  await screen.findByAltText(/已编码的 PngSpeak/);
  fireEvent.click(screen.getByRole("button", { name: /将解码提示词插入对话/ }));
  await screen.findByDisplayValue("fresh prompt row");
  fireEvent.click(screen.getByRole("button", { name: /添加到对话附件/ }));
  await screen.findByText(/mirror-convert\.pngspk\.png/);
});

test("conversion attachment creates a fresh draft after an assistant-only final turn", async () => {
  await renderApp([[/^\/api\/convert\/pngspeak\/encode$/, () => jsonResponse({ bytes: 3, dataBase64: "AQID" })]]);
  fireEvent.click(screen.getByRole("button", { name: /添加消息/ }));
  fireEvent.change(screen.getByLabelText("第 3 条消息的角色"), { target: { value: "assistant" } });
  fireEvent.click(screen.getByRole("button", { name: "转换工具" }));
  fireEvent.click(screen.getByRole("button", { name: "编码" }));
  await screen.findByAltText(/已编码的 PngSpeak/);
  fireEvent.click(screen.getByRole("button", { name: /添加到对话附件/ }));
  assert.ok(await screen.findByText("mirror-convert.pngspk.png"));
});

test("Run is blocked with an explanatory reason when the last row isn't a fillable user message", async () => {
  await renderApp();
  // Default last row IS a filled user row - clear it first.
  fireEvent.change(lastUserTextarea(), { target: { value: "   " } });
  fireEvent.click(runButton());
  assert.ok(await screen.findByText("已阻止"));
  fireEvent.click(screen.getByRole("button", { name: /原始响应/ }));
  assert.match(screen.getByText(/请先在最后一条用户消息中输入内容/).textContent ?? "", /请先在最后一条用户消息中输入内容/);
});

test("Run is blocked when the last row's role isn't user at all", async () => {
  await renderApp();
  const selects = screen.getAllByRole("combobox").filter((el) => el.closest(".message-editor"));
  fireEvent.change(selects.at(-1) as HTMLSelectElement, { target: { value: "system" } });
  fireEvent.click(runButton());
  assert.ok(await screen.findByText("已阻止"));
  fireEvent.click(screen.getByRole("button", { name: /原始响应/ }));
  assert.match(screen.getByText(/最后一条消息必须来自用户/).textContent ?? "", /最后一条消息必须来自用户/);
});

test("toggling the model field between list and freeform, and revealing the gizmo picker for g- models", async () => {
  await renderApp([
    [/^\/v1\/models$/, () => jsonResponse({ data: [{ id: "gpt-x", owned_by: "openai" }] })],
  ]);
  assert.equal(screen.queryByPlaceholderText(/此 GPT／项目使用的模型/), null);
  fireEvent.click(screen.getByRole("button", { name: "手动输入" }));
  const modelInput = screen.getByPlaceholderText(/官方模型 ID/);
  fireEvent.change(modelInput, { target: { value: "g-12345" } });
  assert.ok(screen.getByLabelText(/此 GPT／项目使用的模型/));
  fireEvent.click(screen.getByRole("button", { name: "使用列表选择" }));
  assert.ok(screen.getByRole("combobox", { name: /模型/ }) || true);
});

// ---------------------------------------------------------------------------
// localStorage snapshot loading (loadSnapshot / loadStoredConversationId /
// loadStoredMessages)
// ---------------------------------------------------------------------------

test("with no remember-history flag set, defaults are used and nothing is hydrated from storage", async () => {
  await renderApp();
  assert.equal(screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA").length, 2);
  const conversationIdInput = screen.getByPlaceholderText(/自动生成/);
  assert.equal((conversationIdInput as HTMLInputElement).value, "");
});

test("a valid remembered snapshot hydrates model, pickedModel, privateChat, conversationId, and messages", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem(
    "mirror-playground-snapshot",
    JSON.stringify({
      model: "g-remembered",
      pickedModel: "gpt-5-6",
      privateChat: true,
      conversationId: "conv-remembered",
      messages: [
        { role: "system", content: "remembered system" },
        { role: "user", content: "remembered user" },
      ],
    }),
  );
  await renderApp();
  const conversationIdInput = screen.getByPlaceholderText(/自动生成/);
  assert.equal((conversationIdInput as HTMLInputElement).value, "conv-remembered");
  assert.ok(screen.getByDisplayValue("remembered system"));
  assert.ok(screen.getByDisplayValue("remembered user"));
  assert.ok((screen.getByLabelText("私密对话") as HTMLInputElement).checked);
  assert.ok(screen.getByLabelText(/此 GPT／项目使用的模型/));
});

test("a malformed remembered snapshot falls back to the defaults instead of throwing", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem("mirror-playground-snapshot", "{not json");
  await renderApp();
  assert.equal(screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA").length, 2);
  const conversationIdInput = screen.getByPlaceholderText(/自动生成/);
  assert.equal((conversationIdInput as HTMLInputElement).value, "");
});

test("a remembered snapshot whose messages fail shape validation falls back to the defaults", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem(
    "mirror-playground-snapshot",
    JSON.stringify({ messages: [{ role: "not-a-real-role", content: "x" }] }),
  );
  await renderApp();
  assert.ok(screen.getByDisplayValue("请用一句简短的话打个招呼。"));
});

test("a remembered snapshot with an empty messages array falls back to the defaults", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem("mirror-playground-snapshot", JSON.stringify({ messages: [] }));
  await renderApp();
  assert.ok(screen.getByDisplayValue("请用一句简短的话打个招呼。"));
});

// ---------------------------------------------------------------------------
// rememberHistory persistence effect
// ---------------------------------------------------------------------------

test("turning Remember history on persists a snapshot; turning it off removes it", async () => {
  await renderApp();
  const checkbox = screen.getByLabelText("在此设备记住提示词历史");
  fireEvent.click(checkbox);
  await waitFor(() => assert.ok(localStorage.getItem("mirror-playground-snapshot")));
  const saved = JSON.parse(localStorage.getItem("mirror-playground-snapshot") as string);
  assert.equal(saved.model, "auto");
  fireEvent.click(checkbox);
  await waitFor(() => assert.equal(localStorage.getItem("mirror-playground-snapshot"), null));
});

test("enabling one-shot while remembering history still clears the persisted snapshot", async () => {
  await renderApp();
  fireEvent.click(screen.getByLabelText("在此设备记住提示词历史"));
  await waitFor(() => assert.ok(localStorage.getItem("mirror-playground-snapshot")));
  fireEvent.click(screen.getByLabelText(/单次请求/));
  await waitFor(() => assert.equal(localStorage.getItem("mirror-playground-snapshot"), null));
});


// ---------------------------------------------------------------------------
// Models discovery effect
// ---------------------------------------------------------------------------

test("populates the model dropdown from /v1/models, labelling gizmos/projects and marking unsupported ones", async () => {
  await renderApp([
    [
      /^\/v1\/models$/,
      () =>
        jsonResponse({
          data: [
            { id: "gpt-plain", owned_by: "openai" },
            { id: "gpt-unsupported", owned_by: "openai", mirror: { supported: false } },
            { id: "g-1", owned_by: "chatgpt-gizmo", name: "Helper" },
            { id: "g-p-1", owned_by: "chatgpt-project" },
          ],
        }),
    ],
  ]);
  const select = screen.getByLabelText("模型") as HTMLSelectElement;
  const optionTexts = Array.from(select.options).map((o) => o.textContent);
  assert.ok(optionTexts.includes("gpt-plain"));
  assert.ok(optionTexts.includes("gpt-unsupported（不支持）"));
  assert.ok(optionTexts.includes("GPT：Helper"));
  assert.ok(optionTexts.includes("项目：g-p-1"));
  const unsupportedOption = within(select).getByText("gpt-unsupported（不支持）") as HTMLOptionElement;
  assert.equal(unsupportedOption.disabled, true);
});

test("a failed model-discovery fetch is swallowed silently, leaving only the auto option", async () => {
  await renderApp([[/^\/v1\/models$/, () => { throw new Error("network down"); }]]);
  const select = screen.getByLabelText("模型") as HTMLSelectElement;
  assert.equal(select.options.length, 1);
  assert.equal(select.options[0].value, "auto");
});

test("a non-ok model-discovery response is swallowed silently", async () => {
  await renderApp([[/^\/v1\/models$/, () => jsonResponse({ error: "nope" }, { status: 500 })]]);
  const select = screen.getByLabelText("模型") as HTMLSelectElement;
  assert.equal(select.options.length, 1);
});

test("a model-discovery response whose data isn't an array is ignored", async () => {
  await renderApp([[/^\/v1\/models$/, () => jsonResponse({ data: "not-an-array" })]]);
  const select = screen.getByLabelText("模型") as HTMLSelectElement;
  assert.equal(select.options.length, 1);
});

test("the bearer credential is sent as an authorization header on model discovery", async () => {
  const seen: Array<string | null> = [];
  await renderApp([
    [
      /^\/v1\/models$/,
      (_url, init) => {
        seen.push((init?.headers as Record<string, string> | undefined)?.authorization ?? null);
        return jsonResponse({ data: [] });
      },
    ],
  ]);
  fireEvent.change(screen.getByLabelText("API 密钥（Bearer）"), { target: { value: "sk-test" } });
  await waitFor(() => assert.ok(seen.includes("Bearer sk-test")));
});

// ---------------------------------------------------------------------------
// Conversations list: mount fetch, refresh, and scroll pagination
// ---------------------------------------------------------------------------

test("shows a loading state, then an empty state when there are no conversations", async () => {
  const gate = deferred<Response>();
  globalThis.fetch = router([[/^\/api\/conversations$/, () => gate.promise]]);
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(React.createElement(App));
  });
  assert.ok(screen.getByText("加载中…"));
  gate.resolve(jsonResponse({ items: [], hasMore: false }));
  await screen.findByText("暂无会话");
});

test("renders fetched conversations and marks the currently loaded one active", async () => {
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) => {
        if (url.searchParams.get("offset") === "0") {
          return jsonResponse({
            items: [
              { id: "c1", title: "First chat", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" },
              { id: "c2", title: "", model: "auto", updatedAt: "2024-01-02T00:00:00.000Z" },
            ],
            hasMore: true,
          });
        }
        return jsonResponse({ items: [], hasMore: false });
      },
    ],
  ]);
  assert.ok(screen.getByText("First chat"));
  assert.ok(screen.getByText("未命名会话"));
});

test("scrolling near the bottom of the conversation list loads the next page", async () => {
  let secondPageRequested = false;
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) => {
        if (url.searchParams.get("offset") === "0") {
          return jsonResponse({
            items: [{ id: "c1", title: "Page one", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }],
            hasMore: true,
          });
        }
        secondPageRequested = true;
        return jsonResponse({
          items: [{ id: "c2", title: "Page two", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }],
          hasMore: false,
        });
      },
    ],
  ]);
  const list = document.querySelector(".conversation-list") as HTMLElement;
  Object.defineProperty(list, "scrollHeight", { value: 500, configurable: true });
  Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
  list.scrollTop = 450;
  await act(async () => {
    fireEvent.scroll(list);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(secondPageRequested);
  await screen.findByText("Page two");
});

test("the Refresh button re-syncs the conversation list from the top with resync=true", async () => {
  let sawResync = false;
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) => {
        if (url.searchParams.get("resync") === "true") sawResync = true;
        return jsonResponse({ items: [], hasMore: false });
      },
    ],
  ]);
  fireEvent.click(screen.getByText("刷新"));
  await waitFor(() => assert.ok(sawResync));
});

test("a failed conversations fetch is swallowed and the list just stays empty", async () => {
  await renderApp([[/^\/api\/conversations$/, () => { throw new Error("boom"); }]]);
  assert.ok(screen.getByText("暂无会话"));
});

// ---------------------------------------------------------------------------
// run(): success paths (non-streaming and streaming), metadata, headers
// ---------------------------------------------------------------------------

test("a non-streaming run posts the right body/headers, shows the raw JSON, appends the reply, and refreshes conversations", async () => {
  let conversationsFetchCount = 0;
  let capturedBody: Record<string, unknown> | null = null;
  let capturedHeaders: Record<string, string> = {};
  await renderApp([
    [
      /^\/api\/conversations$/,
      () => {
        conversationsFetchCount += 1;
        return jsonResponse({ items: [], hasMore: false });
      },
    ],
    [
      /^\/v1\/chat\/completions$/,
      (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        capturedHeaders = init?.headers as Record<string, string>;
        return jsonResponse(
          { choices: [{ message: { content: "Hello there" } }] },
          { headers: { "x-mirror-conversation-id": "conv-xyz" } },
        );
      },
    ],
  ]);
  fireEvent.change(screen.getByLabelText("API 密钥（Bearer）"), { target: { value: "sk-run" } });
  fireEvent.click(screen.getByLabelText("流式输出")); // turn OFF streaming
  fireEvent.click(screen.getByLabelText("私密对话"));
  fireEvent.click(runButton());
  assert.ok(screen.getByText("运行中…"));
  await screen.findByText("已完成");
  assert.equal((capturedBody as unknown as { model: string }).model, "auto");
  assert.deepEqual((capturedBody as unknown as { metadata: unknown }).metadata, { private: "true" });
  assert.equal(capturedHeaders.authorization, "Bearer sk-run");
  assert.equal((screen.getByPlaceholderText(/自动生成/) as HTMLInputElement).value, "conv-xyz");
  fireEvent.click(screen.getByRole("button", { name: /原始响应/ }));
  assert.match(screen.getByText(/"content": "Hello there"/).textContent ?? "", /Hello there/);
  assert.ok(screen.getByDisplayValue("Hello there"));
  await waitFor(() => assert.ok(conversationsFetchCount >= 2));
});

test("a streaming run reads SSE frames, updates the conversation id mid-stream, and appends the final reply", async () => {
  const sse =
    `: mirror-conversation-id stream-conv-1\ndata: ${JSON.stringify({ choices: [{ delta: { content: "Hi" }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: "" }, finish_reason: "stop" }] })}\n\n` +
    `data: [DONE]\n\n`;
  await renderApp([
    [
      /^\/v1\/chat\/completions$/,
      () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(sse));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    ],
  ]);
  fireEvent.click(runButton());
  await screen.findByText("已完成");
  assert.ok(screen.getByDisplayValue("Hi"));
  assert.equal((screen.getByPlaceholderText(/自动生成/) as HTMLInputElement).value, "stream-conv-1");
});

test("one-shot runs don't append the reply to the transcript and don't refresh conversations", async () => {
  let conversationsFetchCount = 0;
  await renderApp([
    [/^\/api\/conversations$/, () => { conversationsFetchCount += 1; return jsonResponse({ items: [], hasMore: false }); }],
    [/^\/v1\/chat\/completions$/, () => jsonResponse({ choices: [{ message: { content: "ephemeral" } }] })],
  ]);
  fireEvent.click(screen.getByLabelText(/单次请求/));
  fireEvent.click(screen.getByLabelText("流式输出"));
  const before = conversationsFetchCount;
  fireEvent.click(runButton());
  await screen.findByText("已完成");
  assert.equal(screen.queryByDisplayValue("ephemeral"), null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(conversationsFetchCount, before);
});

test("a gizmo model with a picked sub-model sends mirror_model metadata, and an active conversation id is threaded through", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  await renderApp([
    [
      /^\/v1\/chat\/completions$/,
      (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
    ],
  ]);
  fireEvent.click(screen.getByRole("button", { name: "手动输入" }));
  fireEvent.change(screen.getByLabelText("模型"), { target: { value: "g-1" } });
  fireEvent.change(screen.getByLabelText(/此 GPT／项目使用的模型/), { target: { value: "gpt-5-6" } });
  fireEvent.change(screen.getByPlaceholderText(/自动生成/), { target: { value: "existing-conv" } });
  fireEvent.click(screen.getByLabelText("流式输出"));
  fireEvent.click(runButton());
  await screen.findByText("已完成");
  assert.deepEqual((capturedBody as unknown as { metadata: unknown }).metadata, {
    mirror_model: "gpt-5-6",
    conversation_id: "existing-conv",
  });
});

// ---------------------------------------------------------------------------
// run(): error and abort paths
// ---------------------------------------------------------------------------

test("a non-ok response from the run endpoint surfaces the status and body as an error", async () => {
  await renderApp([
    [/^\/v1\/chat\/completions$/, () => new Response("upstream exploded", { status: 502 })],
  ]);
  fireEvent.click(runButton());
  await screen.findByText("出错");
  fireEvent.click(screen.getByRole("button", { name: /原始响应/ }));
  assert.match(screen.getByText(/502/).textContent ?? "", /502.*upstream exploded/s);
});

test("a rejected fetch during run() surfaces the error message", async () => {
  await renderApp([
    [/^\/v1\/chat\/completions$/, () => { throw new Error("DNS failure"); }],
  ]);
  fireEvent.click(runButton());
  await screen.findByText("出错");
  fireEvent.click(screen.getByRole("button", { name: /原始响应/ }));
  assert.match(screen.getByText(/DNS failure/).textContent ?? "", /DNS failure/);
});

test("a streaming run with no response body reports the missing-stream error", async () => {
  await renderApp([
    [/^\/v1\/chat\/completions$/, () => new Response(null, { status: 200 })],
  ]);
  fireEvent.click(runButton());
  await screen.findByText("出错");
  fireEvent.click(screen.getByRole("button", { name: /原始响应/ }));
  assert.match(screen.getByText(/响应不包含流式数据/).textContent ?? "", /响应不包含流式数据/);
});

test("clicking Stop aborts the in-flight run and reports Stopped, not Error", async () => {
  const gate = deferred<Response>();
  await renderApp([
    [
      /^\/v1\/chat\/completions$/,
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted.");
            error.name = "AbortError";
            reject(error);
          });
        }),
    ],
  ]);
  fireEvent.click(runButton());
  await screen.findByText("运行中…");
  fireEvent.click(screen.getByRole("button", { name: "停止" }));
  await screen.findByText("已停止");
  void gate;
});


// ---------------------------------------------------------------------------
// loadConversation()
// ---------------------------------------------------------------------------

test("loading a conversation with a gizmo hydrates instructions, messages, model, and private flag", async () => {
  await renderApp([
    [/^\/v1\/models$/, () => jsonResponse({ data: [{ id: "g-1", owned_by: "chatgpt-gizmo", name: "Helper" }] })],
    [
      /^\/api\/conversations$/,
      (url) =>
        jsonResponse({
          items: url.searchParams.get("offset") === "0"
            ? [{ id: "c1", title: "Gizmo chat", model: "g-1", updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [],
          hasMore: false,
        }),
    ],
    [
      /^\/api\/conversations\/c1$/,
      () =>
        jsonResponse({
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello!" },
          ],
          instructions: [{ role: "system", content: "custom instructions" }],
          conversation: { id: "c1", model: "g-1", gizmoId: "g-1", private: true },
        }),
    ],
  ]);
  fireEvent.click(await screen.findByText("Gizmo chat"));
  await screen.findByText("已加载");
  assert.ok(screen.getByDisplayValue("custom instructions"));
  assert.ok(screen.getByDisplayValue("hi"));
  assert.ok(screen.getByDisplayValue("hello!"));
  assert.equal((screen.getByPlaceholderText(/自动生成/) as HTMLInputElement).value, "c1");
  assert.ok((screen.getByLabelText("私密对话") as HTMLInputElement).checked);
  assert.equal((screen.getByLabelText("模型") as HTMLSelectElement).value, "g-1");
});

test("loading a non-gizmo, non-auto conversation adopts its model and clears the picked-model field", async () => {
  await renderApp([
    [/^\/v1\/models$/, () => jsonResponse({ data: [{ id: "gpt-x", owned_by: "openai" }] })],
    [
      /^\/api\/conversations$/,
      (url) =>
        jsonResponse({
          items: url.searchParams.get("offset") === "0"
            ? [{ id: "c2", title: "Plain chat", model: "gpt-x", updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [],
          hasMore: false,
        }),
    ],
    [
      /^\/api\/conversations\/c2$/,
      () =>
        jsonResponse({
          messages: [{ role: "user", content: "hey" }],
          conversation: { id: "c2", model: "gpt-x" },
        }),
    ],
  ]);
  fireEvent.click(await screen.findByText("Plain chat"));
  await screen.findByText("已加载");
  assert.equal((screen.getByLabelText("模型") as HTMLSelectElement).value, "gpt-x");
});

test("loading a conversation whose model is 'auto' leaves the currently selected model untouched", async () => {
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) =>
        jsonResponse({
          items: url.searchParams.get("offset") === "0"
            ? [{ id: "c3", title: "Auto chat", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [],
          hasMore: false,
        }),
    ],
    [
      /^\/api\/conversations\/c3$/,
      () => jsonResponse({ messages: [], conversation: { id: "c3", model: "auto" } }),
    ],
  ]);
  fireEvent.click(await screen.findByText("Auto chat"));
  await screen.findByText("已加载");
  assert.equal((screen.getByLabelText("模型") as HTMLSelectElement).value, "auto");
});

test("a failed conversation load reports the status/body as an error", async () => {
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) =>
        jsonResponse({
          items: url.searchParams.get("offset") === "0"
            ? [{ id: "c4", title: "Broken chat", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [],
          hasMore: false,
        }),
    ],
    [/^\/api\/conversations\/c4$/, () => new Response("nope", { status: 404 })],
  ]);
  fireEvent.click(await screen.findByText("Broken chat"));
  await screen.findByText("出错");
  fireEvent.click(screen.getByRole("button", { name: /原始响应/ }));
  assert.match(screen.getByText(/404/).textContent ?? "", /404.*nope/s);
});

// ---------------------------------------------------------------------------
// Message editing, removal, add, and the New-conversation reset
// ---------------------------------------------------------------------------

test("adding, editing, and removing messages updates the transcript", async () => {
  await renderApp();
  fireEvent.click(screen.getByRole("button", { name: /添加消息/ }));
  assert.equal(screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA").length, 3);
  const removeButtons = screen.getAllByRole("button", { name: "删除消息" });
  fireEvent.click(removeButtons[0]);
  assert.equal(screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA").length, 2);
  fireEvent.change(lastUserTextarea(), { target: { value: "edited content" } });
  assert.ok(screen.getByDisplayValue("edited content"));
});

test("editing and removing are no-ops while a run is in flight, even though the row itself is disabled", async () => {
  const gate = deferred<Response>();
  await renderApp([[/^\/v1\/chat\/completions$/, () => gate.promise]]);
  fireEvent.click(screen.getByLabelText("流式输出")); // turn off streaming - gate resolves plain JSON
  const originalContent = (lastUserTextarea() as HTMLTextAreaElement).value;
  fireEvent.click(runButton());
  await screen.findByText("运行中…");
  // Directly dispatch change/click - bypassing the "disabled" DOM attribute
  // the way a stray queued event or a race could - to prove the *runningRef*
  // guard inside updateMessage/removeMessage (not just the disabled attribute)
  // is what's actually doing the blocking.
  fireEvent.change(lastUserTextarea(), { target: { value: "should not stick" } });
  fireEvent.click(screen.getAllByRole("button", { name: "删除消息" })[0]);
  gate.resolve(jsonResponse({ choices: [{ message: { content: "done" } }] }));
  await screen.findByText("已完成");
  const textareas = screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA") as HTMLTextAreaElement[];
  // [system, original user (untouched), assistant("done"), new empty user draft]
  assert.equal(textareas.length, 4);
  assert.equal(textareas[1].value, originalContent);
});

test("an assistant message row is read-only and cannot be removed", async () => {
  await renderApp([[/^\/v1\/chat\/completions$/, () => jsonResponse({ choices: [{ message: { content: "reply" } }] })]]);
  fireEvent.click(screen.getByLabelText("流式输出"));
  fireEvent.click(runButton());
  await screen.findByText("已完成");
  const assistantTextarea = screen.getByDisplayValue("reply") as HTMLTextAreaElement;
  assert.equal(assistantTextarea.readOnly, true);
  const assistantRow = assistantTextarea.closest(".message-editor") as HTMLElement;
  const roleSelect = within(assistantRow).getByRole("combobox") as HTMLSelectElement;
  assert.equal(roleSelect.disabled, true);
  const removeButton = within(assistantRow).getByRole("button", { name: "助手消息不可删除" });
  assert.equal((removeButton as HTMLButtonElement).disabled, true);
});

test("the New button resets the conversation id and the transcript to the defaults", async () => {
  await renderApp();
  fireEvent.change(screen.getByPlaceholderText(/自动生成/), { target: { value: "some-conv" } });
  fireEvent.change(lastUserTextarea(), { target: { value: "custom prompt" } });
  fireEvent.click(screen.getByRole("button", { name: "新建" }));
  assert.equal((screen.getByPlaceholderText(/自动生成/) as HTMLInputElement).value, "");
  assert.ok(screen.getByDisplayValue("You are a helpful assistant."));
  assert.equal(screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA").length, 2);
});

test("New preserves an edited System box instead of resetting it to the fallback", async () => {
  await renderApp();
  const systemTextarea = screen.getAllByRole("textbox").find(
    (el) => el.tagName === "TEXTAREA" && (el as HTMLTextAreaElement).value === "You are a helpful assistant.",
  ) as HTMLTextAreaElement;
  fireEvent.change(systemTextarea, { target: { value: "Always answer in metric." } });
  fireEvent.click(screen.getByRole("button", { name: "新建" }));
  assert.ok(screen.getByDisplayValue("Always answer in metric."));
  assert.equal(screen.queryByDisplayValue("You are a helpful assistant."), null);
});

test("a saved account-wide default system instruction preloads a fresh System box", async () => {
  await renderApp([
    [/^\/api\/settings\/default-system-instructions$/, () => jsonResponse({ content: "Reply concisely, always in Rust code examples." })],
  ]);
  assert.ok(screen.getByDisplayValue("Reply concisely, always in Rust code examples."));
  assert.equal(screen.queryByDisplayValue("You are a helpful assistant."), null);
});

test("a failed default-system-instructions fetch is tolerated, keeping the fallback System text", async () => {
  await renderApp([
    [/^\/api\/settings\/default-system-instructions$/, () => new Response("", { status: 500 })],
  ]);
  assert.ok(screen.getByDisplayValue("You are a helpful assistant."));
});

test("New falls back to the default System text when the first row isn't role=system at the time", async () => {
  await renderApp();
  const selects = screen.getAllByRole("combobox").filter((el) => el.closest(".message-editor"));
  fireEvent.change(selects[0] as HTMLSelectElement, { target: { value: "developer" } });
  fireEvent.click(screen.getByRole("button", { name: "新建" }));
  assert.ok(screen.getByDisplayValue("You are a helpful assistant."));
});

test("a saved account-wide default arriving after the System box was already edited away from the fallback is not applied", async () => {
  const deferredDefault = deferred<Response>();
  await renderApp([
    [/^\/api\/settings\/default-system-instructions$/, () => deferredDefault.promise],
  ]);
  const systemTextarea = screen.getAllByRole("textbox").find(
    (el) => el.tagName === "TEXTAREA" && (el as HTMLTextAreaElement).value === "You are a helpful assistant.",
  ) as HTMLTextAreaElement;
  fireEvent.change(systemTextarea, { target: { value: "Edited before the default arrived." } });
  await act(async () => {
    deferredDefault.resolve(jsonResponse({ content: "Some other saved default" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(screen.getByDisplayValue("Edited before the default arrived."));
  assert.equal(screen.queryByDisplayValue("Some other saved default"), null);
});

test("editing the System box saves it as the new account-wide default after a short pause", async () => {
  const puts: unknown[] = [];
  await renderApp([
    [/^\/api\/settings\/default-system-instructions$/, (url, init) => {
      if (init?.method === "PUT") { puts.push(JSON.parse(String(init.body))); return jsonResponse({ content: "" }); }
      return jsonResponse({ content: "" });
    }],
  ]);
  const systemTextarea = screen.getAllByRole("textbox").find(
    (el) => el.tagName === "TEXTAREA" && (el as HTMLTextAreaElement).value === "You are a helpful assistant.",
  ) as HTMLTextAreaElement;
  fireEvent.change(systemTextarea, { target: { value: "Always answer in metric." } });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 850)); });
  assert.deepEqual(puts.at(-1), { content: "Always answer in metric." });
});

// ---------------------------------------------------------------------------
// Keyboard shortcut
// ---------------------------------------------------------------------------

test("Ctrl/Cmd+Enter triggers a run", async () => {
  await renderApp([[/^\/v1\/chat\/completions$/, () => jsonResponse({ choices: [{ message: { content: "via keyboard" } }] })]]);
  fireEvent.click(screen.getByLabelText("流式输出"));
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  });
  await screen.findByText("已完成");
  assert.ok(screen.getByDisplayValue("via keyboard"));
});

// ---------------------------------------------------------------------------
// Command palette / configurable hotkeys
// ---------------------------------------------------------------------------

test("Cmd/Ctrl+K opens the quick-open command palette by default, and Escape closes it", async () => {
  await renderApp();
  assert.equal(screen.queryByRole("dialog"), null);
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  });
  assert.ok(screen.getByRole("dialog"));
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(screen.queryByRole("dialog"), null);
});

test("a saved hotkeys override changes which combo opens the command palette", async () => {
  await renderApp([
    [/^\/api\/settings\/hotkeys$/, () => jsonResponse({ hotkeys: { commandPalette: "mod+shift+p" } })],
  ]);
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  });
  assert.equal(screen.queryByRole("dialog"), null, "the old default no longer opens it");
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", ctrlKey: true, shiftKey: true, bubbles: true }));
  });
  assert.ok(screen.getByRole("dialog"));
});

test("a non-ok hotkeys fetch is tolerated, leaving the default binding in place", async () => {
  await renderApp([
    [/^\/api\/settings\/hotkeys$/, () => new Response("", { status: 500 })],
  ]);
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  });
  assert.ok(screen.getByRole("dialog"));
});

test("selecting a result in the command palette loads that conversation", async () => {
  await renderApp([
    [/^\/api\/conversations\/search$/, () => jsonResponse({ items: [{ id: "conv-9", title: "Picked from palette" }] })],
    [/^\/api\/conversations\/conv-9$/, () => jsonResponse({ conversation: { id: "conv-9" }, messages: [{ role: "user", content: "hi" }] })],
  ]);
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  });
  fireEvent.change(screen.getByLabelText("搜索并跳转到会话"), { target: { value: "picked" } });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)); });
  fireEvent.click(screen.getByRole("button", { name: "Picked from palette" }));
  await screen.findByText("已加载");
  assert.equal(screen.queryByRole("dialog"), null);
});

test("changing a shortcut in the keyboard-shortcuts panel saves it to the server", async () => {
  const puts: unknown[] = [];
  await renderApp([
    [/^\/api\/settings\/hotkeys$/, (url, init) => {
      if (init?.method === "PUT") { puts.push(JSON.parse(String(init.body))); return jsonResponse({ hotkeys: {} }); }
      return jsonResponse({ hotkeys: {} });
    }],
  ]);
  fireEvent.click(screen.getByText("键盘快捷键"));
  fireEvent.click(screen.getByRole("button", { name: "修改" }));
  fireEvent.keyDown(
    screen.getByLabelText("请为“快速搜索并打开会话”按下快捷键组合"),
    { key: "p", ctrlKey: true, shiftKey: true },
  );
  assert.deepEqual(puts.at(-1), { hotkeys: { commandPalette: "mod+shift+p" } });
});

// ---------------------------------------------------------------------------
// Inline "Run" control under the newest user prompt
// ---------------------------------------------------------------------------

test("a second Run control appears under the newest user message and sends the same request", async () => {
  await renderApp([[/^\/v1\/chat\/completions$/, () => jsonResponse({ choices: [{ message: { content: "via inline run" } }] })]]);
  fireEvent.click(screen.getByLabelText("流式输出")); // turn OFF streaming
  fireEvent.change(lastUserTextarea(), { target: { value: "Hello from the bottom button" } });
  const inline = screen.getByRole("button", { name: "发送此消息（与上方的运行请求按钮相同）" });
  fireEvent.click(inline);
  await screen.findByText("已完成");
  assert.ok(screen.getByDisplayValue("via inline run"));
});

test("the inline Run control is absent when the last row isn't a user message", async () => {
  await renderApp();
  const selects = screen.getAllByRole("combobox").filter((el) => el.closest(".message-editor"));
  fireEvent.change(selects.at(-1) as HTMLSelectElement, { target: { value: "developer" } });
  assert.equal(screen.queryByRole("button", { name: /Send this message/ }), null);
});

test("the inline control switches to Stop while a run is in flight, and aborts the same controller", async () => {
  await renderApp([
    [
      /^\/v1\/chat\/completions$/,
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted.");
            error.name = "AbortError";
            reject(error);
          });
        }),
    ],
  ]);
  fireEvent.change(lastUserTextarea(), { target: { value: "Long one" } });
  const inline = screen.getByRole("button", { name: "发送此消息（与上方的运行请求按钮相同）" });
  fireEvent.click(inline);
  const inlineStop = await screen.findByRole("button", { name: "停止（与上方的停止按钮相同）" });
  fireEvent.click(inlineStop);
  await screen.findByText("已停止");
});

// ---------------------------------------------------------------------------
// Connection bar (domain/path/endpoint memo)
// ---------------------------------------------------------------------------

test("editing the domain and path fields updates the computed request URL, trimming/padding as needed", async () => {
  await renderApp();
  fireEvent.change(screen.getByLabelText("服务器地址"), { target: { value: "https://example.com/" } });
  fireEvent.change(screen.getByLabelText("接口路径"), { target: { value: "v1/chat/completions" } });
  assert.equal(screen.getByText("https://example.com/v1/chat/completions").tagName, "CODE");
});

// ---------------------------------------------------------------------------
// Remaining defensive branches
// ---------------------------------------------------------------------------

test("a throwing localStorage.getItem during initial mount falls back to rememberHistory=false", async () => {
  const original = Storage.prototype.getItem;
  let calls = 0;
  Storage.prototype.getItem = function patched(key: string) {
    calls += 1;
    if (key === "mirror-playground-remember-history") throw new Error("storage blocked");
    return original.call(this, key);
  };
  try {
    await renderApp();
    assert.equal((screen.getByLabelText("在此设备记住提示词历史") as HTMLInputElement).checked, false);
    assert.ok(calls > 0);
  } finally {
    Storage.prototype.getItem = original;
  }
});

test("a failed load-more request is swallowed, leaving the list as-is for a retry", async () => {
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) => {
        if (url.searchParams.get("offset") === "0") {
          return jsonResponse({
            items: [{ id: "c1", title: "Page one", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }],
            hasMore: true,
          });
        }
        throw new Error("page 2 unavailable");
      },
    ],
  ]);
  const list = document.querySelector(".conversation-list") as HTMLElement;
  Object.defineProperty(list, "scrollHeight", { value: 500, configurable: true });
  Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
  list.scrollTop = 450;
  await act(async () => {
    fireEvent.scroll(list);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.ok(screen.getByText("Page one"));
  assert.equal(screen.queryByText("正在加载更多…"), null);
});

test("loading a conversation whose stored messages field isn't an array tolerates it as empty", async () => {
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) =>
        jsonResponse({
          items: url.searchParams.get("offset") === "0"
            ? [{ id: "c9", title: "Weird chat", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [],
          hasMore: false,
        }),
    ],
    [/^\/api\/conversations\/c9$/, () => jsonResponse({ conversation: { id: "c9", model: "auto" } })],
  ]);
  fireEvent.click(await screen.findByText("Weird chat"));
  await screen.findByText("已加载");
  const textareas = screen.getAllByRole("textbox").filter((el) => el.tagName === "TEXTAREA") as HTMLTextAreaElement[];
  // No instructions, no stored messages -> just the trailing empty user draft.
  assert.equal(textareas.length, 1);
  assert.equal(textareas[0].value, "");
});

// ---------------------------------------------------------------------------
// A few remaining defensive/fallback branches
// ---------------------------------------------------------------------------

test("remembering history with no snapshot ever saved yet falls back cleanly through every loader", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  // Deliberately no "mirror-playground-snapshot" key at all.
  await renderApp();
  assert.equal((screen.getByLabelText("模型") as HTMLSelectElement).value, "auto");
  assert.equal((screen.getByPlaceholderText(/自动生成/) as HTMLInputElement).value, "");
  assert.ok(screen.getByDisplayValue("请用一句简短的话打个招呼。"));
});

test("a throwing localStorage.setItem during the persistence effect is swallowed", async () => {
  await renderApp();
  const original = Storage.prototype.setItem;
  Storage.prototype.setItem = function patched() {
    throw new Error("quota exceeded");
  };
  try {
    // Should not throw/crash the app even though every localStorage.setItem
    // call in the persistence effect now fails.
    fireEvent.click(screen.getByLabelText("在此设备记住提示词历史"));
    assert.ok(screen.getByLabelText("在此设备记住提示词历史"));
  } finally {
    Storage.prototype.setItem = original;
  }
});

test("a conversations response whose items field isn't an array is tolerated as empty", async () => {
  await renderApp([[/^\/api\/conversations$/, () => jsonResponse({ items: "not-an-array", hasMore: false })]]);
  assert.ok(screen.getByText("暂无会话"));
});

test("scrolling when there's nothing more to load is a no-op", async () => {
  let requestCount = 0;
  await renderApp([
    [
      /^\/api\/conversations$/,
      () => {
        requestCount += 1;
        return jsonResponse({ items: [{ id: "c1", title: "Only page", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }], hasMore: false });
      },
    ],
  ]);
  const countAfterMount = requestCount;
  const list = document.querySelector(".conversation-list") as HTMLElement;
  Object.defineProperty(list, "scrollHeight", { value: 500, configurable: true });
  Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
  list.scrollTop = 450;
  await act(async () => {
    fireEvent.scroll(list);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(requestCount, countAfterMount);
});

test("loading a conversation whose response omits the conversation object falls back to the requested id", async () => {
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) =>
        jsonResponse({
          items: url.searchParams.get("offset") === "0"
            ? [{ id: "c-no-conv", title: "No conv object", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [],
          hasMore: false,
        }),
    ],
    [/^\/api\/conversations\/c-no-conv$/, () => jsonResponse({ messages: [] })],
  ]);
  fireEvent.click(await screen.findByText("No conv object"));
  await screen.findByText("已加载");
  assert.equal((screen.getByPlaceholderText(/自动生成/) as HTMLInputElement).value, "c-no-conv");
});

test("a non-Error value thrown while loading a conversation still surfaces something readable", async () => {
  await renderApp([
    [
      /^\/api\/conversations$/,
      (url) =>
        jsonResponse({
          items: url.searchParams.get("offset") === "0"
            ? [{ id: "c-weird-throw", title: "Weird throw", model: "auto", updatedAt: "2024-01-01T00:00:00.000Z" }]
            : [],
          hasMore: false,
        }),
    ],
    [/^\/api\/conversations\/c-weird-throw$/, () => { throw "a plain string reason"; }],
  ]);
  fireEvent.click(await screen.findByText("Weird throw"));
  await screen.findByText("出错");
  fireEvent.click(screen.getByRole("button", { name: /原始响应/ }));
  assert.ok(screen.getByText("a plain string reason"));
});

test("a non-Error value thrown during run() still surfaces something readable", async () => {
  await renderApp([[/^\/v1\/chat\/completions$/, () => { throw "run blew up as a plain string"; }]]);
  fireEvent.click(runButton());
  await screen.findByText("出错");
  fireEvent.click(screen.getByRole("button", { name: /原始响应/ }));
  assert.ok(screen.getByText("run blew up as a plain string"));
});

test("a stray re-entrant run() call while one is already in flight is a no-op (belt-and-suspenders guard)", async () => {
  let fetchCount = 0;
  const gate = deferred<Response>();
  await renderApp([
    [
      /^\/v1\/chat\/completions$/,
      () => {
        fetchCount += 1;
        return gate.promise;
      },
    ],
  ]);
  fireEvent.click(screen.getByLabelText("流式输出"));
  // Fire the Ctrl+Enter shortcut twice back-to-back, synchronously, before
  // React ever gets a chance to re-render the Run button into a Stop
  // button - runningRef.current is set synchronously at the very top of
  // run(), before the first await, specifically to catch this.
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  });
  await act(async () => {
    gate.resolve(jsonResponse({ choices: [{ message: { content: "only once" } }] }));
  });
  await screen.findByText("已完成");
  assert.equal(fetchCount, 1);
});

test("model selection and switching back from raw output update the visible UI", async () => {
  await renderApp([[/^\/v1\/models$/, () => jsonResponse({ data: [{ id: "g-fixture", owned_by: "chatgpt-gizmo" }] })]]);
  const option = screen.getByRole("option", { name: "GPT：g-fixture" });
  fireEvent.change(option.parentElement!, { target: { value: "g-fixture" } });
  assert.ok(screen.getByLabelText(/此 GPT／项目使用的模型/));
  fireEvent.click(screen.getByRole("button", { name: "原始响应" }));
  fireEvent.click(screen.getByRole("button", { name: "输出" }));
  assert.equal(screen.getByRole("button", { name: "输出" }).className, "active");
});

test("a malformed completion fails without appending phantom history rows", async () => {
  await renderApp([[/^\/v1\/chat\/completions$/, () => jsonResponse({ choices: [] })]]);
  fireEvent.click(screen.getByLabelText(/流式输出/));
  fireEvent.click(runButton());
  await screen.findByText("出错");
  assert.equal(document.querySelectorAll(".message-editor").length, 2);
});

test("a conversation with an empty id is ignored", async () => {
  await renderApp([[/^\/api\/conversations$/, () => jsonResponse({ items: [{ id: "", title: "Invalid conversation", model: "auto", updatedAt: "2024-01-01" }], hasMore: false })]]);
  fireEvent.click(await screen.findByText("Invalid conversation"));
  assert.ok(screen.getByText("就绪"));
});

test("a queued remove click cannot change history after a run has started", async () => {
  const gate = deferred<Response>();
  await renderApp([[/^\/v1\/chat\/completions$/, () => gate.promise]]);
  fireEvent.click(screen.getByLabelText("流式输出"));
  const remove = screen.getAllByRole("button", { name: "删除消息" })[0];
  const run = runButton();
  act(() => {
    run.click();
    remove.click();
  });
  assert.equal(document.querySelectorAll(".message-editor").length, 2);
  await act(async () => { gate.resolve(jsonResponse({ choices: [] })); });
  await screen.findByText("出错");
  assert.equal(document.querySelectorAll(".message-editor").length, 2);
});

// ---------------------------------------------------------------------------
// ConnectionTools (connection diagnostics + client setup snippet)
// ---------------------------------------------------------------------------

function connectionToolsPanel() {
  return screen.getByText("连接诊断与客户端配置").closest("details") as HTMLElement;
}

test("Test connection reports diagnostics and model discovery results, and offers a diagnostics export link", async () => {
  await renderApp([
    [/^\/api\/diagnostics$/, () => jsonResponse({ schemaVersion: 1, build: { revision: "abc1234" } })],
    [/^\/v1\/models$/, () => jsonResponse({ data: [{ id: "m1" }, { id: "m2" }] })],
  ]);
  const panel = connectionToolsPanel();
  assert.equal(within(panel).queryByText(/导出本地诊断信息/), null);
  fireEvent.click(within(panel).getByRole("button", { name: "测试连接" }));
  await within(panel).findByText(/模型列表获取成功（2 个模型）。已使用浏览器身份验证/);
  assert.match(within(panel).getByText(/"revision": "abc1234"/).textContent ?? "", /abc1234/);
  assert.ok(within(panel).getByRole("link", { name: /导出本地诊断信息/ }));
});

test("Test connection reports a supplied bearer credential separately from browser auth", async () => {
  let modelsAuth: string | undefined;
  await renderApp([
    [/^\/api\/diagnostics$/, () => jsonResponse({ schemaVersion: 1 })],
    [
      /^\/v1\/models$/,
      (_url, init) => {
        modelsAuth = (init?.headers as Record<string, string> | undefined)?.authorization;
        return jsonResponse({ data: [{ id: "m1" }] });
      },
    ],
  ]);
  fireEvent.change(screen.getByLabelText("API 密钥（Bearer）"), { target: { value: "sk-conn" } });
  const panel = connectionToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "测试连接" }));
  await within(panel).findByText(/已提供 API 密钥（Bearer）。/);
  assert.equal(modelsAuth, "Bearer sk-conn");
});

test("Test connection surfaces a failed diagnostics call without touching model discovery", async () => {
  // /v1/models is also fetched once in the background on mount (for the
  // model picker), unrelated to the Test Connection button - count calls
  // rather than asserting it's never called at all.
  let modelsCalls = 0;
  await renderApp([
    [/^\/api\/diagnostics$/, () => new Response("nope", { status: 500 })],
    [/^\/v1\/models$/, () => { modelsCalls += 1; return jsonResponse({ data: [] }); }],
  ]);
  const panel = connectionToolsPanel();
  const callsBeforeClick = modelsCalls;
  fireEvent.click(within(panel).getByRole("button", { name: "测试连接" }));
  await within(panel).findByText("诊断接口返回 HTTP 500");
  assert.equal(modelsCalls, callsBeforeClick);
});

test("Test connection surfaces a failed model-discovery HTTP status", async () => {
  await renderApp([
    [/^\/api\/diagnostics$/, () => jsonResponse({ schemaVersion: 1 })],
    [/^\/v1\/models$/, () => new Response("nope", { status: 503 })],
  ]);
  const panel = connectionToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "测试连接" }));
  await within(panel).findByText(/模型列表接口返回 HTTP 503/);
});

test("Test connection rejects a model-discovery response whose data field isn't an array", async () => {
  await renderApp([
    [/^\/api\/diagnostics$/, () => jsonResponse({ schemaVersion: 1 })],
    [/^\/v1\/models$/, () => jsonResponse({ data: "not-an-array" })],
  ]);
  const panel = connectionToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "测试连接" }));
  await within(panel).findByText("模型列表接口返回了不受支持的数据格式。");
});

test("Test connection falls back to a generic message when a non-Error value is thrown", async () => {
  await renderApp([[/^\/api\/diagnostics$/, () => { throw "unclassified failure"; }]]);
  const panel = connectionToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "测试连接" }));
  await within(panel).findByText("连接测试失败");
});

test("the generation-status note reflects whether a Playground run has completed yet", async () => {
  await renderApp([
    [
      /^\/v1\/chat\/completions$/,
      () => jsonResponse({ choices: [{ message: { content: "hi" } }] }, { headers: { "x-mirror-conversation-id": "conv-done" } }),
    ],
  ]);
  const panel = connectionToolsPanel();
  assert.ok(within(panel).getByText(/尚未验证；请点击“运行请求”发送一条测试消息/));
  fireEvent.click(screen.getByLabelText("流式输出"));
  fireEvent.click(runButton());
  await screen.findByText("已完成");
  assert.ok(within(panel).getByText(/本次测试台会话已成功完成/));
});

test("Copy setup snippet reports success or falls back to a manual-copy hint", async () => {
  await renderApp();
  const panel = connectionToolsPanel();
  assert.match(within(panel).getByText(/OpenAI\(base_url=/).textContent ?? "", /YOUR_MIRROR_KEY/);
  const nav = globalThis.navigator as unknown as { clipboard?: { writeText: (text: string) => Promise<void> } };
  const originalClipboard = nav.clipboard;
  try {
    nav.clipboard = { writeText: async () => {} };
    fireEvent.click(within(panel).getByRole("button", { name: "复制配置代码" }));
    await within(panel).findByText("客户端配置代码已复制");
    nav.clipboard = { writeText: async () => { throw new Error("denied"); } };
    fireEvent.click(within(panel).getByRole("button", { name: "复制配置代码" }));
    await within(panel).findByText("请选中并复制上方的配置代码");
  } finally {
    nav.clipboard = originalClipboard;
  }
});

// ---------------------------------------------------------------------------
// ConversationTools (local search, branches, and export)
// ---------------------------------------------------------------------------

function conversationToolsPanel() {
  return screen.getByText("本地搜索、会话分支与导出").closest("details") as HTMLElement;
}

test("with no active conversation, only local search is offered (no branches or export controls)", async () => {
  await renderApp();
  const panel = conversationToolsPanel();
  assert.equal(within(panel).queryByRole("button", { name: "查看会话分支" }), null);
  assert.equal(within(panel).queryByRole("link", { name: "导出 JSON" }), null);
  assert.ok((within(panel).getByRole("button", { name: "搜索历史" }) as HTMLButtonElement).disabled);
});

test("searching local history renders matches and a result count, and selecting one loads it", async () => {
  await renderApp([
    [
      /^\/api\/conversations\/search/,
      (url) => {
        assert.equal(url.searchParams.get("q"), "needle");
        return jsonResponse({ items: [{ id: "found-1", title: "Found conversation" }] });
      },
    ],
  ]);
  const panel = conversationToolsPanel();
  fireEvent.change(within(panel).getByLabelText("搜索本地历史记录"), { target: { value: "needle" } });
  const searchButton = within(panel).getByRole("button", { name: "搜索历史" });
  assert.equal((searchButton as HTMLButtonElement).disabled, false);
  fireEvent.click(searchButton);
  await within(panel).findByText("找到 1 条本地匹配记录（最多 100 条）");
  const resultButton = within(panel).getByRole("button", { name: "Found conversation" });
  fireEvent.click(resultButton);
  await screen.findByText("已加载");
  assert.equal((screen.getByPlaceholderText(/自动生成/) as HTMLInputElement).value, "found-1");
});

test("a failed local search reports the error instead of throwing", async () => {
  await renderApp([[/^\/api\/conversations\/search/, () => new Response("nope", { status: 500 })]]);
  const panel = conversationToolsPanel();
  fireEvent.change(within(panel).getByLabelText("搜索本地历史记录"), { target: { value: "needle" } });
  fireEvent.click(within(panel).getByRole("button", { name: "搜索历史" }));
  await within(panel).findByText(/历史记录接口返回 HTTP 500。请刷新后重试。/);
});

test("conversation branches list parents and nodes, and continuing from an assistant node selects the branch", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem("mirror-playground-snapshot", JSON.stringify({ conversationId: "conv-remembered", messages: [] }));
  let branchBody: unknown;
  await renderApp([
    [
      /^\/api\/conversations\/conv-remembered\/branches$/,
      () =>
        jsonResponse({
          selected: "conv-remembered",
          parent: "node-7",
          items: [{ id: "conv-remembered", title: "Current" }, { id: "conv-saved", title: "Saved branch" }],
          nodes: [
            { id: "m-user", upstreamNodeId: "node-6", role: "user", status: "done" },
            { id: "m-pending", upstreamNodeId: null, role: "assistant", status: "streaming" },
            { id: "m-asst", upstreamNodeId: "node-7", role: "assistant", status: "done" },
            { id: "m-other", upstreamNodeId: "node-8", role: "tool", status: "queued" },
          ],
        }),
    ],
    [
      /^\/api\/conversations\/conv-remembered\/branch$/,
      (_url, init) => {
        branchBody = JSON.parse(String(init?.body));
        return jsonResponse({ id: "conv-branched" });
      },
    ],
  ]);
  const panel = conversationToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "查看会话分支" }));
  const continueButton = await within(panel).findByRole("button", { name: "从此助手消息继续" });
  assert.ok(within(panel).getByRole("button", { name: "Saved branch" }));
  // A node with no upstream node id yet (e.g. still streaming) falls back
  // to a plain label instead of rendering a blank <code> element - and
  // does not offer to "continue" from it (that button only appears once
  // an assistant node has a real upstream node id).
  assert.ok(within(panel).getByText("无上游节点"));
  assert.ok(within(panel).getByText("用户 · 已完成"));
  assert.ok(within(panel).getByText("助手 · 生成中"));
  assert.ok(within(panel).getByText("其他角色 · 其他状态"));
  fireEvent.click(continueButton);
  await screen.findByText("已加载");
  assert.deepEqual(branchBody, { messageId: "m-asst" });
  assert.equal((screen.getByPlaceholderText(/自动生成/) as HTMLInputElement).value, "conv-branched");
  // Selecting a branch resets the branch listing itself (it belonged to the
  // conversation we just navigated away from).
  assert.equal(within(panel).queryByRole("button", { name: "从此助手消息继续" }), null);
});

test("selecting a listed branch (not the current one) loads it", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem("mirror-playground-snapshot", JSON.stringify({ conversationId: "conv-remembered", messages: [] }));
  await renderApp([
    [
      /^\/api\/conversations\/conv-remembered\/branches$/,
      () =>
        jsonResponse({
          selected: "conv-remembered",
          parent: "node-7",
          items: [{ id: "conv-remembered", title: "Current" }, { id: "conv-saved", title: "Saved branch" }],
          nodes: [],
        }),
    ],
  ]);
  const panel = conversationToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "查看会话分支" }));
  fireEvent.click(await within(panel).findByRole("button", { name: "Saved branch" }));
  await screen.findByText("已加载");
  assert.equal((screen.getByPlaceholderText(/自动生成/) as HTMLInputElement).value, "conv-saved");
});

test("a failed request to create a branch reports the error instead of throwing", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem("mirror-playground-snapshot", JSON.stringify({ conversationId: "conv-remembered", messages: [] }));
  await renderApp([
    [
      /^\/api\/conversations\/conv-remembered\/branches$/,
      () =>
        jsonResponse({
          selected: "conv-remembered",
          parent: "node-7",
          items: [{ id: "conv-remembered", title: "Current" }],
          nodes: [{ id: "m-asst", upstreamNodeId: "node-7", role: "assistant", status: "done" }],
        }),
    ],
    [/^\/api\/conversations\/conv-remembered\/branch$/, () => new Response("nope", { status: 500 })],
  ]);
  const panel = conversationToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "查看会话分支" }));
  fireEvent.click(await within(panel).findByRole("button", { name: "从此助手消息继续" }));
  await within(panel).findByText(/历史记录接口返回 HTTP 500。请刷新后重试。/);
});

test("a failed branch listing reports the error instead of throwing", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem("mirror-playground-snapshot", JSON.stringify({ conversationId: "conv-remembered", messages: [] }));
  await renderApp([[/^\/api\/conversations\/conv-remembered\/branches$/, () => new Response("nope", { status: 404 })]]);
  const panel = conversationToolsPanel();
  fireEvent.click(within(panel).getByRole("button", { name: "查看会话分支" }));
  await within(panel).findByText(/历史记录接口返回 HTTP 404。请刷新后重试。/);
});

test("export links include the selected attachment/metadata flags and format", async () => {
  localStorage.setItem("mirror-playground-remember-history", "true");
  localStorage.setItem("mirror-playground-snapshot", JSON.stringify({ conversationId: "conv-remembered", messages: [] }));
  await renderApp();
  const panel = conversationToolsPanel();
  const jsonLink = () => within(panel).getByRole("link", { name: "导出 JSON" });
  const markdownLink = () => within(panel).getByRole("link", { name: "导出 Markdown" });
  assert.equal(jsonLink().getAttribute("href"), "/api/conversations/conv-remembered/export?attachments=false&metadata=false&format=json");
  assert.equal(markdownLink().getAttribute("href"), "/api/conversations/conv-remembered/export?attachments=false&metadata=false&format=markdown");
  fireEvent.click(within(panel).getByLabelText("包含附件引用（不包含文件内容）"));
  fireEvent.click(within(panel).getByLabelText("包含 ID、模型和消息元数据"));
  assert.equal(jsonLink().getAttribute("href"), "/api/conversations/conv-remembered/export?attachments=true&metadata=true&format=json");
  assert.equal(markdownLink().getAttribute("href"), "/api/conversations/conv-remembered/export?attachments=true&metadata=true&format=markdown");
});

for (const transport of ["stream", "metadata", "header"]) test(`Responses mode ${transport} retains the transcript and switches back to Chat`, async () => {
  let posted: any;
  await renderApp([[/^\/v1\/responses$/, (_url, init) => {
    posted = JSON.parse(String(init?.body));
    const response = { status: "completed", ...(transport !== "header" ? { metadata: { conversation_id: "responses-id" } } : {}),
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Responses answer" }] }] };
    if (transport === "stream") return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    return jsonResponse(response, { headers: { "x-mirror-conversation-id": "responses-id" } });
  }]]);
  const chat = screen.getByRole("button", { name: /对话$/ });
  fireEvent.click(chat); // selecting the current mode preserves its state
  fireEvent.click(screen.getByRole("button", { name: /Responses API（响应接口）$/ }));
  assert.ok(screen.getByRole("heading", { name: "Responses API（响应接口）" }));
  fireEvent.click(screen.getByRole("button", { name: /Responses API（响应接口）$/ }));
  if (transport !== "stream") fireEvent.click(screen.getByRole("checkbox", { name: /流式输出/ }));
  fireEvent.click(runButton());
  await screen.findByText("已完成");
  assert.ok(Array.isArray(posted.input));
  assert.equal(posted.messages, undefined);
  assert.ok(screen.getAllByDisplayValue("Responses answer").length);
  assert.equal((screen.getByLabelText(/会话 ID/) as HTMLInputElement).value, "responses-id");
  fireEvent.click(chat);
  assert.ok(screen.getByRole("heading", { name: "对话" }));
  assert.ok(screen.getAllByDisplayValue("Responses answer").length);
  assert.equal((screen.getByLabelText(/会话 ID/) as HTMLInputElement).value, "responses-id");
});

// ---------------------------------------------------------------------------
// File attachments (playground upload button)
// ---------------------------------------------------------------------------

function lastAttachInput() {
  const inputs = screen.getAllByLabelText("\uD83D\uDCCE 添加附件") as HTMLInputElement[];
  return inputs.at(-1) as HTMLInputElement;
}

test("attaching an image preserves its filename for server extension detection", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  await renderApp([
    [
      /^\/v1\/chat\/completions$/,
      (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse({ choices: [{ message: { content: "I see a cat" } }] });
      },
    ],
  ]);
  fireEvent.change(lastUserTextarea(), { target: { value: "what is this?" } });
  const file = new window.File(["fake-bytes"], "cat.png", { type: "image/png" });
  fireEvent.change(lastAttachInput(), { target: { files: [file] } });
  await screen.findByText("cat.png");
  fireEvent.click(screen.getByLabelText("流式输出"));
  fireEvent.click(runButton());
  await screen.findByText("已完成");
  const messages = (capturedBody as unknown as { messages: Array<{ content: unknown }> }).messages;
  const sentContent = messages.at(-1)?.content as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(sentContent));
  assert.deepEqual(sentContent[0], { type: "text", text: "what is this?" });
  const imagePart = sentContent[1] as { type: string; file: { filename: string; file_data: string } };
  assert.equal(imagePart.type, "file");
  assert.equal(imagePart.file.filename, "cat.png");
  assert.equal(imagePart.file.file_data, "data:image/png;base64," + Buffer.from("fake-bytes").toString("base64"));
});

test("attaching a non-image file sends it as a file part with its filename", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  await renderApp([
    [
      /^\/v1\/chat\/completions$/,
      (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse({ choices: [{ message: { content: "Summarized" } }] });
      },
    ],
  ]);
  const file = new window.File(["hello world"], "notes.txt", { type: "text/plain" });
  fireEvent.change(lastAttachInput(), { target: { files: [file] } });
  await screen.findByText("notes.txt");
  fireEvent.click(screen.getByLabelText("流式输出"));
  fireEvent.click(runButton());
  await screen.findByText("已完成");
  const messages = (capturedBody as unknown as { messages: Array<{ content: unknown }> }).messages;
  const sentContent = messages.at(-1)?.content as Array<Record<string, unknown>>;
  const filePart = sentContent[1] as { type: string; file: { file_data: string; filename: string } };
  assert.equal(filePart.type, "file");
  assert.equal(filePart.file.filename, "notes.txt");
  assert.match(filePart.file.file_data, /^data:text\/plain;base64,/);
});

test("removing an attachment drops its chip and its content part", async () => {
  await renderApp();
  const file = new window.File(["x"], "temp.txt", { type: "text/plain" });
  fireEvent.change(lastAttachInput(), { target: { files: [file] } });
  await screen.findByText("temp.txt");
  fireEvent.click(screen.getByLabelText("移除附件 temp.txt"));
  await waitFor(() => assert.equal(screen.queryByText("temp.txt"), null));
});

test("a message with no attachments is still sent as a plain string (back-compat)", async () => {
  let capturedBody: Record<string, unknown> | null = null;
  await renderApp([
    [
      /^\/v1\/chat\/completions$/,
      (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      },
    ],
  ]);
  fireEvent.change(lastUserTextarea(), { target: { value: "plain text only" } });
  fireEvent.click(screen.getByLabelText("流式输出"));
  fireEvent.click(runButton());
  await screen.findByText("已完成");
  const messages = (capturedBody as unknown as { messages: Array<{ content: unknown }> }).messages;
  assert.equal(messages.at(-1)?.content, "plain text only");
});

test("a file-only user message can run and attachment placement matches the endpoint", async () => {
  let sent: any;
  await renderApp([[/^\/v1\/chat\/completions$/, (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return jsonResponse({ choices: [{ message: { content: "Received" } }] });
  }]]);
  assert.equal(screen.getAllByLabelText("📎 添加附件").length, 1);
  fireEvent.change(lastUserTextarea(), { target: { value: "" } });
  fireEvent.change(lastAttachInput(), { target: { files: [new window.File(["# contents"], "notes.md")] } });
  await screen.findByText("notes.md");
  assert.equal((screen.getByRole("button", { name: "＋ 添加消息" }) as HTMLButtonElement).disabled, true);
  fireEvent.click(screen.getByLabelText("流式输出"));
  fireEvent.click(runButton());
  await screen.findByText("已完成");
  assert.equal(sent.messages.at(-1).content.length, 1);
  assert.equal(sent.messages.at(-1).content[0].file.filename, "notes.md");
  assert.equal(screen.getAllByLabelText("📎 添加附件").length, 1);
});

test("Responses mode explains unsupported attachments and preserves them for Chat", async () => {
  await renderApp();
  fireEvent.change(lastAttachInput(), { target: { files: [new window.File(["# contents"], "notes.md")] } });
  await screen.findByText("notes.md");
  fireEvent.click(screen.getByRole("button", { name: "◇ Responses API（响应接口）" }));
  assert.equal(screen.queryByLabelText("📎 添加附件"), null);
  fireEvent.click(runButton());
  await screen.findByText("已阻止");
  assert.ok(screen.getByText(/文件附件仅支持对话模式/));
  fireEvent.click(screen.getByRole("button", { name: "☷ 对话" }));
  assert.ok(screen.getByText("notes.md"));
  assert.ok(lastAttachInput());
});

for (const readerError of [null, new Error("File is no longer readable"), "File read failed"]) test(`file read failures preserve the draft and report ${readerError instanceof Error ? readerError.message : readerError ?? "a fallback error"}`, async (t) => {
  await renderApp();
  t.mock.method(FileReader.prototype, "readAsDataURL", function(this: FileReader) {
    if (typeof readerError === "string") throw readerError;
    Object.defineProperty(this, "error", { value: readerError });
    this.onerror!(new window.ProgressEvent("error") as ProgressEvent<FileReader>);
  });
  fireEvent.change(lastAttachInput(), { target: { files: [new window.File(["data"], "failed.md")] } });
  await screen.findByText("出错");
  assert.ok(screen.getByText(readerError instanceof Error ? readerError.message : readerError ?? "无法读取文件"));
  assert.equal(screen.queryByText("failed.md"), null);
  assert.equal(lastUserTextarea().value, "请用一句简短的话打个招呼。");
  assert.equal((runButton() as HTMLButtonElement).disabled, false);
});

test("empty file selections are ignored and unnamed files get a usable label", async () => {
  await renderApp();
  fireEvent.change(lastAttachInput(), { target: { files: [] } });
  assert.ok(screen.getByText("就绪"));
  fireEvent.change(lastAttachInput(), { target: { files: [new window.File(["bytes"], "")] } });
  await screen.findByText("attachment");
});

test("a queued attachment removal cannot change the submitted message", async () => {
  const gate = deferred<Response>();
  await renderApp([[/^\/v1\/chat\/completions$/, () => gate.promise]]);
  fireEvent.change(lastAttachInput(), { target: { files: [new window.File(["bytes"], "notes.md")] } });
  await screen.findByText("notes.md");
  fireEvent.click(screen.getByLabelText("流式输出"));
  const remove = screen.getByLabelText("移除附件 notes.md");
  const run = runButton();
  act(() => { run.click(); remove.click(); });
  await act(async () => gate.resolve(jsonResponse({ choices: [{ message: { content: "Received" } }] })));
  await screen.findByText("已完成");
  assert.ok(screen.getByText("notes.md"));
});
});
