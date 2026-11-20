# Mirror 待办事项

本清单于 2026-09-14 审查，范围包括 `apps/server`、`apps/web`、`packages/protocol`、`README.md`／`PROTOCOL.md`／`COMPATIBILITY.md`／`RELEASE-RECOVERY.md`，以及此前的 `TODO.md`／`NEXT-STEPS.md`。本文件替代旧版 `TODO.md`。以下内容并非回归问题：此前大多数 P1 项（MIR-01 至 MIR-19）已关闭，并汇总在“已经稳固的部分”中，使本清单保持为面向未来的待办，而不是重复历史记录。

**同日更新：** 后续工作推进了 MIR-20/21/22（发布／CI 验证）以及 MIR-31/32/34/35（协议韧性和可运维性）；每项都注明实际变更和剩余工作。MIR-23 和 MIR-33 仍然确实开放（前者需要真实账号，后者需要专门的渐进式重构，不能仓促处理）；MIR-24 至 MIR-30（功能构想）则有意暂缓，等待单独讨论实际要开发哪些功能。

`apps/server/src`、`apps/web/src` 和 `packages/protocol/src` 中没有任何内联 `TODO`／`FIXME`／`HACK` 标记。代码没有把债务留在注释里，因此本轮审查关注的是设计缺口和未构建功能，而不是代码级清理。

**已确认（Confirmed）** = 当前代码／文档中可以观察到的缺口。
**待验证（Verify）** = 在认定为真实问题前还需要调查。
**增强项（Enhancement）** = 可选产品工作，按收益排序。
工作量仍使用 S／M／L。

## 已经稳固的部分——不要重复争论

- 静态存储凭证加密、仅绑定 loopback、强制 WARP 出站、日志脱敏，以及文档化的威胁边界（README 的“安全与数据”）。
- 服务端、Web 和协议包均有逐文件 100% 行／分支／函数覆盖率门禁（`c8`、`.c8rc.json`），包含 500 多项单元测试，以及真实的 cm 子进程契约测试（`todo-contract.test.mjs`）。
- 由路由实际校验所使用的同一组 Zod Schema 驱动生成 OpenAPI 3.1 文档，不需要手工维护另一份容易漂移的规范。
- 编号化事务数据库迁移、持久化 Schema 版本、备份／恢复演练（`storage:drill`）和 `RELEASE-RECOVERY.md`。
- 结构化 `/v1` 错误格式（`api-errors.ts`）、deadline／取消（`deadlines.ts`）、诊断（`GET /api/diagnostics`）、搜索／导出（`GET /api/conversations/search|:id/export`）和能力发现端点（`GET /v1/capabilities`）。
- `COMPATIBILITY.md` 对“结构上不可能实现”和“只是尚未实现”的区分非常诚实。请保持这种风格，不要在后续修改中把它软化成营销文案。

## P1——完成已经在进行的工作

- [x] **MIR-20 · 验证 · S——确认工作树确实达到可发布状态。**
  **证据（2026-09-14）：** 在当时干净的基线 `e25cae9` 上执行了 `npm run typecheck && npm run coverage && npm run manifest`，并记录在 `RELEASE-RECOVERY.md` 新增的“已测试修订”章节。该次不是从零执行 `npm ci`——当时使用 `npm install` 补齐缺失的平台专属可选依赖（见 MIR-21）——因此仍值得再做一次真正的干净检出验证，但当时针对真实工作树的所有检查均通过。

