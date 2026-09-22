# 飞书 Bug Bot：禅道 Webhook + 自动 Bug 分析

基于 **TypeScript + Bun** 的 Bug 自动分析系统。禅道提交 bug 后，云端服务会先转发到飞书群聊；其中 **active** 状态的 bug 会额外入队分析任务，本地 Worker 再拉取任务，通过配置的 Agent CLI 自动分析前端代码，将结论回传飞书群。

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
    |      |-- 是 -> 按配置顺序调用 Codex / Claude Code CLI 分析源码
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
    │   ├── runner.ts        # Agent CLI 调用
    │   └── reporter.ts      # 回调云端
    ├── prompts/
    │   ├── analyze-bug.txt                 # 通用分析 prompt 模板
    │   └── project-context.example.md      # 项目补充提示词示例
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
AGENT_PROVIDER_ORDER=codex,claude
ENABLE_CODEX_FALLBACK=true
CODEX_EXECUTABLE=codex
CODEX_MODEL=
CODEX_SANDBOX=read-only
PRE_ANALYSIS_SCRIPT=./scripts/pre-analysis.sh
# 可选；Bash 可执行文件名或绝对路径，Windows 会自动查找 Git Bash
BASH_EXECUTABLE=
# 可选；未设置时尝试读取 worker/prompts/project-context.local.md
PROJECT_CONTEXT_FILE=
```

| 变量 | 必需 | 说明 |
|---|---|---|
| `APP_ID` | 云端必需 | 飞书应用 ID |
| `APP_SECRET` | 云端必需 | 飞书应用密钥 |
| `CHAT_ID` | 云端必需 | 目标飞书群 ID |
| `PORT` | 可选 | 云端监听端口，默认 `3000` |
| `AGENT_API_TOKEN` | 推荐 | Worker API 鉴权 token，未设置时 Agent API 不鉴权 |
| `CLOUD_URL` | Worker 必需 | 云端服务地址 |
| `REPO_PATH` | Worker 必需 | 待分析的前端项目路径；相对路径按仓库根目录（根目录 `.env` 所在目录）解析 |
| `AGENT_API_TOKEN` | Worker 必需 | 同上，Worker 用于请求云端 |
| `LOG_DIR` | 可选 | Worker 日志目录，默认 `./logs` |
| `POLL_INTERVAL_MS` | 可选 | 轮询间隔（ms），默认 `20000` |
| `TIMEOUT_SECONDS` | 可选 | 单次 Agent CLI 超时（秒），默认 `600` |
| `MAX_TURNS` | 可选 | Claude Code 最大 turn 数，默认 `40` |
| `CLAUDE_MODEL` | 可选 | Claude Code 使用的模型，默认 `sonnet` |
| `CLAUDE_EXECUTABLE` | 可选 | Claude Code CLI 可执行文件名或绝对路径，默认 `claude` |
| `AGENT_PROVIDER_ORDER` | 可选 | Agent CLI 优先级，逗号分隔，支持 `codex` 和 `claude`；默认 `codex,claude` |
| `ENABLE_CODEX_FALLBACK` | 可选 | 兼容旧配置；未设置 `AGENT_PROVIDER_ORDER` 时，设为 `false` 会只运行 Claude |
| `CODEX_EXECUTABLE` | 可选 | Codex CLI 可执行文件名或绝对路径，默认 `codex` |
| `CODEX_MODEL` | 可选 | Codex CLI 使用的模型；为空时使用 Codex 默认配置 |
| `CODEX_SANDBOX` | 可选 | Codex exec sandbox，默认 `read-only` |
| `PRE_ANALYSIS_SCRIPT` | 可选 | 分析前通过 Bash 执行的脚本，默认 `./scripts/pre-analysis.sh`；相对路径按 `worker/` 目录解析，脚本执行时的工作目录仍是 `REPO_PATH` |
| `BASH_EXECUTABLE` | 可选 | Bash 可执行文件名或绝对路径；Windows 会从 Git for Windows 常见安装目录和 PATH 自动查找 |
| `PROJECT_CONTEXT_FILE` | 可选 | 项目补充提示词路径；相对路径按 `worker/` 目录解析。显式配置后文件必须存在 |

### 项目提示词配置

Worker 将受版本控制的通用模板与本机项目补充说明组装成最终提示词：

- `worker/prompts/analyze-bug.txt` 维护所有项目共用的只读调查规则、Bug 输入位置和 JSON 输出契约。
- `worker/prompts/project-context.local.md` 维护当前 `REPO_PATH` 对应项目的 Skill、Agent、模块索引和专属背景。该文件已被 Git 忽略。
- `worker/prompts/project-context.example.md` 是可提交的填写示例，不会自动注入分析。

首次配置可以复制示例文件，再按目标项目修改：

```bash
cd worker
cp prompts/project-context.example.md prompts/project-context.local.md
```

未配置 `PROJECT_CONTEXT_FILE` 时，Worker 会尝试读取上述默认本地文件；文件不存在则只使用通用模板。设置 `PROJECT_CONTEXT_FILE` 后，路径可以是绝对路径，也可以是相对 `worker/` 的路径；显式指定的文件无法读取时，本次分析会失败并报告配置错误，避免项目上下文被静默遗漏。

Claude 和 Codex 共用组装后的完整提示词，因此 Provider fallback 不会丢失项目背景。项目补充文件不要重复通用 JSON 输出契约，也不要存放密钥。后续经验召回会在同一个组装流程中注入有界的经验摘要。

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

Worker 需要本机安装 `AGENT_PROVIDER_ORDER` 中配置的 Agent CLI，并且 `REPO_PATH` 指向的前端项目已 clone。默认优先运行 Codex，再在失败时尝试 Claude Code；如果后台进程环境拿不到命令，可通过 `CODEX_EXECUTABLE` 或 `CLAUDE_EXECUTABLE` 显式指定可执行文件名或绝对路径。

Codex 使用 `codex exec --json` 无头模式分析。当前 provider 进程异常、超时、或 JSONL 结果不可解析时，Worker 会继续尝试 `AGENT_PROVIDER_ORDER` 中的下一个 provider；正常返回 `suspected`、`resolved` 或 `inconclusive` 时不会继续 fallback。

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

支持两种 payload 形态，任选其一：

**① 禅道原生格式**（标准禅道开箱即用，`action` 会映射成内部状态：`opened`/`edited`/`assigned`/… → `active` 入队，`resolved`/`closed`/`deleted` → 只通知不入队）

```bash
curl -X POST "http://127.0.0.1:3000/webhook/zentao" \
  -H "Content-Type: application/json" \
  -d '{"objectType":"bug","objectID":5,"product":",1,","action":"opened","actor":"admin","date":"2026-09-22 23:09:16","comment":"","text":"admin创建了Bug [#5::[白屏]页面白屏](http://zentao.example.com/bug-view-5.html)"}'
