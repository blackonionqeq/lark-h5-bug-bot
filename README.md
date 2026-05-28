# 飞书 Bug Bot：禅道 Webhook + 自动 Bug 分析

基于 **TypeScript + Bun** 的 Bug 自动分析系统。禅道提交 bug 后，云端服务会先转发到飞书群聊；其中 **active** 状态的 bug 会额外入队分析任务，本地 Worker 再拉取任务，通过 Claude Code CLI 自动分析前端代码，将结论回传飞书群。

## 整体流程

```
禅道 webhook
    |
    v
云端 Elysia (code/)
    |-- 发送「收到 bug」到飞书群
    |-- 若状态为 active，则创建 AnalysisTask，存入任务队列
    v
本地 Worker (worker/)
    |-- 轮询拉取任务
    |-- 规则分诊：是否前端 bug？
    |      |-- 否 -> 回调云端：skipped
    |      |-- 是 -> 调用 Claude Code CLI 分析源码
    |-- 回调云端 /callback/analysis-result
    v
云端格式化结果 -> 发飞书群
```

## 项目结构

```
.
├── .env                    # 环境变量（仓库根目录）
├── code/                   # 云端服务
│   ├── src/
│   │   ├── index.ts
│   │   ├── config.ts
│   │   ├── types.ts
│   │   ├── routes/
│   │   │   ├── zentao.ts
│   │   │   ├── analysis-callback.ts
│   │   │   └── agent-tasks.ts       # Worker 任务 API
│   │   ├── services/
│   │   │   ├── event-processor.ts
│   │   │   ├── feishu.ts
│   │   │   ├── local-task.ts        # 事件入队
│   │   │   └── task-store.ts        # 内存任务队列
│   │   └── utils/
│   │       └── format-message.ts
│   └── package.json
└── worker/                 # 本地分析 Worker
    ├── src/
    │   ├── index.ts         # 轮询主循环
    │   ├── config.ts
    │   ├── poller.ts        # 云端 API 客户端
    │   ├── triage.ts        # 规则分诊
    │   ├── runner.ts        # Claude Code CLI 调用
    │   └── reporter.ts      # 回调云端
    ├── prompts/
    │   └── analyze-bug.txt  # 分析 prompt 模板
    └── package.json
```

## 技术栈

- Runtime: Bun
- Language: TypeScript
- HTTP framework: Elysia（云端）
- Package manager: pnpm

---

## 一、飞书侧准备

