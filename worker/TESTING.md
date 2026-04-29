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

### Claude CLI (runner)

`runClaudeAnalysis()` accepts an optional `deps` argument so tests can stub the process boundary without replacing filesystem behavior globally. Prefer overriding `spawn` and timer functions there:

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
- non-zero exit with stderr capture
- non-zero exit with stderr-only output
- timeout-triggered process kill

## Runtime logs and troubleshooting

Worker startup and runtime logs are printed to stdout.

## PM2 operations

The worker can be managed by PM2 using the repository-level `ecosystem.config.cjs`:

```bash
# from repository root
pm2 start ecosystem.config.cjs
pm2 save
```

Common operations:

```bash
pm2 status
pm2 logs lark-h5-bug-bot-worker
pm2 logs lark-h5-bug-bot-worker --lines 100
pm2 restart lark-h5-bug-bot-worker
pm2 stop lark-h5-bug-bot-worker
pm2 delete lark-h5-bug-bot-worker
```

After changing environment variables in `../.env`, restart the worker:

```bash
pm2 restart lark-h5-bug-bot-worker
```

To enable startup after machine reboot, run:

```bash
pm2 startup
```

Then copy and execute the `sudo ...` command printed by PM2, and save the current process list again:

```bash
pm2 save
```

### Log rotation

There is currently no application-side log rotation.

- PM2 captures stdout/stderr under `~/.pm2/logs/`.
- Claude raw `stream-json` output is written per task under `LOG_DIR` as `<taskId>.jsonl`.
- `LOG_DIR` defaults to `./logs` relative to `worker/` unless overridden in `.env`.

If PM2 logs need rotation, install and configure PM2's logrotate module:

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 14
pm2 set pm2-logrotate:compress true
```

This only rotates PM2 stdout/stderr logs. It does not clean up the per-task JSONL files under `LOG_DIR`.

### 1. Startup config

When the worker starts, it prints the basic config:

```txt
=== Bug 分析 Worker 启动 ===
云端地址: ...
分析仓库: ...
日志目录: ...
轮询间隔: ...
模型: ...
超时: ...
```

Source: `worker/src/index.ts:10-16`

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
[poller] 拉取任务失败: HTTP 401
```

or other HTTP status codes.

Source: `worker/src/poller.ts:17-23`

Common meanings:
- `401`: `AGENT_API_TOKEN` mismatch between cloud and worker
- `404` / `500`: cloud route missing or cloud service error

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

If a bug is classified as `non-frontend`, Claude analysis will be skipped.

### 4. Claude analysis stage

When Claude analysis starts, the runner prints:

```txt
[runner] 启动分析, taskId=...
[runner] 工作目录: ...
[runner] 日志文件: ...
```

Source: `worker/src/runner.ts:97-99`

This means the task has passed triage and the worker is invoking Claude Code CLI.

If Claude exits abnormally, the worker prints:

```txt
[runner] Claude CLI 退出码: ...
[runner] stderr: ...
```

Source: `worker/src/runner.ts:135-139`

If Claude times out, the worker prints:

```txt
[runner] 分析超时 (...s), 正在终止进程
[runner] 分析超时或被终止
```

Source: `worker/src/runner.ts:110-113`, `worker/src/runner.ts:127-132`

### 5. Analysis result and log file

When analysis finishes, the worker prints:

```txt
[worker] 分析结果: suspected|resolved|inconclusive|failed — ...
[worker] 日志: <logPath>
```

Source: `worker/src/index.ts:72-73`

The `logPath` file contains Claude's raw `stream-json` output. This is the most useful file when you need to inspect what Claude actually returned.

If the CLI ran but the final result cannot be parsed, the task may end with a failed result such as:

```txt
[worker] 分析结果: failed — 无法解析分析结果
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
[poller] 提交结果失败: HTTP ...
```

Source: `worker/src/poller.ts:29-40`

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
  - inspect CLI stderr and local Claude auth/runtime
- Result is `failed` with parse error:
  - inspect the worker log file under `LOG_DIR`
- Callback fails:
  - check cloud service health and `/callback/analysis-result`
