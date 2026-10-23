# Bug 自动修复配置与排障指南

本文用于启用并验收“分析结果 → 飞书点击尝试修复 → Worker 生成本地修复提交”链路。架构设计、安全边界和 worktree 生命周期见 [Bug 自动修复与本地交付设计](./bug-fix-workflow-design.md)。

## 1. 先确认部署位置

自动修复跨两个进程，配置必须放在实际运行对应进程的机器上：

| 组件 | 主要职责 | 配置位置 |
| --- | --- | --- |
| Cloud（`code/`） | 发送交互卡片、接收飞书点击回调、保存和派发修复任务 | 运行 `code/` 服务的服务器 |
| Worker（`worker/`） | 读取目标仓库、调用 Agent、创建 worktree、运行检查并生成 commit | 能访问目标仓库的 Worker 机器 |

如果 Cloud 和 Worker 部署在不同机器，两台机器需要各自准备仓库根目录 `.env`。不要只在 Worker 机器配置飞书回调 Token；它由 Cloud 使用。

## 2. 环境变量核对

### 2.1 Cloud

最小配置：

```env
APP_ID=cli_xxx
APP_SECRET=xxx
CHAT_ID=oc_xxx
AGENT_API_TOKEN=使用随机生成的长Token

# 推荐使用飞书「事件与回调」页面的 Verification Token
LARK_VERIFICATION_TOKEN=xxx
```

卡片回调验证至少要配置下面一种方式，否则即使分析结果为 `resolved`，结果卡片也不会显示“尝试修复”：

- `LARK_VERIFICATION_TOKEN`：最简单，值必须与飞书后台一致。
- `LARK_ENCRYPT_KEY`：启用飞书 Encrypt Key 时配置，Cloud 将优先校验请求签名并处理加密事件。

生产环境建议另外显式配置持久化路径：

```env
TASK_DB_PATH=/absolute/path/to/bugbot-data/tasks.sqlite

# 可选；只允许指定飞书用户触发修复和清理，多个 open_id 用逗号分隔
FIX_ALLOWED_OPEN_IDS=ou_xxx,ou_yyy
```

`TASK_DB_PATH` 所在目录必须允许 Cloud 进程写入。不要使用 `:memory:`，否则 Cloud 重启后会丢失分析任务与修复任务的关联。

### 2.2 Worker

最小配置：

```env
CLOUD_URL=https://bugbot.example.com
AGENT_API_TOKEN=与Cloud完全相同的Token
REPO_PATH=/absolute/path/to/frontend-repo
```

推荐显式配置：

```env
FIX_WORKTREE_ROOT=/absolute/path/to/bugbot-workspaces
BUGBOT_GIT_NAME=BugBot
BUGBOT_GIT_EMAIL=bugbot@local
AGENT_PROVIDER_ORDER=codex,claude
```

同时确认：

- `REPO_PATH` 是有效 Git 仓库，Worker 进程对其及 `FIX_WORKTREE_ROOT` 有足够权限。
- Worker 运行环境能找到首选 Agent CLI，并且该 CLI 已完成认证。
- 目标项目使用的包管理器可用；首次准备修复 worktree 时可能需要安装依赖。
- `AGENT_API_TOKEN` 与 Cloud 一致。

## 3. 飞书后台配置

在飞书开放平台对应的企业自建应用中完成以下配置：

1. 添加机器人能力，申请 `im:message:send_as_bot` 权限，并将机器人加入目标群聊。
2. 打开“事件与回调”，添加卡片回调。
3. 选择新版 **卡片回传交互**：`card.action.trigger`。
4. 不要同时选择旧版 `card.action.trigger_v1`，否则一次点击可能产生新旧两次回调。
5. 将回调地址设为 Cloud 的公网 HTTPS 地址：

   ```text
   https://bugbot.example.com/callback/feishu/card
   ```

6. 将同一页面的 Verification Token 写入 Cloud 的 `LARK_VERIFICATION_TOKEN`。如果启用了 Encrypt Key，也将其写入 Cloud 的 `LARK_ENCRYPT_KEY`。
7. 保存配置，并按飞书后台要求发布应用版本，使配置和权限生效。

反向代理必须把该路径转发到 `code/` 服务，且不能改写请求体。使用 Encrypt Key 验签时，Cloud 必须收到原始请求体以及 `X-Lark-Request-Timestamp`、`X-Lark-Request-Nonce` 和 `X-Lark-Signature` 请求头。

## 4. 重启服务

修改 `.env` 后必须重启读取该配置的进程。使用仓库自带的 PM2 配置时：

```bash
# Cloud 配置变化
pm2 restart lark-h5-bug-bot-cloud

# Worker 配置变化
pm2 restart lark-h5-bug-bot-worker
```

只在 Cloud 服务器添加 `LARK_VERIFICATION_TOKEN` 时，不需要重启 Worker。已经发出的结果卡片不会自动补出按钮，需要重新发起一次分析任务。