- [x] **MIR-21 · 增强 · M——真实运行 Playwright／浏览器测试套件。**
  **进展（2026-09-14）：** `apps/web` 单元测试运行器终于可以真实执行（此前一直被跳过，理由是“这里无法运行”）。真正阻塞点是过期的 macOS 专用 `node_modules` 缺少 Linux 的 `rolldown`／`esbuild` 原生绑定；通过 `npm install` 补齐平台包，并清理权限锁定的旧 `dist` 输出（见 `device_request_delete_permission`）后，`npm run coverage` 已真正执行全部 99 项 Web 测试以及服务端／协议测试，不再依赖“人工追踪验证”。Playwright 能下载并启动 Chromium，但其 headless shell 需要当前沙箱无法安装的系统共享库（例如 `libXdamage.so.1`，此处没有 root 权限，`sudo` 被阻止）。
  
  **后续更新（2026-09-14）：** `.github/workflows/ci.yml` 已加入，覆盖类型检查、100% 覆盖率、构建、`storage:drill`、真实 Playwright E2E 和 manifest 检查；但当时该账号的 GitHub Actions 因未支付账单而被暂停。为避免 README 上长期显示误导性的红色 CI 徽章，先尝试 Cirrus CI，但当时无法访问 `cirrus-ci.org/com`（`ERR_CONNECTION_CLOSED`），因此改用独立计费的 CircleCI，保持相同检查范围。首次启用仍需要人工登录 CircleCI 并连接仓库；该步骤需要仓库所有者的 GitHub 登录。
  
  **后续更新（2026-09-14）：** 首次真实运行又发现两个问题，均已修复并重新验证：在 Node v24.9.0（而不是沙箱中的 v22）下通过 100% 覆盖率／类型检查／manifest；同时修复 SHA256 清单在后续编辑后未重新生成的问题。随后把 Docker 容器构建、离线备份／恢复和镜像内构建修订号检查也迁移到 CircleCI。GitHub Actions 账单恢复后，又重新启用了 `.github/workflows/ci.yml`，让 GitHub Actions 与 CircleCI 并行运行，而不是互相替代。两条 CI 通道可以捕获不同环境的问题，且都使用各自免费额度内的标准资源。
  
  **Node 24 的真实缺陷：** 首次真实 CircleCI 运行发现沙箱 Node v22 一直掩盖的问题。`apps/web/tests/main.test.ts` 曾通过 `node:module` 的 `registerHooks({ load(...) })` Hook 处理 CSS 导入，并对其他模块调用 `next()`。在固定的 Node >=24 环境中，已解析过的模块（例如 `react/jsx-runtime.js`）再次调用 `next()` 会触发 `ERR_INVALID_RETURN_PROPERTY_VALUE`。修复方式是改用 `resolve` Hook，将 CSS Specifier 重定向到无副作用的 `data:` URL，从而完全不再自定义 `load` Hook。该修复已在 Node v24.9.0 下确认通过，并保持 100% 覆盖率。
  
  **最终验证（2026-11-20）：** 第十五轮汉化合并后的修订已通过 GitHub Actions CI，包括 `npm run test:e2e`、完整 100% 覆盖率门禁、`npm run manifest -- --check`、两种密钥模式的离线恢复演练，以及容器恢复／修订号检查。Playwright 现在是可重复执行的 CI 门禁；仅剩真实账号验收仍需人工完成（MIR-23）。

- [x] **MIR-22 · 验证 · S——执行 `npm audit` 并检查依赖更新。**
  **证据（2026-09-14）：** `npm audit` 报告 0 个漏洞。`npm outdated` 显示大多数只是次版本／补丁版本差异（Fastify 5.12.3→5.12.4、`@fastify/rate-limit` 10.x→11.x、`yaml`、`mdast-util-from-markdown`、`vite` 8.2→8.3），另有几个不应盲目升级的主版本（React 18→19、Zod 3→4、TypeScript 5→7、`undici` 7→8），需要真实兼容性审查，而不是只改版本号，因此本轮保持不变。注意：此沙箱运行 Node v22，而 `package.json` 要求 `>=24 <25`；这是沙箱工具链差异，不是仓库存在缺陷的证据。

- [ ] **MIR-23 · 增强 · S——完成实时验收清单。**
  该项仍然开放，需要真实 ChatGPT 账号和真实浏览器会话。本环境无法安全提供这些条件，也不应尝试在自动化过程中传入会话凭证；`RELEASE-RECOVERY.md` 和 `NEXT-STEPS.md` 已明确警告这一点。`scripts/protocol-canary.mjs`（本轮新增，见 MIR-32）可以按需执行只读健康状态／模型发现检查；运行中的实例可使用 `npm run protocol-canary` 输出脱敏结果。但 Custom GPT、Project 和 ChatGPTBox 的实际检查仍需要真人使用真实账号完成一次。

## P2——值得构建的真实功能缺口

- [ ] **MIR-24 · 增强 · L——支持多个并发 ChatGPT 账号／会话。**
  Mirror 当前架构只支持一个已保存的会话 Token。若要供多人使用，或同一用户在个人账号和工作账号之间切换，目前只能运行多个独立 Mirror 实例。多会话模型——命名会话、Mirror 控制面板中的活动会话选择器、按会话隔离的对话历史——会是高价值功能，但工作量确实较大：需要修改 `store.ts` Schema、`auth.ts` 和 `security.ts` 中的控制 Cookie 模型，这些位置目前都假设只有一个凭证。

