# GPTAuto 工程自动化集成

本仓库通过 GPTAuto Consumer Sync 接入 [b8vipvip/GPTAuto](https://github.com/b8vipvip/GPTAuto)。集成采用 GitHub Actions 消费仓库模式：GPTAuto 在 GitHub Actions 的 Python 3.12 环境中运行，不把 Python 运行时、GitHub PAT 或自动修复执行器塞进 Mirror 的 Docker 服务，也不接触 ChatGPT Session Token。

## 能力边界

集成后，GPTAuto 面向 **ABAGPT 代码仓库的工程任务**工作：

```text
ABAGPT PR / CI / main push
        ↓
GPTAuto Observer
        ↓
GPTAuto Executor
        ├─ 等待或验证 CI
        ├─ 安全合并门禁
        └─ 触发 Reconcile
                 ↓
          精确 merge SHA 的 main CI
                 ↓
          需要发布时验证 Release 证据
```

CI 失败时可进入三层 Repair：确定性修复、可选 Copilot CLI、前台恢复交接。GPTAuto 的 canonical task state 是任务终态的唯一权威；PR 已创建、CI 正在运行或代码已合并都不能单独视为任务完成。

这不是在 Mirror 聊天页面中添加一个能自动操作用户 ChatGPT 对话的按钮，也不会读取或转发 Mirror 保存的会话凭证。它集成的是仓库工程生命周期自动化。

## 首次安装

本 PR 只添加官方 Consumer Sync 引导工作流。合并后按以下步骤安装完整运行时：

1. 在 GitHub 仓库 **Settings → Secrets and variables → Actions → New repository secret** 中创建 `GPTAUTO_GITHUB_TOKEN`。
2. 使用仅授权此仓库的 fine-grained token。至少授予：
   - **Contents：Read and write**
   - **Pull requests：Read and write**
   - **Workflows：Read and write**
   - **Actions：Read and write**
   - **Checks：Read**
   - **Issues：Read and write**（用于失败诊断 Issue 和任务评论）
3. 打开 **Actions → GPTAuto Consumer Sync → Run workflow**：
   - `operation` 选择 `sync`
   - `version` 选择 `v0.15.15`
4. 工作流从 GPTAuto 的正式发布标签下载对应版本，生成 `chore/gptauto-sync-v0.15.15` 分支和同步 PR。必须等待 ABAGPT 自身 CI 通过，再按仓库审核流程合并该 PR。

`GPTAUTO_GITHUB_TOKEN` 必须保存在 GitHub Repository Secret 中；不要把 PAT 写入 `.env`、源码、Issue、聊天内容或前端配置。Consumer Sync 会在缺少 Workflows 写权限时停止原子同步，不会把不完整版本标记为已安装。

## 可选凭据

- `GPTAUTO_COPILOT_TOKEN`：可选，仅供 Tier 2 Copilot CLI 修复使用。没有该 Token 时仍可使用确定性修复，并在需要时交给前台编码代理。
- 旧版 `GPTAUTO_SYNC_TOKEN` / `GPTAUTO_EXECUTOR_TOKEN` 仅作为迁移兼容项；新安装优先使用统一的 `GPTAUTO_GITHUB_TOKEN`。

## 与 ABAGPT CI / Release 的配合

- `.github/workflows/ci.yml` 同时支持 `push`、`pull_request` 和 `workflow_dispatch`。最后一项是必需的：GPTAuto Reconcile 会针对精确 merge SHA 显式派发产品 CI。
- 现有 `Release` 工作流保留原有 tag 驱动方式。只有任务明确要求发布时，GPTAuto 才要求并验证正式 GitHub Release 证据。
- 如需使用不同的产品验证工作流名称，可在仓库 Variables 中设置 `GPTAUTO_POST_MERGE_WORKFLOW`；默认识别 `CI` 或 `Build and Test`。
- GPTAuto 管理的文件位于 `.github/gptauto/`、`.github/actions/upload-gptauto-log/` 和 `.github/workflows/gptauto-*.yml`。后续版本只通过 Consumer Sync 的 CI 门禁 PR 更新。

## 当前状态与未完成步骤

- [x] 在 ABAGPT 加入 Consumer Sync 引导工作流，并将手动同步版本固定为显式发布标签。
- [x] 为产品 CI 增加 `workflow_dispatch`，满足 Reconcile 的精确 SHA 验收要求。
- [ ] 合并本集成 PR。
- [ ] 在 GitHub Repository Secrets 中配置 `GPTAUTO_GITHUB_TOKEN`。
- [ ] 运行 Consumer Sync，合并首次 GPTAuto 运行时同步 PR。
- [ ] 首次安装完成后，将 `b8vipvip/abagpt` 注册到 canonical GPTAuto 的 `.gptauto/consumers.json`，启用后续 Release fan-out。

首次安装和凭据配置完成前，不能声称 GPTAuto 已经在 ABAGPT 仓库中实际运行。
