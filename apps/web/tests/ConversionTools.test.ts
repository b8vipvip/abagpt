import "./dom-setup.js";
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConversionTools, withPromptSource } from "../src/ConversionTools.js";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const enc = (value: string) => btoa(unescape(encodeURIComponent(value)));
function mount(opts: { chatModeActive?: boolean; disabled?: boolean; fetcher?: typeof fetch } = {}) {
  const inserted: string[] = [];
  const attached: unknown[] = [];
  globalThis.fetch = opts.fetcher ?? (async (input) => {
    const url = String(input);
    if (url.includes("/encode")) return json({ bytes: 3, dataBase64: "AQID", loaf: "SHA256(-)=x abc" });
    if (url.includes("/decode")) return json({ bytes: 5, dataBase64: enc("hello"), entries: [{ bytes: 5, contentBase64: enc("hello") }] });
    if (url.includes("gpt-prompt")) return json({ prompt: "decode this with GPT" });
    if (url.includes("mystery")) return json({ format: "pngspeak", surprise: "surprise", bytes: 3, dataBase64: "AQID" });
    if (url.includes("fortune")) return new Response(Buffer.from([1, 2, 3]));
    return json({});
  }) as typeof fetch;
  render(React.createElement(ConversionTools, {
    chatModeActive: opts.chatModeActive ?? true,
    disabled: opts.disabled ?? false,
    onInsertText: (text: string) => inserted.push(text),
    onAttach: (item: unknown) => attached.push(item),
  }));
  return { inserted, attached };
}
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const selectFormat = (value: string) => fireEvent.change(screen.getByLabelText("格式"), { target: { value } });

