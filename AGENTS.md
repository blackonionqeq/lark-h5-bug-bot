# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working directory

- Cloud service code lives under `code/`.
- Worker code lives under `worker/`.
- The runtime expects the env file at the repository root: `.env`.
- Run cloud commands from `code/`, worker commands from `worker/`.

## Development commands

### Cloud (from `code/`):

```bash
pnpm install
pnpm dev          # Bun watch mode with ../.env
pnpm start        # Elysia server with ../.env
pnpm typecheck    # tsc --noEmit
```

### Worker (from `worker/`):

```bash
pnpm install
pnpm start        # starts poll loop with ../.env
pnpm typecheck    # tsc --noEmit
```

There is currently no test runner configured. If tests are added later, update this file.

## Required environment variables

### Cloud (fails fast if missing):

- `APP_ID`
- `APP_SECRET`
- `CHAT_ID`
- `PORT` — optional, defaults to `3000`
- `AGENT_API_TOKEN` — optional, enables Bearer auth on `/agent/*` routes

### Worker (fails fast if missing):

- `CLOUD_URL` — cloud service base URL
- `AGENT_API_TOKEN` — must match cloud config
- `REPO_PATH` — path to the frontend project to analyze

Optional worker vars: `LOG_DIR`, `POLL_INTERVAL_MS`, `TIMEOUT_SECONDS`, `MAX_TURNS`, `CLAUDE_MODEL`.

Config loading is centralized in `code/src/config.ts` (cloud) and `worker/src/config.ts` (worker).

## High-level architecture

Two components:

1. **Cloud service** (Bun + Elysia): accepts inbound events, forwards them to Feishu, and manages a task queue for the worker.
2. **Local worker** (Bun): polls the cloud for pending analysis tasks, triages bugs via rules, runs Claude Code CLI against a frontend repo, and reports results back.

### Cloud HTTP entrypoints:

- `POST /webhook/zentao` — receive Zentao webhook
- `POST /callback/analysis-result` — receive analysis results (from worker)
- `GET  /agent/tasks/pending` — worker pulls and claims a task (Bearer auth)
- `POST /agent/tasks/:id/claim` — explicit claim (Bearer auth)
- `POST /agent/tasks/:id/result` — submit intermediate/final status (Bearer auth)

### Cloud request flow:

1. `code/src/index.ts` creates the Elysia app and mounts route factories.
2. Route modules in `code/src/routes/` normalize payloads into `AppEvent`.
3. `code/src/services/event-processor.ts` creates events, enqueues analysis tasks for Zentao events, formats messages, and sends to Feishu.
4. `code/src/services/task-store.ts` is the in-memory task queue (Phase 1; designed for SQLite replacement in Phase 2).
5. `code/src/services/local-task.ts` creates `AnalysisTask` objects and enqueues them.
6. `code/src/routes/agent-tasks.ts` exposes the task queue to the worker via REST API with Bearer auth.

### Worker flow:

1. `worker/src/index.ts` — main poll loop on a timer.
2. `worker/src/poller.ts` — HTTP client for the cloud task API.
3. `worker/src/triage.ts` — rule-based frontend/non-frontend classification. Defaults to frontend when uncertain.
4. `worker/src/runner.ts` — spawns `claude -p` with `--output-format stream-json`, captures JSONL logs, extracts the `result` event.
5. `worker/src/reporter.ts` — POSTs analysis results to `/callback/analysis-result`.

## Event model

Shared event and payload types live in `code/src/types.ts`.

Both routes normalize incoming payloads into a common `AppEvent` structure with: `source`, `type`, `payload`, `meta`, `traceId`, `timestamp`.

When adding a new event source, keep this normalization pattern.

## Data model

`code/src/types.ts` defines:

- `AnalysisTask` — task lifecycle: `queued → claimed → running → completed/failed`
- `TriageResult` — classification output: `frontend | non-frontend`, with source and matched rules
- `AnalysisResult` — analysis conclusion: `suspected | resolved | inconclusive | skipped | failed`
- `TaskStore` — interface for task queue (current impl: in-memory Map)

Task status and analysis conclusion are two independent dimensions.

## Feishu integration notes

- Uses Feishu app credentials, not a custom webhook bot.
- Message sending is plain text.
- `code/src/services/feishu.ts` logs request URL and payload; be careful with secrets/tokens.

## TypeScript/runtime setup

- Runtime is Bun (both cloud and worker).
- TS configs: `code/tsconfig.json` and `worker/tsconfig.json`.
- `moduleResolution` is `bundler`, Bun types enabled.
- Worker imports shared types from `../../code/src/types` via relative paths.

## Deployment assumptions

```bash
/opt/lark-h5-bug-bot/
├── .env
├── code/       # cloud service
└── worker/     # can be on a different machine
```

Worker only makes outbound HTTPS requests to the cloud. No inbound connections or tunneling needed.
