# API 对话续接回归——2026-09-07

用户确认：ChatGPTBox 在后续请求中不断创建新对话，而 cm 能够正确续接。在复现或修改应用行为之前，调查覆盖了所有自行维护的应用源码、测试、构建／维护脚本、部署配置和项目文档。生成的依赖元数据、vendored 依赖、构建输出和私有运行时数据不在源码审查范围内。

## 复现的问题

隔离的三轮 HTTP／协议探测使用真实响应文本作为下一次请求的 assistant history。整个过程没有使用生产凭证、真实消息或生产数据库。

| 输入／响应形态 | 修复前：三轮之后的对话数量 | 修复后 |
| --- | ---: | --- |
| 普通响应 | 1 | 1 |
| 响应长度超过 `max_tokens` 估算值 | 3 | 1，完整回答 |
| assistant 前言后又跟随另一条 assistant 消息 | 3 | 1，完整分段 |

修复前，两个失败用例的三次上游发送都没有包含 `conversation_id`，每次都使用 `client-created-root`。修复后，第二和第三次发送都保留了第一次上游返回的 ID，并分别使用 `answer-1` 和 `answer-2` 作为父节点。

## 原因与历史

`openai.ts` 保存的 transcript fingerprint 包含 `result.text`，也就是上游最终 assistant 文本。但 HTTP 响应可能不同：响应限制器会根据字符数估算值或 stop string 截断文本；流式偏移量还错误地跨越了多条独立的 assistant 消息。因此，客户端重新发送自己实际收到的回答时，提供的 transcript 与 Mirror 计算 fingerprint 时使用的内容不同。精确匹配失败后，路由便创建了新对话。

该限制器还会破坏多消息输出：前言 `Searching now. ` 后接 `Here is the complete answer 1`，最终可能变成 `Searching now. plete answer 1`。保留的字符偏移量错误地删除了下一条消息的开头。

Git 记录显示，限制器由提交 `47ddb204003df4489fd6a0128a13bcf5f43fd912`（2026-09-07）引入，而较早的 `result.text` fingerprint 逻辑仍被保留。后续的 `7d13162` Cowork completion 提交也保留了这些路径。共享 Git 作者身份无法证明具体由哪个 Agent 编写了某项变更。多消息流式输出与仅使用最终文本生成 fingerprint 之间的不匹配，即使没有截断也独立存在。

检查过的公开 ChatGPTBox 源码提交为 `ab221d2fc17219ae64c479560865005c2b16a361`。它会从已记录的问题／回答构建历史，拼接 response delta，并自动发送 response-token 字段（`src/services/apis/openai-compatible-core.mjs`）。这些证据支持上述客户端交互描述，但不能证明用户安装的扩展版本，也不能证明某次失败请求的确切内容。没有使用任何私有请求抓包。

已有测试分别覆盖简单续接和截断，但没有闭合“处理后的 HTTP 回答 → 后续两次请求”的完整链路。执行每个源码分支，并不足以证明这一契约。最初新增的测试矩阵在修改应用代码前，81 个用例中有 48 个失败。

## 修复

根据用户明确要求，已彻底移除响应限制器。为了兼容客户端，仍接受 `max_tokens`、`max_completion_tokens` 和 `stop`，但会忽略这些字段。Mirror 不再强加 Token／字符上限，也不再按 stop string 截断。成功响应会报告 `finish_reason: "stop"`。

流式处理现在会按 assistant message ID 跟踪快照，转发扩展内容而不重复已有文本，并用空行分隔新增／替换的片段。已经发送出去的字节无法撤回，因此替换快照会完整追加。捕获到的上游事件仍可独立获取。

已保存的逻辑 API assistant 行和 transcript fingerprint 现在都使用实际交付给客户端的精确响应。Local／upstream ID、父节点追踪、状态、事件和附件均保持完整。这样，重新加载和显式发送完整历史续接时就能与 API 调用方实际收到的内容保持一致。JSON 模式返回上游最终 assistant 文本；混合模式续接也有测试覆盖。

## 强制构建契约

服务端包的 `build` 脚本会在 TypeScript 编译完成后、生成 OpenAPI 之前，立即执行 `node --test tests/conversation-continuation.test.mjs`。根目录 build、start、CI 和 Docker 镜像构建都会调用该服务端 build。断言失败会以非零退出码终止命令。

最终矩阵包含 99 个用例，每个用例都完成三轮对话：

- 历史匹配、最小显式 ID 和完整历史显式 ID。
- 通过真实 loopback HTTP listener 测试 JSON、SSE 和混合传输。
- 即使提供 Token 限制和 stop 字段也必须返回完整输出；覆盖拆分的 stop string、多消息输出、替换／重复／删除快照、空回答和缺失状态。
- 稳定的本地／上游 ID、正确的前一条 assistant 父节点、每轮只发送一次上游请求、只创建一个本地对话且不产生意外分支、逻辑持久化历史、匹配的 fingerprint，以及保留的 instructions。