test.describe("web / ConversionTools", () => {
  test.afterEach(() => { cleanup(); });

  test("only builds a GPT prompt when source bytes are available", () => {
    let calls = 0;
    assert.equal(withPromptSource(undefined, () => { calls++; }), undefined);
    assert.equal(withPromptSource("AQID", () => { calls++; return "built"; }), "built");
    assert.equal(calls, 1);
  });

  test("encodes images and LoaF, builds GPT prompts, and attaches generated files", async () => {
    const seen: Array<[string, any]> = [];
    const { inserted, attached } = mount({ fetcher: (async (input, init) => {
      const url = String(input); seen.push([url, init?.body ? JSON.parse(String(init.body)) : null]);
      if (url.includes("gpt-prompt")) return json({ prompt: "ask GPT to decode" });
      if (url.includes("loaf/encode")) return json({ bytes: 20, loaf: "SHA256(-)=hash deadbeef" });
      return json({ bytes: 3, dataBase64: "AQID" });
    }) as typeof fetch });
    click("编码");
    await screen.findByAltText(/已编码的 PngSpeak/);
    assert.equal(screen.getByRole("link", { name: /下载/ }).getAttribute("download"), "mirror-convert.pngspk.png");
    click(/将解码提示词插入对话/);
    await waitFor(() => assert.deepEqual(inserted, ["ask GPT to decode"]));
    assert.ok(seen.some(([url, body]) => url.includes("gpt-prompt") && body.filename === "message.pngspk.png"));
    click(/添加到对话附件/);
    await waitFor(() => assert.equal(attached.length, 1));
    assert.match((attached[0] as any).dataUrl, /^data:image\/png;base64,AQID$/);
    selectFormat("loaf");
    click("编码");
    await screen.findByText(/编码完成：LoaF（文本归档），共 20 字节/);
    assert.equal(screen.getByRole("link", { name: /下载/ }).getAttribute("download"), "mirror-convert.loaf");
    assert.ok(seen.some(([url, body]) => url.includes("loaf/encode") && body.entries[0].name === "message.txt"));
    assert.ok(screen.getByRole("link", { name: /下载/ }));
  });

  test("file selection encodes its bytes, clears the picker, and gracefully reports a rejected encoder", async () => {
    let captured: any;
    mount({ fetcher: (async (_url, init) => { captured = JSON.parse(String(init?.body)); return json({ error: "bad file" }, 422); }) as typeof fetch });
    const file = new File([new Uint8Array([0, 128, 255])], "tiny.bin", { type: "application/octet-stream" });
    fireEvent.change(screen.getByLabelText(/选择文件进行编码/), { target: { files: [file] } });
    await screen.findByText("bad file");
    assert.equal(captured.dataBase64, "AID/");
    assert.equal((screen.getByLabelText(/选择文件进行编码/) as HTMLInputElement).value, "");
    cleanup();
    mount({ fetcher: (async () => { throw new Error("offline"); }) as typeof fetch });
    click("编码");
    await screen.findByText("offline");
  });

  test("mystery and fortune actions render their results, prompt eligibility, and chat attachment behavior", async () => {
    const { inserted, attached } = mount();
    click(/神秘编码/);
    await screen.findByText(/神秘格式：pngspeak/);
    click(/将解码提示词插入对话/);
    await waitFor(() => assert.deepEqual(inserted, ["decode this with GPT"]));
    click(/添加到对话附件/);
    await waitFor(() => assert.equal(attached.length, 1));
    click(/幸运签/);
    await screen.findByText(/你的幸运签藏在一张 PngSpeak PNG 图片中/);
    const buttons = screen.getAllByRole("button", { name: /将解码提示词插入对话/ });
    assert.equal((buttons.at(-1) as HTMLButtonElement).disabled, true);
    assert.match((buttons.at(-1) as HTMLButtonElement).title, /服务器随机生成/);
    click(/添加到对话附件/);
    await waitFor(() => assert.equal(attached.length, 2));
  });

  test("fortune can choose text format and endpoint failures surface their messages", async () => {
    const responses: Response[] = [new Response(Buffer.from("plain fortune"))];
    mount({ fetcher: (async () => responses.shift() ?? json({ error: "fortune failed" }, 500)) as typeof fetch });
    click(/幸运签/);
    await screen.findByText(/你的幸运签藏在一张 PngSpeak PNG 图片中/);
    click(/神秘编码/);
    await screen.findByText("就绪");
  });

  test("supports all mystery artifact labels and prompts, blank fallback, and non-Error prompt failure", async () => {
    const inserted: string[] = [];
    let mysteryFormat = "gptgif-v4";
    let promptError: unknown = "prompt offline";
    mount({ fetcher: (async (input) => {
      const url = String(input);
      if (url.includes("mystery")) return json({ format: mysteryFormat, surprise: "surprise", bytes: 3, dataBase64: "AQID" });
      if (url.includes("gpt-prompt")) throw promptError;
      return json({ bytes: 3, dataBase64: "AQID" });
    }) as typeof fetch });
    fireEvent.change(screen.getByLabelText("要编码的文本"), { target: { value: "" } });
    click(/神秘编码/);
    await screen.findByText(/神秘格式：gptgif-v4/);
    click(/将解码提示词插入对话/);
    await screen.findByText("无法生成提示词");
    promptError = new Error("prompt service down");
    click(/将解码提示词插入对话/);
    await screen.findByText("prompt service down");
    mysteryFormat = "gptgif";
    click(/神秘编码/);
    await screen.findByText(/神秘格式：gptgif/);
    mysteryFormat = "loaf";
    click(/神秘编码/);
    await screen.findByText(/神秘格式：loaf/);
  });

  test("encodes both GIF variants and uses HTTP fallback text plus fortune error fallback", async () => {
    mount({ fetcher: (async (input) => {
      const url = String(input);
      if (url.includes("fortune")) throw new Error("fortune offline");
      if (url.includes("gptgif-v4/encode")) return json({ bytes: 4, dataBase64: "R0lG" });
      if (url.includes("gptgif/encode")) return json({ bytes: 5, dataBase64: "R0lGODlh" });
      return json({}, 503);
    }) as typeof fetch });
    selectFormat("gptgif-v4");
    click("编码");
    await screen.findByAltText(/已编码的 gptgif v4/);
    assert.equal(screen.getByRole("link", { name: /下载/ }).getAttribute("download"), "mirror-convert.gptgif-v4.gif");
    selectFormat("gptgif");
    click("编码");
    await screen.findByAltText(/已编码的 gptgif 原版/);
    assert.equal(screen.getByRole("link", { name: /下载/ }).getAttribute("download"), "mirror-convert.gptgif.gif");
    click(/幸运签/);
    await screen.findByText("fortune offline");
    selectFormat("pngspeak");
    click("编码");
    await screen.findByText(/HTTP 503/);
  });

  test("handles non-Error decode failures and empty file picker selections", async () => {
    mount({ fetcher: (async (input) => {
      if (String(input).includes("/decode")) throw "decode offline";
      return json({});
    }) as typeof fetch });
    fireEvent.change(screen.getByLabelText(/解码/), { target: { value: "AQID" } });
    click("解码");
    await screen.findByText("解码失败。");
    fireEvent.change(screen.getByLabelText(/选择文件进行编码/), { target: { files: [] } });
    assert.equal(screen.queryByText("正在编码…"), null);
  });

  test("decodes a non-empty LoaF archive and safely ignores an artifact without prompt source bytes", async () => {
    const requests: string[] = [];
    mount({ fetcher: (async (input) => String(input).includes("loaf/decode")
      ? json({ entries: [{ bytes: 2, contentBase64: enc("ok") }] })
      : String(input).includes("fortune") ? new Response(Buffer.from([1])) : (requests.push(String(input)), json({})) ) as typeof fetch });
    selectFormat("loaf");
    fireEvent.change(screen.getByLabelText(/解码/), { target: { value: "some loaf" } });
    click("解码");
    await screen.findByText("ok");
    click(/幸运签/);
    await screen.findByText(/你的幸运签藏在一张 PngSpeak PNG 图片中/);
    const promptButton = screen.getAllByRole("button", { name: /将解码提示词插入对话/ }).at(-1) as HTMLButtonElement;
    promptButton.disabled = false;
    click(/将解码提示词插入对话/);
    assert.equal(requests.some(url => url.includes("gpt-prompt")), false);
  });

  test("decodes text and binary, provides downloads, and inserts decoded text", async () => {
    const { inserted } = mount({ fetcher: (async (input) => String(input).includes("/decode")
      ? json({ bytes: 5, dataBase64: enc("hello") }) : json({}) ) as typeof fetch });
    fireEvent.change(screen.getByLabelText(/解码/), { target: { value: "AQID" } });
    click("解码");
    await screen.findByText("hello");
    click(/将解码文本插入对话/);
    assert.deepEqual(inserted, ["hello"]);
    assert.ok(screen.getByRole("link", { name: /下载解码后的数据/ }));
    cleanup();
    mount({ fetcher: (async (input) => String(input).includes("/decode") ? json({ bytes: 1, dataBase64: "/w==" }) : json({})) as typeof fetch });
    fireEvent.change(screen.getByLabelText(/解码/), { target: { value: "bad bytes" } });
    click("解码");
    await screen.findByText(/不是有效的 UTF-8 文本/);
    assert.equal(screen.queryByRole("button", { name: /将解码文本插入对话/ }), null);
  });

  test("LoaF decode rejects empty archives and gptgif failures explain the calibration hint", async () => {
    mount({ fetcher: (async (input) => String(input).includes("loaf/decode") ? json({ entries: [] }) : json({ error: "no fixed map" }, 400)) as typeof fetch });
    selectFormat("loaf");
    fireEvent.change(screen.getByLabelText(/解码/), { target: { value: "not-empty" } });
    click("解码");
    await screen.findByText("该 LoaF 归档中没有文件条目。");
    selectFormat("gptgif");
    fireEvent.change(screen.getByLabelText(/解码/), { target: { value: "bad" } });
    click("解码");
    await screen.findByText(/no fixed map.*没有固定字母表/);
  });

  test("disabled and Playground modes keep chat mutations unavailable while encoding remains usable", async () => {
    mount({ chatModeActive: false, disabled: true });
    click("编码");
    await screen.findByAltText(/已编码的 PngSpeak/);
    assert.equal((screen.getByRole("button", { name: /添加到对话附件/ }) as HTMLButtonElement).disabled, true);
  });

  test("non-Error fetch rejections use the component's fallback messages", async () => {
    mount({ fetcher: (async () => { throw "offline string"; }) as typeof fetch });
    click("编码");
    await screen.findByText("编码失败");
    click(/神秘编码/);
    await screen.findByText("操作未成功");
  });
});
