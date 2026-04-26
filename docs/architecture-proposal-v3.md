# Bug 自动分析架构设计 — 第三方视角

## 1. 现状

```
禅道 webhook ──→ 云端 Elysia ──→ 飞书群
                      │
                      └── local-task.ts (空 stub)
```

两条已有路由：
- `POST /webhook/zentao` — 接收 bug，格式化，发飞书
- `POST /callback/analysis-result` — 接收异步结果，发飞书

`local-task.ts` 是预留的扩展点，目前只打日志。

## 2. 目标流程

```
禅道 webhook
    │
    ▼
云端 Elysia
    ├── 立即发送「收到 bug」到飞书群（已有逻辑）
    └── 创建 AnalysisTask，存入任务队列
                │
                ▼
本地 Worker（轮询云端）
    ├── 拉取待处理任务
    ├── 分诊：是否为前端 bug？
    │       ├── 否 → 回调云端：skipped
    │       └── 是/不确定 → 调用 Claude Code CLI
    │                           └── 分析源码，输出结论
    └── 回调云端 /callback/analysis-result
                │
                ▼
        云端格式化结果 → 发飞书群
```

## 3. 关键设计决策

### 3.1 Worker 拉取，而非云端推送

Worker 主动轮询云端任务 API，云端不主动连接本地。

原因：
- 本地机器在 NAT 后面，推送需要持久隧道，增加一个运维负担和故障点
- 拉取模式下，worker 自己控制节奏、并发、生命周期
- 云端不需要知道 worker 是否在线
- 鉴权更简单：worker 持有一个 API token 即可

**关于内网穿透**：在拉取模式下，worker 对云端发的是标准出站 HTTPS 请求，不需要内网穿透。云端已经有公网地址（否则禅道 webhook 也打不进来）。内网穿透只在云端需要主动连接本地时才需要——拉取模式不存在这个需求。

### 3.2 任务存储：内存 Map → SQLite

Phase 1 用内存 Map，接口设计为可替换。

```ts
interface TaskStore {
  enqueue(task: AnalysisTask): void;
  claim(): AnalysisTask | null;
  update(taskId: string, patch: Partial<AnalysisTask>): void;
  get(taskId: string): AnalysisTask | undefined;
}
```

内存 Map 的风险是服务重启丢任务。但 bug 不是高频事件（一天几个到几十个），丢一两个可以接受。Phase 2 换 SQLite（Bun 内置 `bun:sqlite`，零额外依赖）。

### 3.3 分诊策略："是否前端 bug"

这是这套架构里最值得讨论的决策点。三种方案：

#### 方案 A：纯规则

用关键词正则匹配标题和描述。

```ts
const FRONTEND_SIGNALS = [
  /页面/, /样式/, /布局/, /渲染/, /显示/, /UI/,
  /按钮/, /点击/, /弹窗/, /表单/, /输入/, /下拉/,
  /前端/, /浏览器/, /兼容/, /控制台/, /console/,
  /loading/, /闪/, /白屏/, /刷新/, /滚动/, /适配/,
];

const BACKEND_SIGNALS = [
  /接口/, /API/, /数据库/, /SQL/, /后端/, /服务端/,
  /nginx/, /服务器/, /部署/, /定时任务/, /队列/,
  /redis/, /缓存/, /权限.{0,4}(配置|错误)/, /docker/,
];
```

计分逻辑：前端信号 +1，后端信号 -1。正分 → frontend，负分 → non-frontend，零分 → uncertain。uncertain 默认当 frontend 处理。

- 优点：零延迟，零成本，确定性强，可调试
- 缺点：对语义变体覆盖有限（"操作后没反应"是前端还是后端？）

#### 方案 B：轻量 LLM 分诊

单独调用一个便宜的 LLM（如 Claude Haiku）做分类。

```
输入：bug 标题 + 描述
输出：{ label: "frontend" | "non-frontend" | "uncertain", reason: string }
```

- 优点：语义理解能力强，覆盖面广
- 缺点：增加一个 API 依赖、一个延迟源、一个故障点

#### 方案 C：规则前置 + LLM 兜底

规则先过一遍，高置信度的直接判定。不确定的交给 LLM。

- 优点：高置信样本走规则（快），边缘样本走 LLM（准）
- 缺点：两套逻辑要维护

#### 我的建议：Phase 1 用纯规则 + 宽松默认值，Phase 2 按数据决定是否加 LLM

核心论点：**误判的代价不对称。**

- 假阳性（非前端 bug 被当成前端处理）：Claude Code 分析几分钟后说 "inconclusive"，群里收到一条"无法定位"消息。代价：几分钟计算时间。
- 假阴性（前端 bug 被跳过）：群里收到一条"已跳过，非前端问题"消息。测试看到后可以手动反馈或重新提交。代价：一次人工介入。

两种误判的代价都很低。所以分诊的精度要求没有想象中高。

具体做法：
1. 规则扫描标题和描述
2. 有明确后端信号且无前端信号 → `non-frontend`
3. 其余所有情况（包括没有任何信号的）→ `frontend`
4. 每次分诊结果都记录日志（标题、描述、判定、命中规则）
5. 运行 1-2 周后，回看日志，如果误判率不可接受，再加 LLM 步骤

