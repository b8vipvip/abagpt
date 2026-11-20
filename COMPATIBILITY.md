# API 兼容性：Mirror 与官方 OpenAI API 的差异

Mirror 的 `/v1/chat/completions` 和 `/v1/models` 采用 OpenAI API 的请求/响应格式，但底层实际运行在 `chatgpt.com/backend-api` 上——这是 ChatGPT Web 应用背后的私有协议，并非官方文档所描述的 OpenAI API。这两套 API 的设计目的不同：一套是服务特定第一方客户端的产品后端，另一套是面向通用开发者的 API。因此，有些差异并不是需要修复的 Bug，而是两种产品接口在设计上本来就不一致。本文列出目前发现的双向差异，并说明哪些属于结构性限制，哪些只是尚未实现。

本文多处引用的 backend-api 底层机制见 [PROTOCOL.md](./PROTOCOL.md)。本文描述的 `/v1` 请求和响应结构也有机器可读版本：访问 `GET /mirror/openapi`（添加 `?format=yaml` 可获取 YAML），即可取得 OpenAPI 3.1 文档。该文档直接根据服务端用于校验请求的同一组 Zod Schema 生成，详见 `apps/server/src/openapi-document.ts`。你也可以访问 `/mirror/api-docs`，通过 Swagger UI 浏览并在线试用接口。

## 第一部分：Mirror 无法（或无法完整）提供的官方 OpenAI API 功能

### 结构上无法实现——backend-api 中不存在对应能力

**采样控制参数**（`temperature`、`top_p`、`frequency_penalty`、`presence_penalty`、`logit_bias`、`seed`）。ChatGPT Web 客户端不会向账号持有人开放这些参数，`f/conversation` 请求中也没有对应字段。因此没有可供调整的开关——模型使用 ChatGPT 产品团队为对应 model slug 在服务端配置的采样策略，而且该策略可能随时变化。

**确定性输出 / `seed`。** 原因相同：上游不存在 seed 参数；即使在不同会话之间，ChatGPT 自身的基础设施也不保证采样结果可复现。

**`logprobs` / `top_logprobs`。** backend-api 发送的 SSE 流面向界面渲染（助手文本增量、工具/引用/图片事件），从未包含逐 Token 概率，因为 ChatGPT UI 不需要这些数据。

**`n` > 1（每次请求返回多个候选结果）。** 一轮 ChatGPT 对话只会生成一条助手消息；Mirror 所代理的产品没有“给我 3 个补全结果”这一概念。Mirror 理论上可以向上游发起 `n` 次独立请求，但这会让一次调用消耗 `n` 倍 ChatGPT 用量，并在一个看似免费的 OpenAI API 字段背后悄悄放大成本和速率限制消耗。因此 Mirror 刻意不自动执行这种扇出。如果确实需要多个结果，请自行调用接口 `n` 次。

**工具/函数调用（OpenAI 的 `tools` / `tool_choice` 契约）。** 这是最大的结构性差异，而且是双向不匹配，并非简单缺少某个功能：

- OpenAI 函数调用允许你定义函数 Schema，让模型使用结构化参数请求调用，然后由你执行函数，并通过 `role: "tool"` 消息把结果发回。backend-api 没有这套契约：调用方无法向 ChatGPT 注册函数 Schema，其消息结构中也没有 `tool_calls` 字段。
- ChatGPT 确实会在服务端运行工具（网页浏览、Python/代码解释器沙箱、DALL-E 图片生成、“计算机使用”界面等），但这些都是 ChatGPT 自己内置、由产品控制的工具，完全在 OpenAI 基础设施内部调用。Mirror 的 SSE reducer（`packages/protocol/src/sse.ts`）会将它们整理成通用的 `{kind: "tool", name, status}` 事件用于展示，但 API 调用方无法定义新工具、在工具执行前拦截调用，或返回自定义结果。OpenAI `tools` API 所依赖的完整往返流程，在这个方向上并不存在。

Mirror 目前为 Chat Completions 函数工具提供了一个**实验性的文本桥接层**。请求中提供 `tools` 时，Mirror 会将工具定义和客户端完整对话记录作为一次性临时提示词发送给 ChatGPT，要求 ChatGPT 输出 JSON 形式的选择结果，然后校验所选函数名称和参数 JSON，并向客户端返回标准的 `tool_calls`，供客户端执行。客户端可以在下一次请求中通过 `role: "tool"` 发回执行结果。这是基于提示词的转换，并非上游原生支持：ChatGPT 可能返回格式错误的 JSON，也可能选择错误的参数；遇到这些情况时，Mirror 会返回错误，而不会凭空伪造工具调用。工具桥接请求使用临时聊天，不共享 Mirror 正常对话的续接状态。为了兼容客户端，Mirror 接受 `reasoning_effort` 和 `stream_options.include_usage`，但它们不会改变上游模型的推理行为，也不会产生 Token 用量统计。

