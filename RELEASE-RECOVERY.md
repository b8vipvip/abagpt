# 发布验证与恢复

升级已持久化数据的 Mirror 实例之前，请保留旧版本镜像，以及与数据库备份配套的加密密钥。绝不能将正在运行的数据库作为恢复测试的目标。

## 数据库兼容性

当前 Schema 版本为 **1**，存储在 SQLite 的 `PRAGMA user_version` 中，并通过 `/api/diagnostics` 的 `storage.schemaVersion` 暴露。版本 0 表示历史上未进行版本标记的 SQLite Schema。当前基线兼容该 Schema，包括缺少 `attachments_json`、`is_private` 或 `is_branch` 字段的数据库。已有的加密会话、消息、指令和上游节点 ID 都会保留。历史版本的 `store.json` 会话导入器仍受支持。

Schema 变更和版本递增会在同一个事务中提交。发生错误时，整个升级事务都会回滚。重新打开当前版本的数据库不会重复执行迁移。若数据库版本高于当前版本，程序会以兼容性错误拒绝启动。未来的迁移必须追加到 `apps/server/src/schema.ts`；已经发布的迁移内容必须保持不变。切勿手动修改 `user_version` 来绕过兼容性检查。

早于此版本检查机制的旧版二进制无法执行该检查。虽然版本 1 沿用现有 Schema，但不承诺可以降级兼容：如果要回退到旧版本，请将升级前的备份恢复到一个新的数据卷中。

## 本地发布检查

安装依赖后，使用 Node 24 执行：

```sh
npm ci
npm run typecheck
npm run coverage
npm run build
npm run storage:drill
npm run test:e2e
npm run manifest -- --check
```

恢复演练会在新的临时目录中使用合成数据，并在完成后删除该目录。它会忽略已配置的数据目录，并在“使用外部密钥”的测试场景中替换已配置的存储密钥。演练会在两种密钥模式下检查 SQLite 完整性、会话解密、指令、消息内容、上游对话/父节点身份、源数据保留、拒绝覆盖，以及拒绝错误密钥。它不会连接 ChatGPT，也不能证明真实对话可以继续。CI 会在构建后执行此演练。随后，依赖该任务的容器作业会构建同一版本，在禁用网络的运行时镜像中再次执行演练、检查镜像内嵌的版本，并记录镜像 ID 和 OCI 标签。

## 识别并验证候选镜像

请从已提交且工作区干净的代码检出版本进行构建。在执行 `docker compose build mirror` 之前，将完整 commit SHA 设置到 `MIRROR_BUILD_REVISION`，并将发布版本设置到 `MIRROR_VERSION`。Compose 会将二者作为构建参数传递。镜像的 OCI 标签和 `/api/diagnostics` 都会报告版本及源码修订；本地源码构建默认显示 `development`。Node 24 基础镜像使用官方多平台索引摘要固定，避免同一 Dockerfile 因基础镜像标签漂移而悄然换底。revision 参数仍只是构建者提供的标签，并不能单独证明工作区干净或构建产物与该 commit 完全一致。

替换正在运行的服务之前，请先离线运行候选镜像：

```sh
docker run --rm --network none --entrypoint node CANDIDATE_IMAGE scripts/restore-drill.mjs
```

将 `CANDIDATE_IMAGE` 替换为已经验证的镜像 ID 或不可变镜像摘要。此命令不会挂载任何生产数据卷。维护脚本已包含在运行时镜像中。稳定版标签 `vX.Y.Z` 会触发 `.github/workflows/release.yml`：流水线在发布前执行类型检查、全量覆盖率、构建、双密钥恢复演练、Playwright 和清单校验，然后推送 amd64/arm64 镜像，生成 SBOM/来源证明，并在 GitHub Release 上传 OpenAPI、SHA-256 清单、package-lock 和 `release-metadata.json`。后者记录源码 SHA、Node/npm 版本、依赖锁文件哈希、Node 基础镜像摘要及最终镜像的不可变引用。该流程保证已发布产物可被精确识别和回滚；由于 Playwright 浏览器及 Debian 系统依赖仍从上游软件源安装，它不宣称不同日期的重新构建必然得到逐字节相同的镜像。