**关于"不用 LLM 能否判断"的回答**：能，但上限有限。纯规则在描述风格稳定的团队里能覆盖 80-90% 的情况。剩下 10-20% 的边缘样本，即使用 LLM 也不一定判对。在当前阶段（单项目、低频次），纯规则 + 宽松默认值是足够的起步策略。

### 3.4 Claude Code 调用

Worker 通过 CLI 非交互模式调用 Claude Code，指向本地的前端项目仓库：

```bash
claude -p "<prompt>" \
  --output-format json \
  --max-turns 30 \
  --allowedTools "Read,Grep,Glob,Bash(read-only commands)"
```

Prompt 结构：

```
你是一个前端 bug 排查员。下面是一个 bug 报告：

标题：{title}
描述：{description}

请在 {repoPath} 仓库中排查这个 bug：
1. 理解 bug 描述的预期行为和实际行为
2. 在代码中搜索相关组件、页面或逻辑
3. 定位最可能的原因

以如下 JSON 格式输出结论：
{
  "status": "suspected" | "resolved" | "inconclusive",
  "summary": "<一句话结论>",
  "reason": "<简要分析过程>",
  "files": ["<相关文件路径>"]
}
```

约束：
- `--max-turns 30` 防止无限运行
- 工具白名单限制为只读操作
- 超时设置（建议 5 分钟）
- 结果解析失败时返回 `failed` 状态

### 3.5 回调格式

Worker 将结果 POST 到云端已有的 `/callback/analysis-result`：

```json
{
  "taskId": "zentao-1714000000000-abc123",
  "issueId": "BUG-456",
  "traceId": "zentao-1714000000000-abc123",
  "status": "suspected",
  "summary": "表单提交后 loading 状态未重置",
  "reason": "src/views/order-form.vue:142 finally 块缺少状态重置",
  "triageLabel": "frontend",
  "triageSource": "rules",
  "files": ["src/views/order-form.vue"]
}
```

### 3.6 安全边界

- Worker API 端点用 `AGENT_API_TOKEN` 鉴权
- Claude Code 只读，不修改代码
- 每个任务独立日志，按 traceId 追踪
- 单并发（同一时间只处理一个 bug）

## 4. 代码变更范围

### 云端（code/ 下）

| 文件 | 变更 |
|---|---|
| `code/src/types.ts` | 新增 `AnalysisTask`、`TriageResult` 类型 |
| `code/src/services/task-store.ts` | **新建**，内存 Map 实现的任务队列 |
| `code/src/routes/agent-tasks.ts` | **新建**，Worker 面向的任务 API |
| `code/src/services/event-processor.ts` | 修改 `handleEvent`，Zentao 事件入队 |
| `code/src/services/local-task.ts` | 改为调用 `taskStore.enqueue()` |
| `code/src/utils/format-message.ts` | 更新，支持结构化分析结果的格式化 |
| `code/src/index.ts` | 挂载新路由 |

### 新增路由

```
GET  /agent/tasks/pending     → 返回一个待处理任务（或 null）
POST /agent/tasks/:id/claim   → Worker 认领任务
POST /agent/tasks/:id/result  → Worker 提交中间状态
```

回调仍使用已有的 `POST /callback/analysis-result`。

### 本地（worker/ 下，新建目录）

```
worker/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts          # 入口：轮询主循环
│   ├── config.ts         # 环境变量加载
│   ├── poller.ts         # 拉取和认领任务
│   ├── triage.ts         # 规则分诊
│   ├── runner.ts         # Claude Code CLI 调用
│   └── reporter.ts       # 回调云端
└── logs/                 # 运行日志（gitignore）
```

### 数据模型

```ts
interface AnalysisTask {
  taskId: string;
  traceId: string;
  issueId?: string | number;
  title?: string;           // bug 标题，供分诊用
  description?: string;     // bug 描述，供分诊用
  status: "queued" | "claimed" | "running" | "completed" | "failed";
  triageResult?: TriageResult;
  analysisResult?: AnalysisResult;
  createdAt: string;
  updatedAt: string;
}

interface TriageResult {
  label: "frontend" | "non-frontend";
  source: "rules" | "llm" | "rules+llm";
  reason: string;
  matchedRules?: string[];
}

interface AnalysisResult {
  status: "suspected" | "resolved" | "inconclusive" | "skipped";
  summary: string;
  reason: string;
  files?: string[];
}
```

注意：任务状态（`queued → claimed → running → completed/failed`）和分析结论（`suspected/resolved/inconclusive/skipped`）是两个独立维度。

## 5. 分阶段实施

### Phase 1（最小可用）

- 云端：任务队列（内存）+ Worker API + 结果格式化
- Worker：轮询 + 规则分诊 + Claude Code 调用 + 回调
- 单并发，5 分钟超时
- 分诊日志记录

### Phase 2（验证后）

- 任务存储迁移到 SQLite
- 根据分诊日志数据决定是否引入 LLM 分诊
- 任务超时重试
- Worker 健康检查

### Phase 3（按需）

- 多项目支持
- 多 Agent 适配（Codex、Cursor）
- 消息队列替换轮询

## 6. 一句话总结

云端只管接单、存任务、转结果；本地 Worker 主动拉任务、做分诊、跑 Claude Code；不需要内网穿透；分诊从规则开始，拿数据说话再决定要不要加 LLM。