**`response_format`（JSON 模式 / JSON Schema / 结构化输出）。** 上游没有对应请求字段，也没有可保证输出符合 Schema 的机制。ChatGPT 原始文本输出就是普通文本，无法要求它进行受 Schema 约束的解码。

**推理模型控制参数**（`reasoning_effort`、与 `max_tokens` 语义不同的 `max_completion_tokens`、加密推理内容等）。ChatGPT Web 客户端会根据 model slug 自行选择内部推理行为；调用方没有可用于提高或降低推理强度的控制开关。即使存在推理轨迹，`f/conversation` 也不会以 Mirror 能够重新暴露的形式返回这些数据。

**精确 Token 用量**（`usage.prompt_tokens` / `completion_tokens` / `total_tokens`）。backend-api 的响应封装中没有任何 Token 数量信息。ChatGPT 按订阅或套餐的用量窗口计费，而不是按 Token 计量，因此没有可读取的数据。Mirror 的补全响应始终返回 `usage: null`，不会使用一个可能与对应 model slug 实际分词方式不一致的 Tokenizer 伪造数字。

**完全没有 ChatGPT Web 对应能力的独立接口：** `/v1/embeddings`、`/v1/audio/*`（Whisper 转录、TTS）、独立的 `/v1/images/generations` 接口（与聊天中的 DALL-E 不同，见第二部分）、`/v1/moderations`、`/v1/fine_tuning/*`、`/v1/batches` 和 Assistants API。ChatGPT.com 的 Web 客户端根本不会调用这些接口，因此也就没有可供逆向分析的 backend-api 流量。

### 为兼容客户端而接受，但不会限制最终回答的参数

**`max_tokens`、`max_completion_tokens` 和 `stop`。** Mirror 接受这些字段，是因为 ChatGPTBox 等客户端会自动发送它们，但 Mirror 会忽略其值。系统不会估算 Token 数量、限制字符数、按停止字符串截断输出，也不会伪造 `length` 完成原因。响应会保留完整回答。生成过程仍可能失败或被取消；被中断的轮次不算成功完成。

**流式快照与对话续接。** backend-api 可能在一轮中发出多条助手消息，也可能替换某条消息的文本快照。由于已经发送给客户端的字节无法撤回，Mirror 会在每条消息内部追加增长的文本，并用空行分隔新消息或替换后的片段。API 保存的逻辑助手消息记录和对话记录指纹，使用的正是实际发送给客户端的文本。上游消息树和原始捕获事件仍会独立保留。JSON 补全响应会返回最终的上游助手文本。切换响应模式不会改变对话身份。

**文件输入与 MIME 分类。** Chat Completions 的最后一条用户消息可以包含 `file` 内容部分，包括图片文件。请提供原始的 `file.filename`，并通过 Data URI 或 HTTP(S) URL 在 `file.file_data` 中提供文件字节。服务端根据文件扩展名（不区分大小写）确定 MIME 类型；不会嗅探文件内容，也不会信任浏览器、Data URI 或远程响应中的 Content-Type 标签。Markdown 文件使用 `text/markdown`；扩展名未知或缺失时使用 `application/octet-stream`。原生 `/api/files` 接口遵循相同规则。没有文件名的 `image_url` 内容部分仍保留原有图片 MIME 处理方式。API 测试台会为所有上传文件使用带文件名的 `file` 内容部分，并且只允许在对话模式的最后一条用户消息中选择附件。Responses 输入目前仍仅支持文本。

### 并非结构上无法实现，只是尚未开发

**除 `image_url` 以外的音频/图片输入内容部分。** Mirror 已支持 `image_url`（包括 `data:` URI 和 `https://` URL，见 README），因为 backend-api 确实支持完整的图片附件流程，与真实 UI 使用的文件上传流程相同。音频输入目前还没有经过逆向分析的对应上传/附件路径，因此 Mirror 会拒绝这类输入，而不是静默丢弃。如果后续能够梳理出 ChatGPT 的音频输入流程，这一限制可能会改变。

**多个具有独立语义的 system/developer 消息。** Mirror 当前会将所有 `system` / `developer` 消息合并为一个指令块，再作为合成提示词上下文的一部分发送（见 `apps/server/src/openai.ts` 中的 `promptFor`），而不是将它们建模为可单独追踪的指令槽位。这是 Mirror 的实现简化，并非 backend-api 的限制。

