# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Working directory

- Most application code lives under `code/`.
- The runtime expects the env file at the repository root: `.env`.
- Run app commands from `code/`, not the repository root.

## Development commands

From `code/`:

```bash
pnpm install
pnpm dev
pnpm start
pnpm typecheck
```

What they do:

- `pnpm dev` — starts Bun in watch mode with `../.env` loaded.
- `pnpm start` — starts the Elysia server with `../.env` loaded.
- `pnpm typecheck` — runs `tsc --noEmit`.

There is currently no test runner configured in `code/package.json`. If tests are added later, update this file with the exact command.

## Required environment variables

The app fails fast at startup if these are missing:

- `APP_ID`
- `APP_SECRET`
- `CHAT_ID`
- `PORT` is optional and defaults to `3000`

Config loading is centralized in `code/src/config.ts`.

## High-level architecture

This is a small Bun + TypeScript + Elysia service that accepts inbound events and forwards them to a Feishu group chat.

Current HTTP entrypoints:

- `POST /webhook/zentao`
- `POST /callback/analysis-result`

The request flow is:

1. `code/src/index.ts` creates the Elysia app and mounts route factories.
2. Route modules in `code/src/routes/` accept raw request bodies and convert them into a shared internal event shape.
3. `code/src/services/event-processor.ts` creates `AppEvent` objects, assigns `traceId`, optionally triggers local processing for Zentao events, formats the outgoing message, and sends it to Feishu.
4. `code/src/services/feishu.ts` handles Feishu API integration in two steps:
   - fetch tenant access token
   - send a chat message to the configured `chat_id`
5. `code/src/utils/format-message.ts` controls the final text content sent to Feishu.

## Event model

Shared event and payload types live in `code/src/types.ts`.

Important design choice: both routes normalize incoming payloads into a common `AppEvent` structure with:

- `source`
- `type`
- `payload`
- `meta`
- `traceId`
- `timestamp`

When adding a new event source, keep this normalization pattern instead of putting source-specific logic directly into `index.ts`.

## Route responsibilities

- `code/src/routes/zentao.ts` handles Zentao webhook input and derives `issueId` from `id`, `bugId`, or `issueId`.
- `code/src/routes/analysis-callback.ts` handles async analysis callback input and preserves upstream `taskId`, `issueId`, and `traceId` in event metadata.

## Local processing hook

`code/src/services/local-task.ts` is currently only a stub invoked for `zentao.webhook.received`. It is the intended extension point for local side effects or async job triggering before Feishu delivery.

## Feishu integration notes

- The service uses Feishu app credentials, not a custom webhook bot.
- Message sending is plain text today.
- `code/src/services/feishu.ts` logs the request URL and payload before sending; be careful when changing logging around secrets or tokens.

## TypeScript/runtime setup

- Runtime is Bun.
- TS config is in `code/tsconfig.json`.
- `moduleResolution` is `bundler` and Bun types are enabled.
- Source files included by TypeScript are `code/src/**/*.ts`.

## Deployment assumptions from the repo

The repository is structured so production deployments can place:

```bash
/opt/lark-h5-bug-bot/
├── .env
└── code/
```

That matches the existing Bun commands, which load env from `../.env`.
