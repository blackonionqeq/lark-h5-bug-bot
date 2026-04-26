# Cloud Service Testing Guide

## Quick start

```bash
cd code
pnpm test
```

No `.env` file needed — tests use hardcoded fixture data.

## Test runner

Uses Bun's built-in test runner (`bun:test`). Jest-compatible API: `describe`, `it`, `expect`, `beforeEach`, `spyOn`.

## Test structure

```
code/src/
├── test-fixtures.ts          # Shared factory functions for test data
├── config.ts                 # getConfig() accepts overrides for testing
├── services/
│   └── __tests__/
│       ├── task-store.test.ts
│       ├── local-task.test.ts
│       ├── event-processor.test.ts
│       └── feishu.test.ts
├── utils/
│   └── __tests__/
│       └── format-message.test.ts
└── routes/
    └── __tests__/
        ├── agent-tasks.test.ts
        ├── zentao.test.ts
        └── analysis-callback.test.ts
```

## Config in tests

```ts
import { getConfig } from "../config";

const config = getConfig({
  appID: "test-app-id",
  appSecret: "test-secret",
  chatID: "test-chat-id",
  port: 3000,
});
```

When `overrides` is passed, `getConfig()` skips reading `Bun.env` entirely.

## Fixtures

Import factories from `test-fixtures.ts`:

```ts
import { makeZentaoPayload, makeAppEvent, makeAnalysisTask } from "../test-fixtures";
```

Each factory returns a complete, valid object with sensible defaults. All fields are overridable:

```ts
const task = makeAnalysisTask({ status: "claimed" });
```

## Stateful store tests

`task-store.ts` now exports `createTaskStore()` for isolated tests. Prefer creating a fresh store per test instead of reusing the process-wide singleton:

```ts
import { createTaskStore } from "../services/task-store";

let taskStore = createTaskStore();
```

Keep the exported `taskStore` singleton for production wiring.

## Mocking external calls

Use `spyOn` on `globalThis.fetch` for services that call external APIs (feishu, poller, reporter):

```ts
import { spyOn } from "bun:test";

spyOn(globalThis, "fetch").mockImplementation(() =>
  Promise.resolve(new Response(JSON.stringify({ code: 0, data: {} })))
);
```

## Route testing

Elysia routes are created by factory functions. Test them by building a minimal app and calling `.handle()`:

```ts
import { Elysia } from "elysia";

const app = new Elysia().use(createZentaoRouter(config));
const res = await app.handle(
  new Request("http://localhost/webhook/zentao", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  })
);
expect(res.status).toBe(200);
```