## 第二部分：官方 OpenAI API 无法触及的 ChatGPT 专属能力

这些都是 Mirror 所代理产品的真实功能，但官方 OpenAI Chat Completions API 完全没有对应能力，因为该 API 从来就不是为了暴露某个特定终端用户产品的功能而设计的。各项能力的状态有所不同：有些目前已可通过 `/v1/chat/completions` 完整使用，有些只能通过代理 UI 或 Mirror 自己的非 OpenAI 兼容接口 `/api/chat` 使用，还有一些尚未通过 Mirror 暴露。下文会分别说明。

### ✅ 已通过 `/v1/chat/completions` 完整支持

**自定义 GPT 和 Projects（gizmos）。** `GET /v1/models` 会将它们列为伪模型（GPT 的 ID 类似 `g-<hex>`，Project 的 ID 类似 `g-p-<hex>`）。只需将对应 ID 作为 `model` 参数传入即可对话。服务端的 `apps/server/src/openai.ts` 中的 `routeModel` 会处理路由，包括通过 `metadata.mirror_model` 使用 Project 自己选定的模型。这是一个真实可用、但 OpenAI API 中没有对应概念的 Mirror 功能。自定义 GPT/Projects 是 ChatGPT 产品概念：它们将指令、文件和工具配置组合成一个带 ID 的对象，而通用 API 根本没有对这种对象建模，因此不存在可以直接套用的“OpenAI 兼容”结构。Mirror 必须自行定义 `model: "g-..."` 这一约定。

**临时/隐身对话。** `metadata.private` 对应 backend-api 中真实可用的“不要保存到历史记录，也不要用于训练”模式，目前已完整接入 `/v1/chat/completions`。普通 OpenAI API 完全没有这一概念，因为它本身并不绑定持久化聊天历史。

### 🟡 Mirror 界面可见，并已部分暴露到 `/v1/chat/completions`

**内置网页浏览**和**Python/代码解释器沙箱**。普通 ChatGPT 可以在对话过程中搜索/浏览实时网页并运行 Python；普通 OpenAI Chat Completions API 没有任何一项功能与之对应（网页浏览仅存在于 ChatGPT 产品本身，以及另外一套 Responses API 托管工具中）。现在，`/v1/chat/completions` 会通过结构化数据重新暴露“本轮运行过哪些工具”：响应中的 `metadata.mirror_tool_events` 是一个 JSON 字符串化数组，包含本轮观察到的每次内置工具调用对应的 `{name, status}` 对象（使用 `JSON.parse` 解析）。这仅供信息展示；仍然无法定义新工具、在调用执行前拦截调用，或返回自定义结果。OpenAI `tools` 契约所依赖的完整往返流程在这个方向上仍不存在（见第一部分）。

**聊天中的图片生成和生成文件。** Chat Completions 和 Responses 会直接在助手文本中放入预览和文件链接，因此 ChatGPTBox 等 Markdown 客户端无需解析 `mirror_*` 元数据。图片预览使用 `![filename](<data:image/png;base64,...>)`；文件链接使用 `下载文件：[filename](<http://127.0.0.1:PORT/api/asset-content?ticket=...&download=1>)`（链接会使用发起请求的 Mirror 来源地址和实际 MIME 类型）。文件名取自上游元数据或沙箱路径，并会针对 Markdown 进行转义。普通响应文本和最终对话续接内容都会保留。

ChatGPT 的签名 Estuary URL 仍然需要身份验证。Mirror 会通过已保存的上游会话获取预览字节并将其嵌入响应，因为在 Local Network Access 策略下，Google 搜索页面可能会阻止对本地回环服务器发起单独请求。每张图片的预览读取上限为 25 MiB；如果无法读取预览或预览超过该限制，响应会保留原始文件下载链接，而不会输出损坏的图片。下载操作会直接流式传输原始字节，不受预览大小限制。`metadata.mirror_images` 包含可用的预览 URL；读取失败的预览会被省略。

每个下载链接都包含一个加密的、限定到单个文件的 ticket，不包含 Mirror API Key 或 ChatGPT 凭证。任何持有该链接且能够访问 Mirror 实例的人，都可以在原始保存会话仍保持连接期间，于七天内读取对应的单个文件。重新连接或删除已保存会话会使链接失效。每次请求时，路由都会重新解析上游元数据；只有访问精确的 ChatGPT Estuary 端点时才会使用身份验证，并会发送带文件名的 `Content-Disposition: attachment` 请求头。浏览器会按常规下载行为处理文件。ChatGPTBox 中已经保存的旧回复不会被改写；更新 Mirror 后，请重新请求新的文件链接。上游文件本身也可能独立过期。