仅在一次性隔离源码副本中执行了两项故意破坏的变异：

| 变异 | 根构建退出码 | 续接断言报告创建了新对话的次数 |
| --- | ---: | ---: |
| 显式 ID 续接时省略已解析的对话 | 1 | 66 |
| 历史匹配续接时省略已解析的对话 | 1 | 33 |

两次构建都在强制续接测试阶段失败。负向检查没有修改生产源码。

## 验证结果与限制

- 最终续接契约：99 项通过，无跳过。
- 单元／集成测试套件：508 项通过；一个可选 cm 子进程测试因其原有平台门禁而跳过。
- C8：7,945／7,945 lines 和 statements；271／271 functions；2,068／2,068 branches。所有纳入的源码文件在四项指标上均达到 100%。
- Typecheck、生产构建和全部四项 Chromium 浏览器测试通过。
- 相同的原始三用例探测现在全部保留为一个对话，并返回未截断文本。

Compose 的 `mirror` 镜像已成功重建；Docker 构建也独立通过全部 99 项强制测试。只重新创建了 `mirror` 服务。运行中的 `http://127.0.0.1:8787` 返回 HTTP 200、`ok: true`，SQLite 已配置，且强制 WARP 验证通过。检查部署代码确认限制器已不存在，交付 transcript／逐消息流式处理修复已生效。本次验证没有执行实时 ChatGPT 生成。

## 用户报告修复未解决问题后发现的第二个原因（2026-09-07，当天稍晚）

上述修复真实且必要，但并不充分。用户报告应用该修复后，ChatGPTBox 仍然在每一轮都创建新对话。重新调查后，在同一文件中发现第二个独立 Bug，它通过不同机制产生相同症状。

`openai.ts` 中的 `sse()` 实施了慢消费者保护：如果某一次写入发生时 `reply.raw.writableLength`（Node 为被 hijack 的原始响应维护的出站缓冲积压量）超过 1MB，就调用 `reply.raw.destroy()` 并抛出异常，立即切断连接。这个检查会在每个 SSE 帧上运行，包括生成期间每 10 秒发送的心跳帧，而不只是轮次结束时。

关键问题在于执行顺序：`saveOpenAiTranscript()`——也就是记录下一轮续接匹配所依赖 fingerprint 的步骤——只有在 `runChat()` 返回后才会执行，也就是整轮 assistant 内容流式发送完毕之后。如果保护逻辑在流式发送期间（心跳或内容 delta）触发，抛出的异常会中止正在执行的 `withConversationLock` 回调，导致 transcript 保存步骤完全没有机会运行。外层 catch 看到 `reply.raw.destroyed === true` 后会提前返回，因此本轮内容完全不会持久化：既没有前一项修复生成的正确 fingerprint，也没有任何 fingerprint。下一次请求没有可匹配的记录，于是无论 fingerprint 文本本身是否正确，都会创建新对话。

ChatGPTBox 会通过 Chrome 扩展的 `runtime.Port` 中继每个 SSE chunk。与普通 socket 读取或进程内测试传输相比，这增加了一次延迟和缓冲行为都明显不同的中转。因此，`conversation-continuation.test.mjs` 的 99／99 通过并未捕获这个问题：它没有测试真正缓慢的 socket 消费者。对于较长响应，中继消费者可能在远端真正断开前就使缓冲积压超过 1MB；对这个特定客户端来说，这更接近日常情况，而不是极端边界。

### 修复

将基于单次字节数快照的检查，替换为基于持续阻塞时间的检查，并提高水位线：只有当 `writableLength` **连续超过 8MB 且持续 15 秒以上**时，才会触发保护（通过每个响应独立的 `WeakMap` 跟踪；积压降回阈值以下时立即重置）。预期中的中继突发流量现在可以正常写入，不会再被立即切断。真正已经失效、积压始终无法排空的连接，仍会被终止，但会等待真实阻塞窗口，而不是在第一次超过任意快照阈值时就杀掉连接。

这仍然不是完整的 drain 事件驱动背压（当 `write()` 返回 `false` 时暂停生产，并在 `'drain'` 事件后恢复）；调用点仍然是同步的。但它移除了实践中真正破坏续接的误判式断连。

`sse()` 增加了可选的 `now` 参数（默认 `Date.now()`），仅供单元测试确定性地推进阻塞时钟，不需要真实定时器或慢速 socket。

验证结果：`apps/server/tests/conversation-continuation.test.mjs` 仍为 99／99。完整测试套件（`npm run coverage`）为 417 项通过／1 项跳过（原有平台门禁控制的 cm 测试），所有纳入源码文件的 lines／statements／functions／branches 均为 100%。Typecheck 和生产构建均通过。
