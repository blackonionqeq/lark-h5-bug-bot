# Worker Testing Guide

## Quick start

```bash
cd worker
pnpm test
```

No `.env` file needed — tests use hardcoded fixture data.

## Test runner

Uses Bun's built-in test runner (`bun:test`). Jest-compatible API: `describe`, `it`, `expect`, `beforeEach`, `spyOn`.

## Test structure

```
worker/src/
├── test-fixtures.ts          # Shared factory functions for test data
├── config.ts                 # getConfig() accepts overrides for testing
└── __tests__/
    ├── triage.test.ts
    ├── poller.test.ts
    ├── runner.test.ts
    └── reporter.test.ts
```

## Config in tests

```ts
import { getConfig } from "../config";

const config = getConfig({
  cloudUrl: "http://localhost:9999",
  agentApiToken: "test-token",
  repoPath: "/tmp/test-repo",
});
```

When `overrides` is passed, `getConfig()` skips reading `Bun.env` entirely.

## Fixtures

Import factories from `test-fixtures.ts`:

```ts
import { makeAnalysisTask, makeTriageResult, makeAnalysisResult } from "../test-fixtures";
```

Each factory returns a complete, valid object. All fields are overridable:

```ts
const result = makeAnalysisResult({ status: "resolved" });
```

## Mocking external calls

### HTTP calls (poller, reporter)

```ts
import { spyOn } from "bun:test";

spyOn(globalThis, "fetch").mockImplementation(() =>
  Promise.resolve(new Response(JSON.stringify({ task: null })))
);
```

### Agent CLI (runner)

`runClaudeAnalysis()` remains as a compatibility alias for `runAgentAnalysis()`. It accepts an optional `deps` argument so tests can stub the process boundary without replacing filesystem behavior globally. Prefer overriding `spawn` and timer functions there:

```ts
import { mock } from "bun:test";
import { runClaudeAnalysis } from "../src/runner";
import { makeWorkerConfig } from "../src/test-fixtures";

await runClaudeAnalysis("title", "desc", "task-1", makeWorkerConfig(), {
  spawn: () => ({
    exited: Promise.resolve(0),
    stdout: new ReadableStream({ /* ... */ }),
    stderr: new ReadableStream({ /* ... */ }),
    kill: mock(() => {}),
  }),
  setTimeoutFn: () => ({ id: "timeout-1" }),
  clearTimeoutFn: mock(() => {}),
});
```

Current runner tests cover:

- successful execution with parsed JSONL result and log write
- Codex-first execution when `AGENT_PROVIDER_ORDER=codex,claude`
- Codex failure with Claude fallback
- Claude non-zero exit with Codex fallback
- Claude parse failure with Codex fallback
- combined failure when both Claude and Codex fail
- non-zero exit with stderr-only output when fallback is disabled
- timeout-triggered process kill

## Runtime logs and troubleshooting

Worker startup and runtime logs are printed to stdout.

## PM2 operations

The worker can be managed by PM2 using the repository-level `ecosystem.config.cjs`.

Use the helper script from the repository root:

```bash
./scripts/worker-pm2.sh start
./scripts/worker-pm2.sh status
./scripts/worker-pm2.sh logs
./scripts/worker-pm2.sh logs100
./scripts/worker-pm2.sh restart
./scripts/worker-pm2.sh stop
./scripts/worker-pm2.sh delete
./scripts/worker-pm2.sh save
./scripts/worker-pm2.sh startup
```

After changing environment variables in `../.env`, restart the worker:

```bash
./scripts/worker-pm2.sh restart
```

To enable startup after machine reboot, run:

```bash
./scripts/worker-pm2.sh startup
```

Then copy and execute the `sudo ...` command printed by PM2, and save the current process list again:

```bash
./scripts/worker-pm2.sh save
```

### Log rotation

There is currently no application-side log rotation.

- PM2 captures stdout/stderr under `~/.pm2/logs/`.
- Agent raw JSONL output is written per task under `LOG_DIR` as `<taskId>-claude.jsonl` or `<taskId>-codex.jsonl`. When fallback runs, inspect both provider logs.
- `LOG_DIR` defaults to `./logs` relative to `worker/` unless overridden in `.env`.

If PM2 logs need rotation, install and configure PM2's logrotate module:

```bash
./scripts/worker-pm2.sh logrotate
```

This configures:

- `max_size`: `10M`
- `retain`: `14`
- `compress`: `true`
- `rotateInterval`: `0 0 * * *`

This only rotates PM2 stdout/stderr logs. It does not clean up the per-task JSONL files under `LOG_DIR`.

### 1. Startup config

When the worker starts, it prints the basic config:

```txt
=== Bug 分析 Worker 启动 ===
云端地址: ...
分析仓库: ...
日志目录: ...
轮询间隔: ...
Agent 顺序: codex -> claude
Claude 模型: ...
Claude CLI: ...
Codex CLI: ...
超时: ...
```