- [ ] **MIR-25 · 增强 · M——真正的记忆／上下文功能。**
  `COMPATIBILITY.md` 将 ChatGPT 跨对话记忆标记为“Mirror 尚未暴露”。即使不触碰 ChatGPT 自身的记忆系统，Mirror 也可以提供本地等价功能：由用户维护一段“长期指令”，区别于每个对话自己的 system message，并在每个新对话的提示上下文前自动加入，可从 Playground 编辑。现有 `conversation-context.ts` 中的 `promptFor`／instructions 机制足以支持，无需新增上游协议能力。

- [ ] **MIR-26 · 增强 · M——对话文件夹／标签／置顶。**
  `ConversationTools.tsx` 已支持搜索和导出，但列表仍然是平铺、推测按时间排序的形式。当用户积累数周对话后，平铺列表会难以使用。增加标签／文件夹，以及将常用对话（例如反复使用的编程助手会话）置顶到顶部，会明显改善工作区体验；`NEXT-STEPS.md` 已将其列为 P2 体验优先项。

- [ ] **MIR-27 · 增强 · M——使用情况／成本相关洞察。**
  Mirror 正确地拒绝伪造 Token 数量（上游没有提供该字段），但可以统计并展示本地确实掌握的数据：每日轮次、平均响应时间、工具调用频率（网页搜索／代码解释器／图像生成）以及每个对话的消息数量。这些都可以从已有事件中计算，不需要编造 ChatGPT 从未报告的数字。可以在 Playground 中增加小型统计面板，并诚实地称为“本地使用模式”，绝不能称为“成本”或“Token 用量”。

- [ ] **MIR-28 · 增强 · S/M——键盘驱动的对话切换器。**
  `NEXT-STEPS.md` 已建议在分支查看器中支持“分支树键盘导航”；可以将同样的思路扩展到对话切换，基于现有搜索端点实现类似 `Cmd/Ctrl+K` 的快速打开面板。后端 `/api/conversations/search` 已存在，缺少的只是 UI 入口。

- [ ] **MIR-29 · 增强 · M——Playground 的“比较响应”模式。**
  Mirror 已能通过同一对话引擎支持 Chat 和 Responses 两种模式。可以增加并排视图，将同一提示分别通过两种 API 结构发送，或通过两个不同模型发送（例如比较自定义 GPT 与基础模型的输出），让 Playground 成为真正的测试工具，而不只是 Bearer Token 冒烟测试页面。

- [ ] **MIR-30 · 验证 · S——PWA／可安装 Web UI。**
  Mirror 明确只面向 `127.0.0.1`，这一安全约束应继续保留。但在此约束下，可以为 Playground 增加 manifest.json 和 service worker，让它能够安装为桌面应用图标，并在本地服务器可用时支持完整离线操作。这是一项独立的小型增强，不需要放松 `NEXT-STEPS.md` 提醒的安全边界。

## P3——协议韧性与可运维性（仍有未完成项）

- [ ] **MIR-31 · 增强 · L——脱敏捕获／回放夹具格式。**
  **进展（2026-09-14）：** 失败分类部分已完成。`packages/protocol/src/drift.ts` 中的 `classifyProtocolFailure()` 会将 backend-api 失败归为四类：authentication-challenge、transport-truncation、known-upstream-error、unsupported-shape。相关测试已完整覆盖（`drift.test.mjs`），并接入 `openai.ts` 错误处理器。现在 `GET /api/diagnostics` 的 `recentFailures` 会在原有 HTTP 状态分类之外记录该协议漂移类别，不改变公开响应结构，也不暴露原始上游载荷。
  
  **仍未完成：** MIR-31 的另一半——为 `sse.test.mjs` 测试夹具建立兼容 Schema 演进、带来源信息的捕获／回放格式，至少记录捕获日期、端点和脱敏版本。本轮只增加了失败分类，没有新增夹具格式。

- [x] **MIR-32 · 增强 · M——可选启用的实时协议 Canary。**
  **证据（2026-09-14）：** `scripts/protocol-canary.mjs`（`npm run protocol-canary`）默认针对运行中的 Mirror 实例检查健康状态、诊断和模型发现；它是只读的，调用 Mirror 已脱敏的 `/api/*` 路由，不会重新实现凭证处理。只有明确传入 `--generate` 时才会发送一次真实、可丢弃的 `/v1/chat/completions` 请求。报告只包含成功状态、耗时和 finish_reason，不包含提示词或回复文本，并会输出适合附加到 Issue 的 JSON 报告。它没有接入 CI，因为设计上需要真实账号；这是有意为之，不是缺口。

