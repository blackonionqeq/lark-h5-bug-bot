# Worker 调用 Claude Code CLI 规范

本文档定义本地 Worker 如何通过 Claude Code CLI 无头模式（`-p`）对前端 bug 进行自动分析。属于 [architecture-proposal-v3.md](./architecture-proposal-v3.md) §3.4 的细化。

## 1. 前提

### 1.1 项目配置复用

`claude -p` 默认加载目标项目的全部配置，与交互模式一致；Worker 如需使用其他可执行文件路径，可通过 `CLAUDE_EXECUTABLE` 覆盖。

| 配置项 | 是否生效 | 说明 |
|---|---|---|
| CLAUDE.md / `@import` | 是 | 项目上下文、代码结构说明 |
| `.claude/settings.json` | 是 | 权限、工具白名单、环境变量 |
| Skills（`.claude/skills/`） | 是（自动触发） | Claude 根据描述自行决定是否使用，不支持 `/slash` 手动调用 |
| Hooks | 是 | `PreToolUse`、`PostToolUse` 等正常触发 |
| Subagents（`.claude/agents/`） | 是 | Claude 自行决定何时委派 |
| MCP servers | 是 | 需在 settings 中启用 |

因此 Worker 不需要在 CLI 参数中重复定义分析逻辑——直接 `cd` 到前端项目目录运行即可。

如需完全隔离（不加载项目配置），传 `--bare`，并通过 `--append-system-prompt-file`、`--settings`、`--mcp-config` 等显式注入。当前阶段不建议这样做。

### 1.2 工作目录

Worker 必须在前端项目根目录下执行 Claude CLI 的 `-p` 模式，否则无法加载项目配置，Claude 也无法访问源码文件。默认执行 `claude -p`，也可通过 `CLAUDE_EXECUTABLE` 指向其他命令名或绝对路径。

```bash
cd /path/to/frontend-repo && "${CLAUDE_EXECUTABLE:-claude}" -p ...
```

## 2. Prompt 传递

### 2.1 问题

直接将 bug 描述内联在 `-p "..."` 中有风险：

- 中文内容、引号、换行符、`$` 等字符导致 shell 转义错误
- 长描述超过命令行参数长度限制

### 2.2 方案：临时文件 + `$(cat)` 读入

Worker 将 prompt 写入临时文件，通过 `$(cat)` 传递给 `-p`：

```bash
PROMPT_FILE=$(mktemp)
cat > "$PROMPT_FILE" << 'EOF'
prompt content here
EOF

claude -p "$(cat "$PROMPT_FILE")" --output-format stream-json
rm -f "$PROMPT_FILE"
```

好处：

- prompt 模板与 bug 数据分离
- 不受 shell 特殊字符影响
- 不浪费 Claude 的 tool turn 去 Read 文件

### 2.3 Prompt 模板

```text
你是一个前端 bug 排查员。下面是 bug 报告：

标题：{title}
描述：{description}

请在当前仓库中排查这个 bug：
1. 理解 bug 描述的预期行为和实际行为
2. 在代码中搜索相关组件、页面或逻辑
3. 定位最可能的原因

以如下 JSON 格式输出结论（不要包含其他内容）：
{
  "status": "suspected | resolved | inconclusive",
  "summary": "<一句话结论>",
  "reason": "<简要分析过程>",
  "files": ["<相关文件路径>"]
}
```

`{title}` 和 `{description}` 由 Worker 的 `runner.ts` 在写入临时文件时替换。

> 注意：前端项目的 CLAUDE.md 已提供代码结构和约定上下文，prompt 中不需要重复这些信息。

## 3. CLI 参数

```bash
timeout 300 "${CLAUDE_EXECUTABLE:-claude}" -p "$(cat "$PROMPT_FILE")" \
  --output-format stream-json \
  --max-turns 20 \
  --model sonnet
```

### 参数说明

| 参数 | 值 | 说明 |
|---|---|---|
| `--output-format` | `stream-json` | JSONL 事件流，兼顾结果解析和审计（见 §4） |
| `--max-turns` | `20` | 分析一个 bug 通常 10-15 turn，20 留有余量且防止失控 |
| `--model` | `sonnet` | 性价比优先；可按需切换为 `opus`（更强分析能力） |
| `timeout` | `300`（5 分钟） | 外部超时兜底，Claude CLI 自身无超时参数 |

其中 `CLAUDE_EXECUTABLE` 可选，默认值为 `claude`；当 Worker 运行在 pm2、launchd 或其他拿不到交互 shell `PATH` 的环境时，建议显式配置为 Claude Code CLI 的绝对路径。

### 关于工具权限

工具白名单优先在前端项目的 `.claude/settings.json` 中配置（`permissions.allow`），而非 CLI 参数。这样开发者日常使用和 Worker 自动分析共享同一套权限规则。

如果需要 Worker 场景下的额外限制，可在 CLI 中追加 `--allowedTools` 覆盖。

## 4. 输出与日志

### 4.1 输出格式对比