Source: `worker/src/index.ts:10-20`

If these lines do not appear, the worker process did not start successfully.

### 2. Polling for tasks

When no task is available:

```txt
[worker] 无待处理任务, 2026-...
```

When a task is claimed:

```txt
[worker] 认领任务: <taskId>, issueId: <issueId>
```

Source: `worker/src/index.ts:26-32`

If polling itself fails, the worker prints:

```txt
[poller] 拉取任务失败: url=https://cloud.example.com/agent/tasks/pending status=522 proxy=https_proxy=http://127.0.0.1:7890/ headers=server:cloudflare,cf-ray:...
```

The diagnostic line includes the target URL, HTTP status, proxy environment summary, selected response headers, and a short response body snippet.

Source: `worker/src/poller.ts`, `worker/src/net-diagnostics.ts`

Common meanings:
- `401`: `AGENT_API_TOKEN` mismatch between cloud and worker
- `404` / `500`: cloud route missing or cloud service error
- `522`: Cloudflare reached the edge but timed out connecting to the origin; also check worker-side proxy/DNS if the proxy field is set

For a manual connectivity check from the worker machine:

```bash
cd worker
pnpm healthcheck
```

`pnpm healthcheck` prints DNS results, proxy settings, and unauthenticated/authenticated pending-task responses. The authenticated check calls `GET /agent/tasks/pending`, so it can claim a queued task.

### 3. Triage stage

After claiming a task, the worker prints the triage result:

```txt
[worker] 分诊结果: frontend — ...
```

or:

```txt
[worker] 分诊结果: non-frontend — ...
[worker] 非前端 bug，跳过分析
```

Source: `worker/src/index.ts:35-45`

If a bug is classified as `non-frontend`, agent analysis will be skipped.

### 4. Agent analysis stage

When analysis starts, the runner prints:

```txt
[runner] 启动分析, taskId=...
[runner] 工作目录: ...
[runner] Agent 顺序: codex -> claude
[runner] 启动 codex 分析, taskId=...
[runner] codex 日志文件: ...
```

This means the task has passed triage and the worker is invoking the first provider from `AGENT_PROVIDER_ORDER`.

If the current provider exits abnormally, the worker prints:

```txt
[runner] Codex CLI 退出码: ...
[runner] stderr: ...
```

If another provider is configured, the worker then prints:

```txt
[runner] Codex 分析失败，尝试 Claude: ...
[runner] 启动 claude 分析, taskId=...
[runner] claude 日志文件: ...
```

If a provider times out, the worker prints:

```txt
[runner] codex 分析超时 (...s), 正在终止进程
[runner] codex 分析超时或被终止
```

### 5. Analysis result and log file

When analysis finishes, the worker prints:

```txt
[worker] 分析结果: suspected|resolved|inconclusive|failed — ...
[worker] 日志: <logPath>
```

Source: `worker/src/index.ts:72-73`

The `logPath` file contains the raw JSONL output for the provider that produced the returned result. If fallback ran, inspect both `<taskId>-claude.jsonl` and `<taskId>-codex.jsonl` under `LOG_DIR`.

If the CLI ran but returned an empty result, the task may end with a failed result such as:

```txt
[worker] 分析结果: failed — 分析结果为空，请检查模型唤起是否异常
```

If the CLI returned text but not the required JSON object, the task may end with:

```txt
[worker] 分析结果: failed — 分析结果格式不正确
```

### 6. Callback to cloud

Before reporting the result back to cloud:

```txt
[reporter] 回调云端: <cloudUrl>/callback/analysis-result
```

On success:

```txt
[reporter] 回调成功
```

On failure:

```txt
[reporter] 回调失败: HTTP ...
```

Source: `worker/src/reporter.ts:21-32`

### 7. Final task status update

When the worker writes final status back to the cloud task API and the request fails, it prints:

```txt
[poller] 提交结果失败: url=https://cloud.example.com/agent/tasks/<taskId>/result status=...
```

Source: `worker/src/poller.ts`, `worker/src/net-diagnostics.ts`

If the whole task finishes normally, the worker prints:

```txt
[worker] 任务完成: <taskId>
```

Source: `worker/src/index.ts:84`

### 8. Fast diagnosis checklist

- Repeated `HTTP 401` while polling:
  - check `AGENT_API_TOKEN` on both cloud and worker
- Task is claimed but no runner logs appear:
  - check whether triage classified it as `non-frontend`
- Runner starts but exits non-zero:
  - inspect CLI stderr and local Claude/Codex auth/runtime
- Result is `failed` with empty-result or parse-format error:
  - inspect the worker JSONL files under `LOG_DIR`
- Callback fails:
  - check cloud service health and `/callback/analysis-result`