- [ ] **MIR-33 · 增强 · L——继续拆分 `openai.ts`／`store.ts`／`index.ts`。**
  本轮没有尝试此项。`openai.ts`（MIR-31 小幅增加后约 1070 行）、`store.ts`（877 行）和 `index.ts`（约 610 行）结构仍未变化。这是有意延后处理的真实风险：为了快速打勾而仓促进行大规模拆分，恰恰容易引入当前回归测试套件要防止的续接／持久化细微错误。`NEXT-STEPS.md` 第 4 节仍是正确目标：`openai.ts` 拆为 Schema／适配器、对话解析、传输写入器和路由注册；`store.ts` 则在接口后拆为 Schema、凭证、对话和维护 Repository。应单独推进，每次只做一项拆分，并在每一步执行完整测试套件。

- [ ] **MIR-34 · 增强 · M——结构化可运维日志。**
  **进展（2026-09-14）：** 修复了一个真实且已确认的缺口：`openai.ts` 的失败处理器此前只在流式分支调用 `recordFailure()`（即 `GET /api/diagnostics` 背后的失败分类计数器），因此上游失败的非流式请求完全不会被统计。现在 `recordFailure()` 会在流式／非流式分支之前无条件执行，并且会在已有 HTTP 状态码之外记录 MIR-31 协议漂移分类（见 `preflight.test.mjs`／`openai-routes.test.mjs` 新增的漂移分类测试）。
  
  **仍未完成：** `NEXT-STEPS.md` 第 5 节提出的更大目标——每个请求都记录路由／耗时／对话操作／上游阶段／deadline 阶段等结构化字段——尚未实现。Fastify 默认请求日志已经免费提供 request ID／路由／耗时／状态码，并使用现有脱敏序列化器；但 Mirror 专属语义字段（新建、续接还是 rebase，以及失败发生在哪个上游／deadline 阶段）仍需通过 `chat-service.ts`／`openai.ts` 多处调用链传递，应作为独立谨慎的开发轮次处理，而不是快速添加。

- [x] **MIR-35 · 增强 · S——启动预检诊断。**
  **证据（2026-09-14）：** `apps/server/src/preflight.ts` 中的 `classifyStartupFailure()`／`formatStartupFailure()` 会把启动失败转为一条带分类、可操作的提示：配置错误（错误的 `MIRROR_STORE_KEY`）、数据库迁移（Schema 版本不兼容）、warp-egress（WARP 无法连接／未验证）或端口占用（`EADDRINUSE`），不再只显示未处理 Promise 的原始堆栈。该逻辑已接入 `index.ts` 入口 try/catch，并由 `preflight.test.mjs` 单元测试和 `startup.test.mjs` 端到端启动测试覆盖。
  
  范围保持诚实：缺少浏览器依赖和会话过期都是真实失败模式，但它们不会在当前代码的启动阶段发生（Turnstile 浏览器求解器在首次使用时才延迟启动；会话有效性只在第一次代理／API 请求时检查）。这两种问题已经会在请求实际触发后，通过 MIR-09 的 `GET /api/diagnostics` 提供下一步操作提示，因此不会假装 Mirror 在启动时检查了它实际上没有检查的内容。

## P3——文档后续工作

- [ ] **MIR-11（延续）· 增强 · M——重新审查 `COMPATIBILITY.md` 中的绝对化表述。**
  除了 README 修改之外，此项此前从未真正关闭。现在 MIR-20/21/22/23 已推进，值得逐行复核所有“尚不支持”／“结构上不可能”的说法，确认它们仍与 `openai.ts`／`sse.ts` 的实际行为一致，因为这两个文件在部分文案写成后都发生过变化。

- [x] **MIR-36 · 增强 · S——新增 CHANGELOG.md。**
  已增加面向用户的 `CHANGELOG.md`，并在 Unreleased 部分记录版本化镜像／发布流水线和构建元数据。未来带标签的发布可以在其中追加用户可见变更，而不必把 `TODO.md` 当作发布说明。

## 与 cm 共享的工作

- [ ] **MIR-19（延续）· 验证 · M——编写真正的共享流式／持久化契约文档。**
  相关行为现在已由可执行测试（`todo-contract.test.mjs`）锁定，但此前记录的“本轮没有编写真正的文档”仍然成立；还需要与 `cm` 自己的 `TODO.md` 中 CM-01／02／16 项协调。

---

剩余开放工作大致按优先级排列：MIR-23（使用真实 ChatGPT 账号完成实时验收）、MIR-33（增量拆分核心模块）、MIR-34（语义化结构日志）、MIR-31（脱敏夹具来源信息）、MIR-19（共享流式／持久化契约）以及 MIR-11（兼容性文档审查）。

之后再决定要让 Mirror 成为哪种产品，并从 P2 的 MIR-24 至 MIR-30 中选择实际要做的功能。
