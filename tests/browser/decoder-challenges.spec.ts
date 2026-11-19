import { test, expect } from "@playwright/test";
import Fastify from "fastify";
import { injectionJs, injectionCss } from "../../apps/server/dist/mirror-controls.js";
import { registerDecoderChallengeRoutes } from "../../apps/server/dist/decoder-challenges.js";
import { extractLoaf } from "../../apps/server/dist/loaf.js";
import { decodePngSpeak } from "../../apps/server/dist/pngspeak.js";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

test.describe("browser / official UI decoder challenges", () => {
  let app: ReturnType<typeof Fastify>;
  let generated: any;
  let conversionCalls: any[];
  test.beforeEach(async ({ page }) => {
    app = Fastify(); registerDecoderChallengeRoutes(app, () => "browser-fixture");
    await app.ready();
    generated = null;
    conversionCalls = [];
    await page.route("**/api/session", route => route.fulfill({ json: { configured: true } }));
    await page.route("**/api/health", route => route.fulfill({ json: { egress: { mode: "direct" } } }));
    await page.route("**/api/convert/gpt-prompt", async route => {
      const body = route.request().postDataJSON(); conversionCalls.push(body);
      await route.fulfill({ json: { format: body.format, prompt: `FORMAT API PROMPT for ${body.format}\n${body.note}` } });
    });
    await page.route("**/api/decoder-challenges**", async route => {
      const req = route.request();
      const payload = req.postData() === null ? undefined : req.postDataJSON();
      const response = await app.inject({ method: req.method() as any, url: new URL(req.url()).pathname, payload });
      const contentType = String(response.headers["content-type"] || "application/octet-stream");
      if (req.method() === "POST" && new URL(req.url()).pathname === "/api/decoder-challenges") {
        console.log(`[decoder fixture] request=${JSON.stringify(payload)} status=${response.statusCode} type=${contentType} body=${response.payload.slice(0, 220)}`);
        if (response.statusCode === 200) {
          try { generated = response.json(); }
          catch (error) { console.log("[decoder fixture] response JSON parse failed", error); throw error; }
        }
      }
      if (response.statusCode >= 400) console.log(`[decoder fixture] ${req.method()} ${new URL(req.url()).pathname}: ${response.statusCode} ${response.payload}`);
      await route.fulfill({ status: response.statusCode, contentType, body: contentType.includes("application/json") ? response.payload : response.rawPayload });
    });
    await page.route("**/decoder-fixture", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head><style>body{background:#212121;color:white;font:16px system-ui;margin:0}aside{width:250px;padding:16px;height:100vh;background:#181818}aside>div{position:absolute;bottom:20px;width:220px}main{position:absolute;left:290px;top:50px;width:55%}#prompt-textarea{white-space:pre-wrap;background:#303030;border-radius:18px;padding:18px;min-height:60px;max-height:250px;overflow:auto}</style></head><body><aside><div><div><button data-testid="accounts-profile-button">Account</button></div></div></aside><main><h1>ChatGPT</h1><div id="messages"></div><div id="prompt-textarea" contenteditable="true" role="textbox" aria-label="Message ChatGPT"></div></main></body></html>` }));
    await page.goto("/decoder-fixture");
    await page.addStyleTag({ content: injectionCss });
    await page.addScriptTag({ content: injectionJs });
    await page.locator("#mirror-format-lab-launcher").click();
  });
  test.afterEach(async () => { await app.close(); });

  for (const format of ["loaf", "pngspeak", "gptgif", "gptgif-v4"]) {
    test(`${format}: create, insert exact prompt, and preserve the draft`, async ({ page }) => {
      await page.getByRole("combobox", { name: "格式", exact: true }).selectOption(format);
      await page.getByRole("button", { name: "生成挑战", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("已就绪。");
      await expect(page.getByLabel("挑战提示词")).toHaveValue(generated.prompt);
      await page.getByRole("button", { name: "插入对话", exact: true }).click();
      await expect(page.getByRole("dialog")).not.toBeVisible();
      expect(await page.locator("#prompt-textarea").innerText()).toBe(generated.prompt);
      await page.locator("#mirror-format-lab-launcher").click();
      await page.getByRole("button", { name: "插入对话", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("输入框中已有草稿");
      expect(await page.locator("#prompt-textarea").innerText()).toBe(generated.prompt);
    });
  }
  test("grades the latest matching GPT answer, rejects another challenge, and reports partial/mismatch", async ({ page }) => {
    await page.getByRole("button", { name: "生成挑战", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已就绪。");
    const artifact = gunzipSync(Buffer.from(generated.prompt.split("BEGIN_GZIP_BASE64\n")[1].split("\nEND_GZIP_BASE64")[0], "base64"));
    const answer = decodePngSpeak(artifact).toString("hex");
    await page.evaluate(text => {
      const message = document.createElement("div"); message.dataset.messageAuthorRole = "assistant"; message.style.whiteSpace = "pre-wrap"; message.textContent = text;
      document.getElementById("messages")!.appendChild(message);
    }, `Recovered using Python.\nMIRROR_ANSWER_${generated.id}: ${answer}`);
    await page.getByRole("button", { name: "检查 GPT 最新回复" }).click();
    await expect(page.getByRole("status")).toContainText("完全匹配");
    await page.getByLabel("或粘贴恢复出的十六进制内容 / 带标记的答案行").fill(answer.slice(0, -2));
    await page.getByRole("button", { name: "校验粘贴的答案" }).click();
    await expect(page.getByRole("status")).toContainText("部分匹配");
    await page.getByLabel("或粘贴恢复出的十六进制内容 / 带标记的答案行").fill("00");
    await page.getByRole("button", { name: "校验粘贴的答案" }).click();
    await expect(page.getByRole("status")).toContainText("不匹配");
    await page.getByRole("button", { name: "生成挑战", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已就绪。");
    await page.getByRole("button", { name: "检查 GPT 最新回复" }).click();
    await expect(page.getByRole("status")).toContainText("此挑战应包含且仅包含一行 MIRROR_ANSWER 答案标记");
  });
  test("pasted marked answers, browser reload, binary/independent mode, and expiration", async ({ page }) => {
    await page.getByRole("combobox", { name: "格式", exact: true }).selectOption("loaf");
    await page.getByRole("combobox", { name: "提示模式", exact: true }).selectOption("independent");
    await page.getByRole("combobox", { name: "隐藏载荷", exact: true }).selectOption("binary");
    await page.getByRole("button", { name: "生成挑战", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已就绪。");
    const challenge = generated;
    const artifact = gunzipSync(Buffer.from(challenge.prompt.split("BEGIN_GZIP_BASE64\n")[1].split("\nEND_GZIP_BASE64")[0], "base64"));
    const answer = extractLoaf(artifact.toString())[0].content.toString("hex");
    await page.reload(); await page.addStyleTag({ content: injectionCss }); await page.addScriptTag({ content: injectionJs });
    await page.locator("#mirror-format-lab-launcher").click();
    await expect(page.getByLabel("挑战提示词")).toHaveValue(challenge.prompt);
    await page.getByLabel("或粘贴恢复出的十六进制内容 / 带标记的答案行").fill(`MIRROR_ANSWER_${challenge.id}: ${answer}`);
    await page.getByRole("button", { name: "校验粘贴的答案" }).click();
    await expect(page.getByRole("status")).toContainText("完全匹配");
    await page.route("**/api/decoder-challenges/*/verify", route => route.fulfill({ status: 404, json: { error: "Challenge expired or unavailable. Generate a new one." } }));
    await page.getByRole("button", { name: "校验粘贴的答案" }).click();
    await expect(page.getByRole("status")).toContainText("挑战不存在或已过期");
  });
  test("narrow layout, keyboard close, generation failure and missing composer", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.locator("#mirror-decoder").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.getByRole("button", { name: "生成挑战", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("已就绪。");
    await page.evaluate(() => document.getElementById("prompt-textarea")!.remove());
    await page.getByRole("button", { name: "插入对话", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("未找到 ChatGPT 输入框");
    await page.route("**/api/decoder-challenges", route => route.fulfill({ status: 429, json: { error: "Try again shortly." } }));
    await page.getByRole("button", { name: "生成挑战", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("请求过于频繁，请稍后再试。");
    await expect(page.getByRole("button", { name: "生成挑战", exact: true })).toBeEnabled();
    await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).not.toBeVisible();
  });
  test("optional download contains all four matching kits and each challenge remains selectable", async ({ page }) => {
    await page.getByText("可选：获取文件和提示词", { exact: true }).click();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载全部四种格式套件", exact: true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe("mirror-decoder-kits.tar.gz");
    const data = await readFile((await download.path())!);
    const hex = data.toString("hex");
    const entries = extractLoaf(`SHA256(-)=${createHash("sha256").update(hex).digest("hex")} ${hex}`);
    expect(entries).toHaveLength(16);
    await expect(page.getByRole("status")).toContainText("四种格式的挑战套件已全部下载");
    const select = page.getByRole("combobox", { name: "最近的挑战", exact: true });
    await expect(select.locator("option")).toHaveCount(4);
    for (const entry of entries.filter((e: any) => e.name.endsWith("/prompt.txt"))) {
      const prompt = entry.content.toString();
      const id = prompt.split("\n")[0].split(" ").at(-1);
      await select.selectOption(id);
      await expect(page.getByLabel("挑战提示词")).toHaveValue(prompt);
    }
    const single = page.waitForEvent("download");
    await page.getByRole("button", { name: "下载此套件", exact: true }).click();
    expect((await single).suggestedFilename()).toBe("mirror-decoder-kits.tar.gz");
  });
  test("GPT workshop builds format-aware prompts through the conversion API", async ({ page }) => {
    await page.getByRole("combobox", { name: "格式", exact: true }).selectOption("gptgif-v4");
    await page.getByPlaceholder("制作一个有三个房间和隐藏结局的简短互动冒险故事。").fill("a tiny constellation diary");
    await page.getByRole("button", { name: "让 GPT 按需求创作", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("创作需求已准备就绪");
    expect(conversionCalls).toHaveLength(1);
    expect(conversionCalls[0].format).toBe("gptgif-v4");
    expect(conversionCalls[0].filename).toBe("format-lab-brief.txt");
    expect(conversionCalls[0].dataBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(await page.getByLabel("挑战提示词").inputValue()).toContain("FORMAT API PROMPT for gptgif-v4");
  });
});