可选的渲染器验证：在 ChatGPTBox 源码检出目录中安装依赖后，构建 Mirror，再运行 `CHATGPTBOX_SOURCE=/path/to/chatGPTBox node scripts/check-chatgptbox-assets.mjs`。该脚本会在 Chromium 中运行检出版本的真实 Markdown 和 Hyperlink 组件，并使用受控的 HTTPS 搜索页测试夹具，检查解码后的图片尺寸、点击的文件名和下载内容。这是一项使用模拟上游的源码渲染器集成测试，并不代表某个已安装的个人浏览器扩展一定正常。

**将对话分支、编辑和重新生成为真实消息树。** ChatGPT 对话是由消息节点组成的有向无环图（DAG），其中存在一条“当前”路径（编辑任意一条用户消息都会创建新分支；重新生成则会在助手侧创建新分支）。Mirror 会在自己的对话存储，以及代理 UI 的编辑/重新生成流程中忠实地建模这一行为（见 `store.ts` 的 rebase 逻辑）。但官方 Chat Completions API 每次调用都是无状态的，完全没有可分支历史的概念，因此不存在可用于表达“分支”或“重新生成”的 OpenAI 风格请求字段。`/v1/chat/completions` 只能通过重新发送编辑后的历史记录，并附带已跟踪的 `metadata.conversation_id`，间接实现这一行为。

### ❌ Mirror 目前尚未暴露

**Memory（记忆）。** ChatGPT 跨对话持久记忆功能在无状态的 Chat Completions API 中没有对应能力，目前 Mirror 也没有以任何形式提供该功能。

**ChatGPT UI 中的连接器（Drive、Gmail、日历等）。** 这些连接器允许 ChatGPT 在对话过程中读取或操作用户已连接的账号。它们可以在 Mirror 于根路径 `/` 提供的真实 ChatGPT 代理界面中看到，但 Mirror 目前不会拦截或通过 OpenAI 兼容 API 重新暴露连接器驱动的行为。

**Canvas、Tasks/定时提醒和语音模式。** 这些都是拥有独立上游端点和交互模型的真实 ChatGPT 产品功能，与 `messages` 数组没有对应关系。目前它们都没有接入 `/v1/chat/completions`；其中部分功能（例如语音）在结构上可能根本无法桥接为文本补全格式。

## “完全兼容”意味着什么

对于当前这组接口而言，“完全兼容 OpenAI”并不是一个能够真正达到的终点。第一部分中的某些差异是由结构决定的永久限制（上游根本没有可供调整的开关）；第二部分中的某些差异则属于 ChatGPT 产品功能，无论逆向分析出多少 backend-api 机制，OpenAI API 格式都没有字段可以表达它们。现实可行的目标是：在 backend-api 实际能力允许的范围内，尽可能匹配官方请求/响应**结构**；对于不支持的字段，应立即明确报错，而不是静默忽略（这已经是 Mirror 当前的策略，见 `apps/server/src/openai.ts` 中严格的 Zod Schema）；并随着 backend-api 被进一步梳理，或 OpenAI 自身 API 发生变化，持续更新本文档。

## Responses API 文本子集

`POST /v1/responses` 会将文本生成适配为 Responses 请求/输出格式。它与 Chat Completions 共用同一套引擎、持久化、账号检查、不可变助手历史记录、取消机制、截止时间控制和 WARP 出站网络。

- `input`：可以是字符串，也可以是包含 `system`、`developer`、`user` 或 `assistant` 角色的消息数组。内容可以是字符串，也可以是 `input_text` / `output_text` 部分。返回的助手消息项可以包含在后续请求的输入历史中。
- `instructions`：可选的系统指令。支持 `model`、`stream`、`store` 和 Mirror 的 `metadata` 路由字段。`max_output_tokens` 会被接受但忽略，以确保回答保持完整。
- JSON 响应会返回一个 `response` 对象，其中 `output` 包含已完成的助手消息，内容部分为 `output_text`。Token `usage` 为 null。
- 流式响应会发出命名事件：`response.created`、`response.in_progress`、output-item/content-part 生命周期事件、`response.output_text.delta` 和 `response.completed`。失败时会发出 `response.failed`；不得将被截断的流视为成功。每十秒发送一次空文本增量，以保持静默连接处于活动状态。该接口没有 Chat Completions 的 `[DONE]` 标记。
- 可以通过返回的 `metadata.conversation_id`（JSON 响应头中也会包含该值）继续对话，或者重新发送完整输入历史。Response ID 标识单次结果，不是对话 ID。`previous_response_id` 以及 GET/检索/删除 response 的端点尚未实现。
- 与 Chat 模式相同，Mirror 的 `store:false` 表示一次性请求，不可续接，并且不会返回续接 ID。这与 OpenAI 的 response 对象存储语义不同；Mirror 不会存储可供之后检索的 response 对象。
- 工具/函数调用、图片/文件/音频、结构化输出、后台模式以及其他不支持的请求字段都会返回 HTTP 400，而不是被静默忽略。

