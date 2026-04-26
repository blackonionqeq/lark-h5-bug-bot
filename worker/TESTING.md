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
