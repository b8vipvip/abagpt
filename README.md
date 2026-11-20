# Mirror

[![CircleCI](https://circleci.com/gh/defcron/mirror.svg?style=svg)](https://circleci.com/gh/defcron/mirror) [![GitHub Actions CI](https://github.com/defcron/mirror/actions/workflows/ci.yml/badge.svg)](https://github.com/defcron/mirror/actions/workflows/ci.yml) [![Coverage](https://codecov.io/github/defcron/mirror/branch/main/graph/badge.svg)](https://app.codecov.io/github/defcron/mirror) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen)](.nvmrc)

Mirror 是一个自托管的 ChatGPT 客户端和 OpenAI 兼容 API。它的 Web 界面通过本地代理提供官方 ChatGPT 应用，因此你可以直接使用自己的 ChatGPT 账号访问对话和自定义 GPT，无需 OpenAI API Key，也无需浏览器自动化。Mirror 还提供 API 测试台、四种文件格式的转换工具，以及 REST/SSE API。

> **非官方项目：** Mirror 依赖 ChatGPT 的私有 Web 协议，该协议可能随时发生变化，恕不另行通知。本项目面向本地使用。实现细节和已知限制请参阅 [PROTOCOL.md](PROTOCOL.md)。

## 快速开始

你需要安装 Docker，并在浏览器中登录一个有效的 ChatGPT 账号。

1. 保持登录状态，打开 [ChatGPT 会话页面](https://chatgpt.com/api/auth/session)，复制你的 session token。
2. 配置并启动 Mirror：

   ```sh
   cp .env.example .env
   # 阅读 Cloudflare WARP 服务条款，然后在 .env 中设置 WARP_ACCEPT_TOS=yes。
   docker compose up --build
   ```

3. 打开 [http://127.0.0.1:8799](http://127.0.0.1:8799)。在 ChatGPT 侧边栏中选择 **Mirror 控制台**，粘贴刚才复制的令牌，然后点击 **保存并刷新**。

Mirror 会在本地服务器上加密保存凭证，并使用它获取短期有效的访问令牌。控制台还会显示连接状态和 WARP 状态，并提供 API 测试台、API 文档和解码挑战的入口。

### 使用已发布的固定版本镜像

每个稳定版 `vX.Y.Z` 标签都会触发发布流水线：重新执行完整测试、发布 Linux amd64/arm64 镜像、生成 SBOM 和构建来源证明，并在 GitHub Release 附上 OpenAPI、SHA-256 清单、依赖锁文件及 `release-metadata.json`。

要部署固定发布版本，请从对应 Release 的 `release-metadata.json` 复制 `container.immutableReference`，写入 `.env`：

```sh
MIRROR_IMAGE=ghcr.io/b8vipvip/abagpt@sha256:<release-digest>
docker compose up -d
```

使用镜像摘要部署时不要添加 `--build`；这会拉取并运行指定的不可变镜像。源码开发仍使用默认的 `:local` 镜像并执行 `docker compose up --build`。首次发布后，如需匿名公开拉取 GHCR 镜像，请在 GitHub Packages 中将该容器包的可见性设为 Public。

### 网络要求

所有出站流量都必须经过内置的 Cloudflare WARP 隧道。Mirror 会在开始处理请求前检查隧道，并在运行期间定期复查；不会回退到直连模式。这样可以确保出站流量经过已验证的网络出口，并避免 Cloudflare 本地代理模式的 10 秒请求时限。WARP 不提供固定 IP，也不能解除账号限制。

## ChatGPT 功能

Mirror 代理的是官方 ChatGPT 界面，而不是重新实现一套聊天页面。因此，通过代理仍可使用 ChatGPT 账号本身提供的功能，例如对话历史、自定义 GPT、分支、编辑、重新生成、文件上传、生成图片、Markdown 和 KaTeX。

Mirror 还在控制台中加入了 **解码挑战**。你可以使用 LoaF、PngSpeak、gptgif 或 gptgif v4 创建挑战，然后让 GPT 解码生成的内容。你可以将提示词插入消息编辑框、复制提示词，或连同生成的文件一起下载。还可以选择下载套件，其中每种格式各包含一个文件和对应提示词。GPT 回复后，Mirror 可以使用临时服务端密钥验证答案。密钥会在 24 小时后、服务器重启后或会话变更后失效；Mirror 最多保留 64 个有效挑战，每分钟最多生成 20 次。完整挑战路由和限制请参阅 API 文档。

## API 测试台与格式转换 API

在 Mirror 控制台中打开 **API 测试台**，或直接访问 [http://127.0.0.1:8799/mirror/playground](http://127.0.0.1:8799/mirror/playground)。API 测试台无需单独编写客户端，即可测试 `/v1/chat/completions` 和 `/v1/responses`。对话模式支持文本以及文件/图片附件；Responses 模式目前仅接受文本。你可以通过 Mirror 的 conversation ID 继续已有对话。

格式转换 API 在 `/api/convert/*` 下提供 LoaF、PngSpeak、gptgif 和 gptgif v4。默认情况下，它接受包含 Base64 数据的 JSON；也可以通过 `raw_in`、`raw_out` 和 `raw` 查询参数传输原始字节。原版 gptgif 格式需要经过校准的簇映射才能解码。运行中的服务器会在 `/mirror/api-docs` 提供 API 参考文档，其中包含当前请求 Schema 和响应结构。

## OpenAI 兼容 API

将 OpenAI SDK 的 base URL 设置为 `http://127.0.0.1:8799/v1\)。例如：

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8799/v1",
    api_key="your-mirror-api-key",
)

response = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

Mirror 提供 `GET /v1/models` 和 `POST /v1/chat/completions`（支持流式和非流式响应）。支持的请求字段以及与 OpenAI API 的已知差异记录在 [COMPATIBILITY.md](COMPATIBILITY.md) 中。Mirror 不会调用 `api.openai.com`；如果设置了 `OPENAI_API_KEY`，它会被当作访问 Mirror 的入站 API Key 使用。

程序化客户端必须设置 `MIRROR_API_KEY`、`MIRROR_API_KEYS` 或 `OPENAI_API_KEY`。通过浏览器访问 Mirror 根路径或 API 测试台时，系统会为浏览器界面建立同源控制 Cookie。API Key 不能代替 ChatGPT session token。

使用以下命令生成随机 API Key：

```sh
npm run gen-api-key
```

将命令打印出的值设置到 `.env` 文件中的 `MIRROR_API_KEY`。该命令不会自动修改 `.env`。

## 不使用 Docker 运行

开发环境请使用 Node.js 24：

```sh
nvm use
npm ci
npm run dev
```

该命令会在 `127.0.0.1:8787` 启动服务端，并在端口 `5173` 启动 Web 开发服务器。直接运行 `npm start` 会在 `HOST:PORT` 启动生产服务器（默认地址为 `127.0.0.1:8787`），同样需要可正常工作的 WARP 隧道。

## 配置项

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WARP_ACCEPT_TOS` | 未设置 | 阅读 Cloudflare WARP 服务条款后设置为 `yes`。启动必需。 |
| `MIRROR_PORT` | `8799` | Docker Compose 使用的宿主机端口。 |
| `HOST` | `127.0.0.1` | 直接运行（非 Compose）时的绑定地址。 |
| `PORT` | `8787` | 直接运行时使用的端口。 |
| `MIRROR_WEB_ORIGIN` | `http://localhost:5173` | 开发环境 CORS 使用的 Web 来源地址。 |
| `MIRROR_DATA_DIR` | `.data` | SQLite 数据库和自动生成的加密密钥所在目录。 |
| `MIRROR_STORE_KEY` | 自动生成 | 可选的 32 字节密钥（Base64 或十六进制），用于加密静态存储的凭证。 |
| `MIRROR_API_KEY` | 未设置 | 程序化访问所用的入站 API Key。 |
| `MIRROR_API_KEYS` | 未设置 | 以逗号分隔的多个有效入站 API Key。 |
| `OPENAI_API_KEY` | 未设置 | 额外的入站 API Key；它不是 OpenAI 服务凭证。 |

Compose 使用 `MIRROR_PORT`；直接运行时使用 `HOST` 和 `PORT`。这两组设置彼此独立。

## 安全与数据

Mirror 默认绑定到本地回环地址，并拒绝非回环主机。它并非为远程或多用户部署而设计。若要远程部署，还需要额外的身份验证、TLS、CSRF 防护和安全审查。

默认情况下，会话令牌和签发的访问令牌使用 AES-256-GCM 加密后存储在 `.data/mirror.db` 中。Mirror 会创建权限仅限文件所有者访问的 `.data/master.key`；你也可以自行提供 `MIRROR_STORE_KEY`。对话文本、指令和事件会以未加密形式保存在本地。请求日志会对常见凭证请求头进行脱敏，但仍应视为敏感数据。

备份可能包含明文对话和指令、加密凭证，以及自动生成的 master key。请妥善保护整个备份；如果使用自定义的 `MIRROR_STORE_KEY`，请单独保管该密钥。维护命令示例：

```sh
npm run storage -- backup /absolute/path/to/backup
# 恢复或清理数据前，请先停止 Mirror。
MIRROR_DATA_DIR=/absolute/path/to/new-data npm run storage -- restore /absolute/path/to/backup --offline
npm run storage -- prune 90 --offline
```

恢复操作不会覆盖现有数据库。清理操作会删除超过指定天数的本地对话，但不会影响 ChatGPT 历史记录，也不会撤销凭证。数据库 Schema 兼容性和恢复步骤请参阅 [RELEASE-RECOVERY.md](RELEASE-RECOVERY.md)。

## 开发与测试

```sh
npm run typecheck
npm test
npm run coverage
npm run build
npm run test:e2e
npm run manifest -- --check
```

`npm run coverage` 要求每个应用源文件的 statements、branches、functions 和 lines 覆盖率均达到 100%，并生成 `coverage/lcov.info`。GitHub Actions 会在覆盖率门禁通过后将报告上传到 Codecov；上方徽章显示上传测试报告中的实际行覆盖率。若要启用报告上传，请将公开仓库连接到 Codecov，并将该仓库的上传令牌添加为 GitHub Actions Secret `CODECOV_TOKEN`。公开开源项目可以使用 Codecov 免费方案。测试使用隔离存储和模拟的上游响应，不会验证与真实 ChatGPT 账号的兼容性。浏览器冒烟测试通过 Playwright 单独运行。每个测试都必须放在具名的 `test.describe(...)` 测试套件中；`npm run test:suites` 会检查这一规则。

修改受跟踪的源代码或配置后，请重新生成 `SHA256-MANIFEST.json`：

```sh
npm run manifest
```

## API 概览

Mirror 提供本地控制路由、格式转换路由、解码挑战路由，以及 OpenAI 兼容 API。自动生成的 OpenAPI 文档可通过 `/mirror/openapi`（JSON）访问；添加 `?format=yaml` 可获取 YAML 格式。也可以通过 `/mirror/api-docs` 浏览文档。

| 路由 | 用途 |
| --- | --- |
| `GET /api/health` | 健康状态、配置和出站网络状态 |
| `POST /api/session` | 验证并保存 ChatGPT session token |
| `GET` / `DELETE /api/session` | 查看或删除已保存的会话 |
| `/api/conversations/*` | 创建、列出、加载、分支、停止和删除对话 |
| `POST /api/files` | 上传附件 |
| `/api/convert/*` | 对支持的格式进行编码、解码、验证和校准 |
| `/api/decoder-challenges/*` | 生成和验证解码挑战，并下载挑战套件 |
| `GET /v1/models` | 以 OpenAI 兼容格式列出可用模型 |
| `POST /v1/chat/completions` | 创建流式或非流式补全请求 |

## 项目文档

- [PROTOCOL.md](PROTOCOL.md)：ChatGPT 协议实现、已知缺口和待解决问题。
- [COMPATIBILITY.md](COMPATIBILITY.md)：OpenAI API 兼容性详情。
- [TODO.md](TODO.md)：按 Issue 组织的项目待办事项。
- [NEXT-STEPS.md](NEXT-STEPS.md)：仓库审计路线图。
- [CHANGELOG.md](CHANGELOG.md)：面向用户的版本变更记录。