```json
{
  "model": "auto",
  "input": "请用一句话打个招呼。",
  "stream": true
}
```

API 测试台侧边栏中的 **Responses** 项会直接调用此端点。它的消息编辑器发送的是 `input`，而不是 Chat Completions 的 `messages`；“输出”和“原始响应”视图分别显示文本和 Responses 载荷。

### 自定义 GPT 或 Project 的第一轮响应

对于一个新的自定义 GPT（`g-…`）或 Project（`g-p-…`）对话，在上游第一轮中，Mirror 会像后续轮次一样显示助手回答、Python 工具输出（`python` 和 `python_user_visible`，包括带命名空间的变体），以及模型可以直接响应用户当前请求而调用的其他所有工具：图片生成（`image_gen` / `dalle` / `dalle.text2im`）、网页浏览/搜索（`browser` / `web`）、Canvas（`canmore`）和视频/Sora（`sora` / `video_gen`）。内部思维链（原始 `analysis` 通道）始终隐藏；可能显示的、单独记录的推理摘要请参阅下文“思维链 / 推理”一节。

**仅在第一轮仍会被排除的内容：** `file_search` / `myfiles_browser` 的结果和状态卡片（模型开始回答前，系统自动检索 GPT/Project 附加知识文件的后台过程），以及通用系统/UI 框架内容（developer/system 内容、`computer_initialize_state` / `computer_output`、“commentary”思考前言等）。只有在这些隐藏事件中发现的附件不会被追加或解析；而回答、Python 输出以及上述其他用户主动调用的工具中的附件仍可正常工作。原始事件仍保存在本地存储中，并带有显示可见性标记。此规则同时适用于 Chat Completions 和 Responses、流式和 JSON 响应，以及 Mirror 原生聊天事件流。现有上游对话的后续轮次和普通模型聊天从未受此规则影响（它们不受第一轮门控）。代理的 ChatGPT 网站仍继续使用 ChatGPT 自己的渲染方式。

#### 实时验收清单

使用一个新的、可随时丢弃的对话，并选择带有知识文件且启用了 Python 的自定义 GPT 或 Project。记录日期、Mirror commit、客户端名称和版本、base URL、流式模式、所选 GPT/Project，以及请求使用的是 Chat Completions 还是 Responses。不要记录凭证、Cookie、Authorization 请求头、签名资源 URL 或私人文件内容。

1. 开始新对话，提出一个同时需要使用附加知识文件和简单可见 Python 计算的问题。第一轮响应必须包含正常的助手回答以及 Python 代码/输出；不得包含 `file_search` / `myfiles_browser` 结果或状态、通用系统框架内容、commentary 前言或原始 `analysis` 内容。
2. 确认用户要求的网页、图片、Canvas 或视频输出仍然可见。确认最终回答中有意包含的引用和文件仍可正常渲染；隐藏的检索事件不得产生多余资源。
3. 在同一对话中发送后续消息。确认返回的 conversation ID 未变化，回答使用了第一轮上下文，而且普通后续轮次的工具输出不会被错误套用第一轮专属的抑制规则。
4. 在另一种响应模式（流式与 JSON 之间）再重复一次。如果两类 API 都属于发布范围，也应通过另一类 API 再重复一次。
5. 只保存经过脱敏的通过/失败记录。将该结果标记为已安装客户端和实时上游证据；合成测试套件与 Chromium API 测试台测试属于独立的证据层。

### 思维链 / 推理

有文档记录的推理摘要会通过 `/v1/chat/completions` 和 `/v1/responses` 的 `metadata` 暴露（不会添加非标准的顶层响应字段，见本文前述约定）：`metadata.mirror_reasoning_summaries` 是 ChatGPT 自己生成的事后精简回顾（`reasoning_recap` / `summary` 内容类型），也就是“思考了 X 秒”下拉区域中的文本。它是一个 JSON 字符串化数组，包含 `{messageId, text}` 对象；只有当该轮确实生成了显式展示摘要时才会出现。内部 `analysis` 通道内容绝不会发布。摘要会在每轮结束时一次性定稿，与 Mirror 对其他富内容（工具输出、图片）的处理方式一致：在轮次完成时定稿，而不是逐步增量发布。