```

**② 自定义「标签文本」格式**（禅道 webhook 内容模板改成下面的样子，字段最全，标签优先级高于原生字段）

```bash
curl -X POST "http://127.0.0.1:3000/webhook/zentao" \
  -H "Content-Type: application/json" \
  -d '{"text":"📝 BUG标题：页面白屏\n🆔 BUG编号：#80407\n📊 BUG状态：active\n📋 重现步骤：1. 登录\n2. 进入首页\n🔗 详情链接：http://zentao.example.com/bug-view-80407.html"}'
```

> ⚠️ 两种形态下**都必须能解析出 BUG 编号**（原生看 `objectID`，标签看 `BUG编号`），否则返回
> `{"success":false,"message":"无法解析禅道 webhook 内容"}`，并且**禅道 webhook 日志会原样显示这个响应体**。

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
4. `AGENT_PROVIDER_ORDER` 中配置的 Agent CLI 需要在 Worker 机器上安装并完成认证；若 pm2 或其他后台环境拿不到命令，请设置 `CLAUDE_EXECUTABLE` 或 `CODEX_EXECUTABLE`。
5. 默认 `AGENT_PROVIDER_ORDER=codex,claude`，需要 Claude Code 优先时改为 `claude,codex`；只想运行单个 provider 时可设为 `codex` 或 `claude`。
6. 分诊为规则策略，默认将不确定的 bug 归类为前端，后续可按日志数据决定是否引入 LLM 分诊。

---

## 七、架构设计文档

- 架构设计 v3：`docs/architecture-proposal-v3.md`
- Claude Code 调用规范：`docs/worker-claude-invocation.md`
