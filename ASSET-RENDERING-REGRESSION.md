# 生成文件渲染与下载

已于 2026-09-10 在本地针对 ChatGPTBox 提交 `d47f875aaeb5bf8e7464fcf60c404fef759dee73` 完成验证，来源：https://github.com/ChatGPTBox-dev/chatGPTBox。

## 原因与行为

此前的输出会直接链接到带签名的 ChatGPT Estuary URL。新生成的 URL 在未认证时返回 HTTP 403，使用已保存的上游会话时返回 HTTP 200。ChatGPTBox 对 `chatgpt.com` 链接的特殊处理还会使用可点击的 span，而不是普通 anchor。第一次尝试替换为 loopback 图片 URL 时，在受控 HTTPS 搜索页面测试夹具中触发了 Chromium 的 Local Network Access 限制。

Mirror 现在会在服务端获取预览字节，并嵌入标准 Markdown 图片 data URI。生成文件使用 `下载文件：[实际文件名](<Mirror 文件 URL>)`。文件 URL 携带一个加密、绑定会话、有效期七天且只对应单个资源的 capability。服务端会刷新上游元数据，并以附件方式传输原始字节，同时保留 UTF-8 文件名。链接中不会放入 API Key 或上游凭证。断开或重新连接会话都会使 capability 失效。

Markdown 转换会解析普通目标地址和引用链接，转义文件名，并保留周围文本。预览不可用时，只要文件元数据可用，仍会保留下载入口；无法解析的文件会明确标记为不可用。ChatGPTBox 已经保存的旧回复不会被追溯修改。

## 验证证据

- 完整自动化测试套件通过。要求的覆盖率门禁对每个纳入的文件均报告 100% lines、statements、functions 和 branches。
- 生产构建成功。Chat／Responses JSON 和 SSE 回归用例均保持三轮对话续接，并使用精确返回的 assistant 文本。
- 可选脚本 `scripts/check-chatgptbox-assets.mjs` 会打包当前检出版本中的真实 Markdown 和 Hyperlink 组件。Chromium 在正常浏览器安全策略下运行，使用全新 profile 和受控的 `https://www.google.com/search` 测试页面。
- 两种渲染器变体（启用和不启用 KaTeX）都能解码合成预览并下载 `report.csv`；下载文件名和全部 17 个字节都与测试夹具一致。
- 更新本地 Docker Mirror 服务后，一次正常的实时 ChatGPT 对话生成了 `mirror-preview-qa.png`（96 × 64，442 字节）和 `mirror-download-qa.csv`（17 字节）。PNG 预览被嵌入回复；匿名 capability 请求以 HTTP 200 和附件响应头下载了两个原始文件。CSV 内容精确为 `name,value\nQA,42\n`。
- 两种真实 ChatGPTBox 渲染器变体也通过了这条实时响应验证：图片成功解码，文件名链接按正常浏览器行为打开，CSV 下载内容逐字节一致。
- 运行中的服务报告 SQLite 存储健康，且必需的 WARP 出站验证通过。WARP 容器和持久化数据均予以保留。此前镜像已标记为 `mirror-app-mirror:before-asset-fix-20260910`，可用于回滚。

## 适用边界

这里提供的是源码渲染器集成，以及真实上游和浏览器下载证据；不能据此声称实际测试了用户安装的扩展，或真实 Google 搜索结果页面。扩展版本和页面策略可能不同。

另有一次实时 `store:false` 临时对话探测成功生成了文件，但 ChatGPT 的解释器下载端点对最终消息 ID 和工具消息 ID 均返回 HTTP 404。Mirror 会正确报告这些文件不可用。这个上游临时对话文件取回场景仍不受支持；通过验证的实时流程使用普通持久化对话语义，这也是 ChatGPTBox 默认发送的方式。该修复不会为了绕过限制而更改用户的存储／隐私选择。

图片预览读取限制为每张最多 25 MiB；原始文件下载不受此预览限制。嵌入式预览会增加返回文本和客户端保存历史的体积。上游文件可能在 Mirror 七天链接到期前独立过期。

## 复现步骤

先运行 `npm run coverage`、`npm run build`，然后执行：

```sh
CHATGPTBOX_SOURCE=/path/to/chatGPTBox node scripts/check-chatgptbox-assets.mjs
```

检出目录需要先安装自身的 npm 依赖。若要回放生成 `mirror-preview-qa.png` 和 `mirror-download-qa.csv` 的特定实时 QA 响应，可将 `MIRROR_ASSET_RESPONSE` 设置为一个私有 JSON 文件路径，文件内容应包含 `{ "markdown": "..." }`。不要提交包含 capability 的响应文件。