1. 登录飞书[开发者后台](https://open.feishu.cn/app)，创建企业自建应用。
2. 添加**机器人**能力。
3. 申请 API 权限：`im:message:send_as_bot`。
4. 创建版本并发布应用，使权限生效。
5. 将应用机器人添加到目标群聊中。

获取目标群聊 `chat_id`：参考[群 ID 说明](https://go.feishu.cn/s/64KYvl2N802)。

---

## 二、环境变量

在仓库根目录创建 `.env`：

```env
# 云端 + Worker 共用
APP_ID=your_app_id
APP_SECRET=your_app_secret
CHAT_ID=your_chat_id
PORT=3000
AGENT_API_TOKEN=your_secret_token

# Worker 专用
CLOUD_URL=https://your-domain.com
REPO_PATH=/path/to/frontend-repo
LOG_DIR=./logs
POLL_INTERVAL_MS=20000
TIMEOUT_SECONDS=600
MAX_TURNS=40
CLAUDE_MODEL=sonnet
CLAUDE_EXECUTABLE=claude
ENABLE_CODEX_FALLBACK=true
CODEX_EXECUTABLE=codex
CODEX_MODEL=
CODEX_SANDBOX=read-only
PRE_ANALYSIS_SCRIPT=./scripts/pre-analysis.sh
```

| 变量 | 必需 | 说明 |
|---|---|---|
| `APP_ID` | 云端必需 | 飞书应用 ID |
| `APP_SECRET` | 云端必需 | 飞书应用密钥 |
| `CHAT_ID` | 云端必需 | 目标飞书群 ID |
| `PORT` | 可选 | 云端监听端口，默认 `3000` |
| `AGENT_API_TOKEN` | 推荐 | Worker API 鉴权 token，未设置时 Agent API 不鉴权 |
| `CLOUD_URL` | Worker 必需 | 云端服务地址 |
| `REPO_PATH` | Worker 必需 | 待分析的前端项目路径 |
| `AGENT_API_TOKEN` | Worker 必需 | 同上，Worker 用于请求云端 |
| `LOG_DIR` | 可选 | Worker 日志目录，默认 `./logs` |
| `POLL_INTERVAL_MS` | 可选 | 轮询间隔（ms），默认 `20000` |
| `TIMEOUT_SECONDS` | 可选 | 单次 Agent CLI 超时（秒），默认 `600` |
| `MAX_TURNS` | 可选 | Claude Code 最大 turn 数，默认 `40` |
| `CLAUDE_MODEL` | 可选 | Claude Code 使用的模型，默认 `sonnet` |
| `CLAUDE_EXECUTABLE` | 可选 | Claude Code CLI 可执行文件名或绝对路径，默认 `claude` |
| `ENABLE_CODEX_FALLBACK` | 可选 | Claude Code 失败时是否尝试 Codex 无头模式，默认 `true`；设为 `false` 可关闭 |
| `CODEX_EXECUTABLE` | 可选 | Codex CLI 可执行文件名或绝对路径，默认 `codex` |
| `CODEX_MODEL` | 可选 | Codex CLI 使用的模型；为空时使用 Codex 默认配置 |
| `CODEX_SANDBOX` | 可选 | Codex exec sandbox，默认 `read-only` |
| `PRE_ANALYSIS_SCRIPT` | 可选 | 分析前执行的脚本，默认 `./scripts/pre-analysis.sh`；相对路径按 `worker/` 目录解析，脚本执行时的工作目录仍是 `REPO_PATH` |

---

## 三、启动

### 云端服务

```bash
cd code
pnpm install
pnpm start        # 生产
pnpm dev          # 开发（watch 模式）
pnpm typecheck    # 类型检查
```

### 本地 Worker

Worker 需要本机安装 Claude Code CLI，并且 `REPO_PATH` 指向的前端项目已 clone。默认通过 `PATH` 查找 `claude`；如果后台进程环境拿不到该命令，可通过 `CLAUDE_EXECUTABLE` 显式指定可执行文件名或绝对路径。

如果启用 Codex fallback，Worker 还需要安装并认证 Codex CLI。Claude Code 进程异常、超时、或 JSONL 结果不可解析时，Worker 会继续用 `codex exec --json` 无头模式分析；Claude 正常返回 `suspected`、`resolved` 或 `inconclusive` 时不会 fallback。

```bash
cd worker
pnpm install
pnpm start
pnpm healthcheck  # 手动诊断 Worker 到 CLOUD_URL 的 DNS/代理/HTTP 连通性
```

---

## 四、API 接口

### 禅道 Webhook

当前行为：所有禅道 bug webhook 都会通知到飞书群；仅 `active` 状态的 bug 会进入自动分析队列，非 `active` 状态不会进入队列。


```http
POST /webhook/zentao
```

```bash
curl -X POST "http://127.0.0.1:3000/webhook/zentao" \
  -H "Content-Type: application/json" \
  -d '{"id":"BUG-123","title":"登录失败","description":"点击登录按钮后白屏"}'
```

### 分析结果回调

```http
POST /callback/analysis-result
```

Worker 自动调用，也可手动测试：

```bash
curl -X POST "http://127.0.0.1:3000/callback/analysis-result" \
  -H "Content-Type: application/json" \
  -d '{"taskId":"t1","issueId":"BUG-123","status":"suspected","summary":"表单提交后 loading 未重置","reason":"finally 块缺少状态重置","files":["src/views/form.vue"]}'
```

### Worker 任务 API（需 Bearer token）

```http
GET  /agent/tasks/pending       # 拉取并认领一个待处理任务
POST /agent/tasks/:id/claim     # 显式认领任务
POST /agent/tasks/:id/result    # 提交中间/最终状态
```

注意：`pnpm healthcheck` 会带 `AGENT_API_TOKEN` 请求 `GET /agent/tasks/pending` 以验证鉴权链路，因此在有待处理任务时可能会认领一个任务。

---

## 五、部署

### 推荐目录结构

```bash
/opt/lark-h5-bug-bot/
├── .env
├── code/       # 云端服务
└── worker/     # 本地 Worker（可部署在不同机器）
```

### 云端

```bash
cd /opt/lark-h5-bug-bot/code
pnpm install && pnpm start
```

### Worker

```bash
cd /opt/lark-h5-bug-bot/worker
pnpm install && pnpm start
```

### 后台运行

```bash
# 云端
pm2 start "pnpm start" --name bug-bot-cloud --cwd /opt/lark-h5-bug-bot/code

# Worker
pm2 start "pnpm start" --name bug-bot-worker --cwd /opt/lark-h5-bug-bot/worker
```

### 打包上传

```bash
tar --exclude='*/node_modules' --exclude='.git' -czf lark-h5-bug-bot.tar.gz .
scp lark-h5-bug-bot.tar.gz your-user@your-server:/opt/
```

---

## 六、注意事项

1. 飞书消息存在限频，控制调用频率。
2. Worker 和云端可以部署在不同机器上，Worker 只需能访问云端的 HTTP 地址。
3. Worker 通过出站 HTTPS 请求拉取任务，不需要内网穿透。
4. Claude Code CLI 需要在 Worker 机器上安装并完成认证；若 pm2 或其他后台环境拿不到 `claude`，请设置 `CLAUDE_EXECUTABLE`。
5. 启用 Codex fallback 时，Codex CLI 也需要在 Worker 机器上安装并完成认证；若后台环境拿不到 `codex`，请设置 `CODEX_EXECUTABLE`。
6. 分诊为规则策略，默认将不确定的 bug 归类为前端，后续可按日志数据决定是否引入 LLM 分诊。

---

## 七、架构设计文档

- 架构设计 v3：`docs/architecture-proposal-v3.md`
- Claude Code 调用规范：`docs/worker-claude-invocation.md`