## 使用固定摘要部署与回滚

优先从 GitHub Release 下载 `release-metadata.json`，将 `container.immutableReference` 原样保存为部署记录。Compose 的 `MIRROR_IMAGE` 支持 `ghcr.io/...@sha256:...`；部署发布镜像时运行 `docker compose up -d`，不要添加 `--build`。回滚时使用上一版本 Release 元数据中的镜像摘要，并按下文步骤将升级前备份恢复到新的空数据卷。不要只依赖可变的 `:latest` 标签。

## 备份与隔离恢复

Compose 将数据存储在 `mirror-data` 命名卷中的 `/home/node/.mirror` 目录。该卷的实际名称会包含 Compose 项目前缀。单独的 `mirror-warp` 卷用于存储 WARP 状态。升级期间不要删除任一卷；尤其不要使用 `docker compose down -v`。

宿主机维护命令默认使用 `.data` 目录，不会自动操作 Compose 数据卷。在容器内运行维护命令或针对离线副本执行操作时，请将 `MIRROR_DATA_DIR` 设置为实际挂载的数据目录。

1. 记录旧镜像 ID，并在离线升级流程开始前停止 Mirror 服务。WARP 可以继续运行。
2. 在源数据卷已挂载、且 `MIRROR_DATA_DIR` 指向该卷的环境中运行 `node scripts/storage.mjs backup NEW_BACKUP_DIRECTORY`。请使用该数据卷之外的全新备份目标目录。备份 API 会包含已提交的 WAL 数据；只复制正在使用的 `mirror.db` 并不等价于完整备份。
3. 将备份视为私有敏感数据并妥善保护。在自动生成密钥模式下，备份中包含 `master.key`。在外部提供密钥的模式下，请单独保留原始 `MIRROR_STORE_KEY`；备份命令会刻意排除该密钥。
4. 挂载一个单独的空目标数据卷，并在 `MIRROR_DATA_DIR` 指向该目标卷时运行 `node scripts/storage.mjs restore BACKUP_DIRECTORY --offline`。如果目标中已存在 `mirror.db`，恢复操作会拒绝执行。使用匹配的密钥，将候选版本启动到该目标卷，然后确认诊断信息和预期对话历史。
5. 离线检查通过后，使用计划中的数据卷部署候选版本。确认 WARP 健康状态、Schema/构建诊断、模型发现，并使用返回的历史记录执行一个临时对话，连续完成三轮。将此结果单独记录为真实上游验证证据。

## 回滚

如果启动或验收失败，请停止候选版本，并保留失败的数据卷用于诊断。将升级前的备份恢复到另一个空数据卷，提供与备份匹配的密钥，然后使用已记录的旧镜像启动该数据卷。验证 WARP、诊断信息、模型发现和真实对话续接。不要覆盖失败的数据库，也不要强行降低 Schema 版本。

离线演练只能证明备份/恢复机制正常。使用真实 Compose 数据卷、生产形态数据和已认证对话续接进行恢复，是单独的发布验收任务。

## 已测试版本（2026-09-14）

基准 commit 为 `e25cae9563407d9fb1d484191a511a42e18e0cbc`（本轮在该基准之上还有未提交的工作区修改——参见 TODO.md 中的 MIR-31/32/34/35——当时尚未提交）。在该基准及上述修改之上，`npm run typecheck`、`npm run coverage`（共 552/552 项测试；根据 `.c8rc.json` 的逐文件门禁，每个文件的行/分支/函数/语句覆盖率均为 100%）和 `npm run manifest` 均在实际工作区中通过（并非从头执行 `npm ci`，这一剩余缺口见 TODO.md 的 MIR-20）。`npm audit` 报告 0 个漏洞。该环境无法运行 Playwright/浏览器端到端测试（见 TODO.md 的 MIR-21）——这并不代表该测试已通过，只能说明其他检查均已通过。
