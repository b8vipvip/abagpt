# backend-api 协议笔记

本文根据真实捕获的 chatgpt.com 浏览器流量整理（分析过程已脱敏——从未将 Token/Cookie 的实际值作为明文检查，只分析了端点路径、请求头名称和 JSON 结构）。这些记录是构建 `packages/protocol` 的事实依据。

## 已观察到的完整端点范围（均位于 `/backend-api/` 下）

**GET：** `accounts/check/v4-2023-04-27`、`accounts/optimized/check`、`aip/first-party/eligibility`、`amphora/notifications`、`apps/sources_dropdown`、`beacons/home`、`calpico/chatgpt/rooms/summary`、`celsius/ws/user`、`checkout_pricing_config/configs/{cc}`、`client/strings`、`composer/items`、`conversation/{id}/stream_status`、`conversation/{id}/textdocs`、`conversations`、`estuary/content`、`estuary/public_content/enc/{...}`、`gizmos/bootstrap`、`gizmos/{gizmo_id}[/conversations]`、`gizmos/snorlax/sidebar`、`hazelnuts`、`images/bootstrap`、`me`、`models`、`models/gpts`、`pageConfigs/billing`、`pins`、`prompt_library/`、`sentinel/frame.html`、`sentinel/sdk.js`、`settings/is_adult`、`settings/user`、`settings/voices`、`subscriptions`、`system_hints`、`tasks`、`tpp/models/`、`user_granular_consent`、`user_surveys/active`、`user_system_messages`。

**POST：** `accounts/backfill_workspace_owner_domains`、`aip/connectors/links/list_accessible`、`composer/items/interactions`、`conversation/init`、`f/conversation`、`f/conversation/prepare`、`lat/r`、`sentinel/chat-requirements/finalize`、`sentinel/chat-requirements/prepare`、`sentinel/heartbeat`、`sentinel/ping`、`sentinel/req`。

当前实现使用了 `conversation/init`、两阶段 `f/conversation/prepare` conduit 流程、`f/conversation`、`sentinel/*` 系列端点、实时模型列表、gizmo 发现/获取接口，以及文件创建/上传/下载路由。

## 常见请求头（每次 backend-api 调用都会使用）

`accept`、`accept-encoding`、`accept-language`、`authorization`（Bearer accessToken）、`content-type`、`cookie`（目前尚不确定是否必须与 Bearer 同时提供）、`dnt`、`oai-client-build-number`、`oai-client-version`、`oai-device-id`（客户端生成并持久化的 UUID）、`oai-language`、`oai-session-id`、`origin`、`referer`、`sec-ch-ua*`、`sec-fetch-*`、`user-agent`、`x-oai-is-client-observation`、`x-openai-target-path`、`x-openai-target-route`。聊天请求还会附加 `chatgpt-account-id`。

## 对话流程

1. **POST /backend-api/conversation/init** —— 请求体为 `{requested_default_model, conversation_id: null, timezone, timezone_offset_min, conversation_origin: null}`（自定义 GPT 还会附加 `gizmo_id`）。响应包含 `default_model_slug`、`limits_progress` 和 `blocked_features`。
2. **POST /backend-api/f/conversation/prepare** —— 防抖的预检步骤。响应为 `{status:"ok", conduit_token}`。
3. **Sentinel 工作量证明 / Turnstile 门禁：**
   - `POST sentinel/chat-requirements/prepare` → `{persona, prepare_token, turnstile:{required,dx}, proofofwork:{required,seed,difficulty}, so:{...}}`
   - 计算工作量证明（SHA3-512 hashcash，参见 `packages/protocol/src/proof.ts`；该实现移植自经过测试的参考实现）。
   - **Turnstile 处理：** 调用方可以为一次生成请求提供一个新鲜的响应 Token。保存在本地会话中的待用 Token 会被原子性地领取，仅用于这次 Sentinel finalize 调用，绝不会重复使用。注入的 resolver 也可以为同一次握手提供 Token；如果没有提供，Mirror 会回退到使用当前会话上下文的 Playwright/Chromium 浏览器求解器。如果不需要 Token 或没有可用 Token，Mirror 会发送 `turnstile: null`，使不受限制的会话仍可正常工作。
   - `POST sentinel/chat-requirements/finalize` → `{persona, token, expire_after, expire_at}`。其中 `token` 会成为 `openai-sentinel-chat-requirements-token`。
4. **POST /backend-api/f/conversation** —— 实际发送消息。额外请求头包括：`chatgpt-account-id`、`oai-echo-logs`、`oai-genui-client-actions`、`oai-telemetry`、`openai-sentinel-chat-requirements-token`、`openai-sentinel-proof-token`、`x-oai-turn-trace-id`。

   最终的 conduit Token 通过 `x-conduit-token` 发送。prepare 端点的兼容性故障会回退一个阶段（或不使用 conduit）；认证和速率限制错误仍然会被视为致命错误。

   **响应格式为 SSE。** 第一行字面值为 `"v1"`，随后是 JSON Patch 风格的事件 `{p, o, v, c}`。

   **最关键的注意事项：** 后续事件经常会省略 `p`/`o`，只发送 `{"v": "..."}`，表示“沿用上一条事件的 path 和 op”。如果客户端假定每条事件都包含完整描述信息，就会静默丢弃大部分流式文本。`packages/protocol/src/sse.ts` 中的 `ConversationStreamReducer` 会正确追踪这部分状态。另有批量形式：`{"p":"","o":"patch","v":[{...},{...}]}`。非 patch 类型事件（`resume_conversation_token`、`input_message`、`title_generation`、`message_marker`）会穿插在流中，文本渲染路径应忽略它们。流以 `data: [DONE]` 结束。

## 实时观察到的模型 slug

`gpt-5-6-thinking`、`gpt-5-6`、`gpt-5-3` —— 应通过 `GET /backend-api/models` 实时获取，而不是硬编码；可用模型取决于账号和套餐。

## 兼容性边界

- Bearer-only 与 Bearer+Cookie 两种认证要求尚未确认（这会影响“只粘贴 Token”的认证体验）。
- 浏览器求解器回退方案已经实现，并通过合成测试覆盖；是否能被需要实时挑战的 ChatGPT 会话接受，仍需单独进行真实环境验证。
- 精确的类型化事件封装仍在持续变化。Mirror 会在内部保留原始规范化事件，并从中派生稳定的文本/工具/引用/图片视图。
- 未知的 OpenAI 兼容历史记录无法重建既有的 ChatGPT 消息树。新的 Mirror 对话会将收到的历史记录作为显式文本上下文；后续调用可以通过显式的 `metadata.conversation_id` 或匹配的已存储对话记录指纹继续对话。Work Mode 别名会被拒绝，不会被重新映射。