| 格式 | 内容 | 适用场景 |
|---|---|---|
| `text` | 纯文本最终回复 | 最简单，但需从文本中提取 JSON |
| `json` | 单个 JSON 对象 | 解析方便，但无中间过程 |
| `stream-json` | 逐行 JSONL 事件流 | 包含每个 tool call、思考过程、最终结果 |

选择 `stream-json` 的理由：**一份输出同时满足结果解析和审计回溯**。

### 4.2 JSONL 日志

输出直接写入日志文件，按 `taskId` 命名：

```bash
LOG_FILE="${LOG_DIR}/${TASK_ID}.jsonl"
timeout 300 "${CLAUDE_EXECUTABLE:-claude}" -p "..." --output-format stream-json > "$LOG_FILE" 2>&1
```

日志内容包含：

- `system` 事件：加载了哪些配置、MCP servers
- `tool_use` 事件：每次工具调用的名称、参数
- `tool_result` 事件：工具返回值
- `assistant` 事件：Claude 的思考和回复
- `result` 事件：最终输出

### 4.3 结果提取

Worker 的 `reporter.ts` 从 JSONL 日志的最后一个 `result` 类型事件中提取分析结论：

```ts
function extractResult(logFile: string): AnalysisResult {
  const lines = fs.readFileSync(logFile, "utf-8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const event = JSON.parse(lines[i]);
    if (event.type === "result") {
      return JSON.parse(event.result);
    }
  }
  return { status: "failed", summary: "无法提取分析结果", reason: "JSONL 中未找到 result 事件", files: [] };
}
```

> 注意：`event.result` 是 Claude 的文本输出，其中包含 JSON 格式的分析结论，需要二次解析。如果 Claude 的输出不是合法 JSON（如混入了额外文字），做容错处理后返回 `failed`。

### 4.4 不需要额外 Hook 做审计

`stream-json` 的 JSONL 已包含完整的工具调用记录，无需通过 `PostToolUse` hook 重复记录。

Hook 的价值在于**干预**而非**记录**：

- `PreToolUse`：拦截意外的写操作（虽然已限制只读）
- `PostToolUse`：向云端上报实时进度（如有需要）

## 5. 退出码处理

| 退出码 | 含义 | Worker 行为 |
|---|---|---|
| `0` | 正常完成 | 解析 JSONL，提取结果，回调云端 |
| `124` | `timeout` 超时 | 回调云端 `status: "failed"`，reason: "分析超时" |
| 非零（非 124） | Claude CLI 内部错误 | 回调云端 `status: "failed"`，附带退出码和 stderr |

## 6. 完整脚本

```bash
#!/bin/bash
set -euo pipefail

TASK_ID="$1"
TITLE="$2"
DESCRIPTION="$3"
REPO_PATH="$4"
LOG_DIR="$5"
CLAUDE_EXECUTABLE="${CLAUDE_EXECUTABLE:-claude}"

PROMPT_FILE=$(mktemp)
LOG_FILE="${LOG_DIR}/${TASK_ID}.jsonl"

mkdir -p "$LOG_DIR"

# --- 生成 prompt ---
cat > "$PROMPT_FILE" << PROMPT_EOF
你是一个前端 bug 排查员。下面是 bug 报告：

标题：${TITLE}
描述：${DESCRIPTION}

请在当前仓库中排查这个 bug：
1. 理解 bug 描述的预期行为和实际行为
2. 在代码中搜索相关组件、页面或逻辑
3. 定位最可能的原因

以如下 JSON 格式输出结论（不要包含其他内容）：
{"status":"suspected|resolved|inconclusive","summary":"...","reason":"...","files":["..."]}
PROMPT_EOF

# --- 执行分析 ---
cd "$REPO_PATH"
timeout 300 "$CLAUDE_EXECUTABLE" -p "$(cat "$PROMPT_FILE")" \
  --output-format stream-json \
  --max-turns 20 \
  --model sonnet \
  > "$LOG_FILE" 2>&1

EXIT_CODE=$?

# --- 清理 ---
rm -f "$PROMPT_FILE"

exit $EXIT_CODE
```

Worker 的 `runner.ts` 通过 `child_process.spawn` 调用此脚本，根据退出码和 JSONL 日志构造回调 payload。

## 7. 后续扩展点

- **模型切换**：通过环境变量 `CLAUDE_MODEL` 控制，脚本中改为 `--model "${CLAUDE_MODEL:-sonnet}"`
- **命令路径覆盖**：通过环境变量 `CLAUDE_EXECUTABLE` 控制 Claude Code CLI 的命令名或绝对路径
- **并发控制**：Phase 1 单并发（一次只运行一个脚本实例），Phase 2 可用信号量控制并发数
- **Prompt 迭代**：模板外置为独立文件（如 `worker/prompts/analyze-bug.txt`），方便调整而不改代码
- **进度上报**：如需实时进度，Worker 可流式读取 JSONL 并在 `tool_use` 事件时向云端 POST 中间状态
