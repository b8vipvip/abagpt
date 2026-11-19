import {test,expect} from "@playwright/test";
test.describe("browser / playground", () => {
test.beforeEach(async({page})=>{
 await page.route("**/v1/models",route=>route.fulfill({json:{data:[]}}));
 await page.route("**/api/conversations?*",route=>route.fulfill({json:{items:[],hasMore:false}}));
});
test("stream error is shown as Error",async({page})=>{
 await page.route("**/v1/chat/completions",route=>route.fulfill({contentType:"text/event-stream",body:'data: {"error":{"message":"Synthetic failure"}}\n\ndata: [DONE]\n\n'}));
 await page.goto("/mirror/playground");await page.getByRole("button",{name:/^运行请求/}).click();
 await expect(page.locator(".run-status")).toHaveText("出错");
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
 const specResponse = await page.request.get("/mirror/openapi");
 expect(specResponse.ok()).toBe(true);
 const spec = await specResponse.json();
 expect(spec.openapi).toBe("3.1.0");
 expect(spec.paths["/v1/chat/completions"].post.summary).toBe("创建聊天补全");
 expect(spec.paths["/v1/chat/completions"].post.requestBody).toBeDefined();
 await page.goto("/mirror/api-docs");
 await expect(page.locator(".swagger-ui")).toContainText("授权");
 await expect(page.locator(".swagger-ui")).toContainText("创建聊天补全");
});

});