## 5. “尝试修复”按钮出现条件

以下条件必须同时满足：

- Agent 返回的结构化分析状态为 `resolved`；中文结论看起来明确但状态为 `suspected` 时不会显示。
- 分析结果属于正常排队任务并带有 `taskId`。
- Cloud 配置了 `LARK_VERIFICATION_TOKEN` 或 `LARK_ENCRYPT_KEY`。
- Worker 在分析开始时成功上报了仓库快照。
- 分析时 `REPO_PATH` 工作区干净，即 `git status --porcelain` 没有输出。

绿色“自动查 Bug 结果”卡片只说明状态为 `resolved`。如果卡片为绿色但没有按钮，优先检查 Cloud 是否配置回调验证参数，以及目标仓库在分析开始时是否存在未提交或未跟踪文件。

## 6. 点击后能够执行修复的条件

按钮出现后，仍需满足：

- 飞书能够访问回调 URL，且回调 Token 或签名验证通过。
- 点击人的 `open_id` 在 `FIX_ALLOWED_OPEN_IDS` 中；未配置白名单时不额外限制。
- Cloud 中仍保留原分析任务及其仓库快照。
- 该分析任务从未创建过修复任务；重复点击只会返回已有任务提示。
- Worker 正在运行，并能通过 `CLOUD_URL` 和 `AGENT_API_TOKEN` 拉取任务。
- 分析记录的 Git 基线提交仍存在，目标仓库和 BugBot worktree 身份一致。
- `FIX_WORKTREE_ROOT` 没有被另一个活动修复任务占用。

修复只在 BugBot 专用 linked worktree 中进行，不直接修改 `REPO_PATH` 对应的开发者工作目录。完成后应在自己的开发分支执行卡片给出的 `git cherry-pick <commitSha>`，再进行人工验证。

## 7. 首次启用验收清单

- [ ] Cloud 和 Worker 使用相同的 `AGENT_API_TOKEN`。
- [ ] Cloud 使用持久化、可写的 `TASK_DB_PATH`。
- [ ] 飞书只添加新版 `card.action.trigger`。
- [ ] 回调 URL 指向 `/callback/feishu/card`，公网 HTTPS 可访问。
- [ ] Verification Token 已写入 Cloud 的 `.env`。
- [ ] 修改配置后已重启 Cloud。
- [ ] Worker 的 `REPO_PATH` 指向正确且干净的 Git 仓库。
- [ ] Worker 能找到并调用首选 Agent CLI。
- [ ] `FIX_WORKTREE_ROOT` 是 Worker 可写的绝对路径。
- [ ] 新任务返回 `resolved` 后，飞书结果卡片显示“尝试修复”。
- [ ] 点击按钮后卡片提示修复任务已创建，Worker 日志出现修复任务。
- [ ] 修复完成后收到分支、commit SHA、检查结果和 `git cherry-pick` 命令。

Worker 到 Cloud 的基础连通性可以在 `worker/` 目录检查：

```bash
pnpm healthcheck
```

## 8. 常见问题

### 结果卡片是绿色，但没有“尝试修复”

依次检查：

1. Agent 日志中的最终 JSON 是否确实为 `"status":"resolved"`。
2. Cloud 的 `.env` 是否配置 `LARK_VERIFICATION_TOKEN` 或 `LARK_ENCRYPT_KEY`。
3. 修改 Cloud `.env` 后是否重启了 Cloud 进程。
4. 分析开始时 `REPO_PATH` 是否存在未提交或未跟踪文件。
5. 该结果是否由正常任务产生并包含 `taskId`。

### 点击按钮后返回 401

Cloud 收到回调但验证失败。确认飞书后台和 Cloud 使用同一个 Verification Token；启用 Encrypt Key 时确认反向代理保留原始请求体和签名请求头。

### 点击按钮后返回 403

检查 `FIX_ALLOWED_OPEN_IDS`。配置白名单后，点击人的飞书 `open_id` 必须在列表中。

### 点击后提示任务已存在

同一个分析任务只允许创建一次修复任务，包括已经完成或失败的任务。需要基于最新代码重新分析并生成新的结果卡片。

### 点击成功，但 Worker 没有执行

检查 Worker 是否在线、`CLOUD_URL` 是否正确、两端 `AGENT_API_TOKEN` 是否一致，并运行 `pnpm healthcheck`。同时检查 Cloud 和 Worker 日志中是否有 401、网络连接或任务处理错误。

### 修复返回 `stale_analysis`

分析时记录的基线提交已经不可用或不再满足修复条件。保持目标仓库干净，在当前代码上重新发起分析。

### 修复返回 `workspace_conflict`

`FIX_WORKTREE_ROOT` 下已有目录属于其他仓库，或 worktree 身份校验失败。不要直接删除目录；先根据 Worker 日志核对 `REPO_PATH`、remote 和 workspace 元数据，确认目标后再处理。
