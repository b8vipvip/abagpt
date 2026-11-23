import {test,expect} from "@playwright/test";

const serverBase = "http://127.0.0.1:8787";
test.describe("browser / playground", () => {
test.beforeEach(async({page})=>{
 await page.route("**/v1/models",route=>route.fulfill({json:{data:[]}}));
 await page.route("**/api/conversations?*",route=>route.fulfill({json:{items:[],hasMore:false}}));
});
test("stream error is shown as Error",async({page})=>{
 await page.route("**/v1/chat/completions",route=>route.fulfill({contentType:"text/event-stream",body:'data: {"error":{"message":"Synthetic failure"}}\n\ndata: [DONE]\n\n'}));
 await page.goto("/mirror/playground");await page.getByRole("button",{name:/^运行请求/}).click();
 await expect(page.locator(".run-status")).toHaveText("出错");
 await expect(page.locator(".output")).toContainText("请求失败，请检查服务器地址、API 密钥和 ChatGPT 会话后重试。");
 await page.getByRole("button", { name: /原始响应/ }).click();
 await expect(page.locator(".output")).toContainText("Synthetic failure");
});
test("legacy ID without history is not reused",async({page})=>{
 await page.goto("/mirror/playground");await page.evaluate(()=>localStorage.setItem("mirror-playground-conversation-id","stale-id"));await page.reload();
 await expect(page.getByPlaceholder("自动生成（首次响应后填入）")).toHaveValue("");
});
test("pagination loads more when remote history remains",async({page})=>{
 let calls=0;
 await page.route("**/api/conversations?*",route=>{calls++;const offset=Number(new URL(route.request().url()).searchParams.get("offset"));return route.fulfill({json:{items:Array.from({length:50},(_,i)=>({id:String(offset+i),title:`Chat ${offset+i}`,updatedAt:"2026-01-01"})),hasMore:offset===0}});});
 await page.goto("/mirror/playground");await expect(page.locator(".conversation-list-item")).toHaveCount(50);
 await page.locator(".conversation-list").evaluate(el=>{el.scrollTop=el.scrollHeight;});
 await expect(page.locator(".conversation-list-item")).toHaveCount(100);expect(calls).toBeGreaterThan(1);
});
test("Stop cancels a pending response",async({page})=>{
 await page.route("**/v1/chat/completions",async route=>{await new Promise(resolve=>setTimeout(resolve,1000));await route.abort().catch(()=>{});});
 await page.goto("/mirror/playground");await page.getByRole("button",{name:/^运行请求/}).click();await page.getByRole("button",{name:"停止",exact:true}).click();await expect(page.locator(".run-status")).toHaveText("已停止");
});
test("Responses mode runs, retains history and switches back to Chat", async ({page}) => {
 let request: any;
 await page.route("**/v1/responses", route => {
  request = route.request().postDataJSON();
  const response = {status:"completed",metadata:{conversation_id:"responses-conversation"},output:[{type:"message",role:"assistant",content:[{type:"output_text",text:"Hello from Responses"}]}]};
  return route.fulfill({contentType:"text/event-stream",body:`event: response.output_text.delta\ndata: ${JSON.stringify({type:"response.output_text.delta",delta:"Hello from Responses"})}\n\nevent: response.completed\ndata: ${JSON.stringify({type:"response.completed",response})}\n\n`});
 });
 await page.goto("/mirror/playground");
 await page.getByRole("button",{name:"◇ Responses API（响应接口）"}).click();
 await expect(page.getByRole("heading",{name:"Responses API（响应接口）",exact:true})).toBeVisible();
 await expect(page.getByLabel("接口路径",{exact:true})).toHaveValue("/v1/responses");
 await page.getByRole("button",{name:/^运行请求/}).click();
 await expect(page.locator(".run-status")).toHaveText("已完成");
 expect(request.input.at(-1).role).toBe("user"); expect(request.messages).toBeUndefined();
 await expect(page.getByPlaceholder("自动生成（首次响应后填入）")).toHaveValue("responses-conversation");
 await expect(page.locator(".output")).toContainText("Hello from Responses");
 await page.getByRole("button",{name:"☷ 对话"}).click();
 await expect(page.getByLabel("接口路径",{exact:true})).toHaveValue("/v1/chat/completions");
 await expect(page.getByPlaceholder("自动生成（首次响应后填入）")).toHaveValue("responses-conversation");
});
test("Markdown and text files selected together keep their exact contents and the latest prompt", async ({ page }) => {
 let request: any;
 await page.addInitScript(() => {
  const read = FileReader.prototype.readAsDataURL;
  const pending: Array<() => void> = [];
  FileReader.prototype.readAsDataURL = function(file) { pending.push(() => read.call(this, file)); };
  (window as any).releaseUploads = () => pending.splice(0).forEach(start => start());
 });
 await page.route("**/v1/chat/completions", route => {
  request = route.request().postDataJSON();
  return route.fulfill({ contentType: "text/event-stream", body: 'data: {"choices":[{"delta":{"content":"Received"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n' });
 });
 await page.goto("/mirror/playground");
 await page.locator("textarea").last().fill("Read both attachments.");
 await page.locator('input[type="file"]').last().setInputFiles([
  { name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# Notes\n\nUnique contents: café 🐈\n") },
  { name: "other.txt", mimeType: "text/plain", buffer: Buffer.from("Second file contents\n") },
 ]);
 await expect(page.locator(".run-status")).toHaveText("正在读取文件…");
 await expect(page.getByRole("button", { name: /^运行请求/ })).toBeDisabled();
 await page.keyboard.press("Control+Enter");
 expect(request).toBeUndefined();
 await page.evaluate(() => (window as any).releaseUploads());
 await expect(page.locator(".attachment-chip")).toHaveCount(2);
 await page.locator("textarea").last().fill("Read both attachments, including Unicode.");
 await page.getByRole("button", { name: /^运行请求/ }).click();
 await expect(page.locator(".run-status")).toHaveText("已完成");
 const parts = request.messages.at(-1).content;
 expect(parts[0]).toEqual({ type: "text", text: "Read both attachments, including Unicode." });
 expect(parts.slice(1).map((part: any) => [part.file.filename, Buffer.from(part.file.file_data.split(",")[1], "base64").toString()])).toEqual([
  ["notes.md", "# Notes\n\nUnique contents: café 🐈\n"], ["other.txt", "Second file contents\n"],
 ]);
});
});

test.describe("browser / localized interface", () => {
test("mobile navigation remains available without horizontal page overflow", async ({ page }) => {
 await page.setViewportSize({ width: 390, height: 844 });
 await page.goto("/mirror/playground");
 await expect(page.getByRole("link", { name: "API 文档" })).toBeVisible();
 await expect(page.getByRole("link", { name: "OpenAPI 规范" })).toBeVisible();
 const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
 expect(hasHorizontalOverflow).toBe(false);
});
test("API documentation is localized without changing the OpenAPI contract", async ({ page }) => {
 await page.goto(`${serverBase}/mirror/playground`);
 const specResponse = await page.request.get(`${serverBase}/mirror/openapi`);
 expect(specResponse.ok()).toBe(true);
 const spec = await specResponse.json();
 expect(spec.openapi).toBe("3.1.0");
 expect(spec.paths["/v1/chat/completions"].post.summary).toBe("创建聊天补全");
 const documentationCopy: string[] = [];
 const collectDocumentationCopy = (value: any): void => {
  if (Array.isArray(value)) { for (const item of value) collectDocumentationCopy(item); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
   if ((key === "summary" || key === "description") && typeof child === "string") documentationCopy.push(child);
   else if (key === "tags" && Array.isArray(child)) documentationCopy.push(...child.filter((tag): tag is string => typeof tag === "string"));
   else collectDocumentationCopy(child);
  }
 };
 collectDocumentationCopy(spec);
 expect(documentationCopy.length).toBeGreaterThan(0);
 for (const copy of documentationCopy) expect(copy).toMatch(/[\u3400-\u9fff]/);
 expect(spec.paths["/v1/chat/completions"].post.requestBody).toBeDefined();
 const requestSchema = spec.components.schemas.CompletionRequest;
 expect(requestSchema.properties.max_tokens).toBeDefined();
 expect(requestSchema.properties.metadata).toBeDefined();
 expect(requestSchema.properties.messages).toBeDefined();
 await page.goto(`${serverBase}/mirror/api-docs`);
 await expect(page.locator(".swagger-ui.swagger-container")).toContainText("授权");
 await expect(page.locator(".swagger-ui.swagger-container")).toContainText("创建聊天补全");
 await page.locator(".opblock-summary").filter({ hasText: "创建聊天补全" }).first().click();
 await expect(page.locator(".swagger-ui.swagger-container")).toContainText("请求参数");
 await expect(page.locator(".swagger-ui.swagger-container")).toContainText("请求体");
 await expect(page.locator(".swagger-ui.swagger-container")).toContainText("试用");
});
test("Swagger authorization and live API error states stay localized", async ({ page }) => {
 await page.goto(`${serverBase}/mirror/playground`);
 await page.goto(`${serverBase}/mirror/api-docs`);
 const authorizeButton = page.locator(".swagger-ui .auth-wrapper .authorize");
 await expect(authorizeButton).toHaveText("授权");
 await authorizeButton.click();
 const authDialog = page.locator(".swagger-ui .dialog-ux");
 await expect(authDialog).toBeVisible();
 await expect(authDialog).toContainText("可用的身份验证方式");
 await expect(authDialog).toContainText("授权");
 await authDialog.locator(".btn-done").click();
 await expect(authDialog).not.toBeVisible();

 const modelsBlock = page.locator(".swagger-ui .opblock").filter({ hasText: "列出可用模型" }).first();
 await modelsBlock.locator(".opblock-summary").click();
 await modelsBlock.locator(".try-out__btn").click();
 await expect(modelsBlock.locator(".try-out__btn")).toHaveText("取消");
 await modelsBlock.locator(".execute").click();
 await expect(modelsBlock.getByRole("cell", { name: "401", exact: true }).first()).toHaveText("401");
 await expect(modelsBlock).toContainText("服务器响应");
 await expect(modelsBlock).toContainText("请配置有效的 Mirror API 密钥");
 await expect(modelsBlock).toContainText("错误：未授权");
 await expect(modelsBlock).toContainText("下载");
 await expect(modelsBlock).toContainText("媒体类型");
 await expect(modelsBlock).not.toContainText("Error: Unauthorized");
 await expect(modelsBlock).not.toContainText("Download");
 await expect(modelsBlock).not.toContainText("Media type");
 await expect(modelsBlock).not.toContainText("Controls");
 await expect(modelsBlock).not.toContainText("header.");
 await expect(modelsBlock.locator('button[aria-label="授权状态：未锁定"]')).toBeVisible();
 await expect(modelsBlock.getByRole("button", { name: "接口详情：GET /v1/models" })).toBeVisible();
});

test("Swagger dynamic labels and less common HTTP errors stay localized", async ({ page }) => {
 await page.goto(`${serverBase}/mirror/playground`);
 await page.goto(`${serverBase}/mirror/api-docs`);
 await expect(page.locator(".swagger-ui.swagger-container")).toBeVisible();
 const probes: Array<[string, string]> = [
  ["Error: Conflict", "错误：请求冲突"],
  ["Error: Request Timeout", "错误：请求超时"],
  ["Error: Gone", "错误：资源已失效"],
  ["Error: Request Entity Too Large", "错误：请求实体过大"],
  ["Error: Payload Too Large", "错误：请求内容过大"],
  ["Error: Unsupported Media Type", "错误：不支持的媒体类型"],
  ["Error: Misdirected Request", "错误：请求主机名未获信任"],
  ["Error: Unprocessable Entity", "错误：输入内容无法处理"],
  ["Error: Precondition Required", "错误：需要完成前置验证"],
  ["Error: Too Many Requests", "错误：请求过于频繁"],
  ["Error: Request Header Fields Too Large", "错误：请求标头过大"],
  ["Request Method", "请求方法"],
  ["Request Headers", "请求标头"],
  ["Status Code", "状态码"],
  ["Allowed values", "可选值"],
  ["Enum", "枚举"],
  ["Enum values", "枚举值"],
  ["Read Only", "只读"],
  ["Write Only", "仅写"],
  ["Nullable", "可为空"],
  ["No request body", "没有请求体"],
  ["No response body", "没有响应内容"],
  ["No properties", "没有属性"],
  ["Properties", "属性"],
  ["Property", "属性"],
 ];
 await page.evaluate((items) => {
  const root = document.querySelector(".swagger-ui");
  if (!root) throw new Error("Swagger UI root missing");
  for (const [source] of items) {
   const node = document.createElement("div");
   node.className = "localization-probe";
   node.textContent = source;
   root.appendChild(node);
  }
  const input = document.createElement("input");
  input.className = "localization-attribute-probe";
  input.setAttribute("placeholder", "Enter API key");
  input.setAttribute("aria-label", "Request Method");
  input.setAttribute("title", "Status Code");
  root.appendChild(input);
 }, probes);
 const nodes = page.locator(".swagger-ui .localization-probe");
 await expect(nodes).toHaveCount(probes.length);
 for (let i = 0; i < probes.length; i++) {
  await expect(nodes.nth(i)).toHaveText(probes[i][1]);
 }
 const input = page.locator(".swagger-ui .localization-attribute-probe");
 await expect(input).toHaveAttribute("placeholder", "输入 API 密钥");
 await expect(input).toHaveAttribute("aria-label", "请求方法");
 await expect(input).toHaveAttribute("title", "状态码");
});
test("command palette keeps dynamic empty and network-error states localized", async ({ page }) => {
 await page.route("**/v1/models", route => route.fulfill({ json: { data: [] } }));
 await page.route("**/api/conversations?*", route => route.fulfill({ json: { items: [], hasMore: false } }));
 await page.route("**/api/conversations/search?*", route => {
  const query = new URL(route.request().url()).searchParams.get("q");
  return query === "断网" ? route.abort() : route.fulfill({ json: { items: [] } });
 });
 await page.goto("/mirror/playground");
 await expect(page.locator(".playground-app")).toBeVisible();
 await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true })));
 const palette = page.getByRole("dialog", { name: "快速搜索并打开会话" });
 await expect(palette).toBeVisible();
 await palette.getByRole("textbox").fill("不存在");
 await expect(palette.getByRole("status")).toHaveText("没有找到匹配的会话");
 await palette.getByRole("textbox").fill("断网");
 await expect(palette.getByRole("status")).toHaveText("网络连接失败，请检查服务器地址和网络后重试。");
 await page.keyboard.press("Escape");
 await expect(palette).not.toBeVisible();
});

test("mobile API documentation stays readable without horizontal page overflow", async ({ page }) => {
 await page.setViewportSize({ width: 390, height: 844 });
 await page.goto(`${serverBase}/mirror/playground`);
 await page.goto(`${serverBase}/mirror/api-docs`);
 await expect(page.locator(".swagger-ui.swagger-container")).toBeVisible();
 await expect(page.locator(".swagger-ui.swagger-container")).toContainText("创建聊天补全");
 const hasHorizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
 expect(hasHorizontalOverflow).toBe(false);
});

});
