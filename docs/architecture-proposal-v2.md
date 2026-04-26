# Bug Auto-Analysis Architecture — Independent Proposal

## 1. Current state (baseline)

```
Zentao webhook → Elysia (cloud) → Feishu message → Lark group
                                   ↑
                                   └─ local-task.ts (stub)
```

- `POST /webhook/zentao` — receives bug, formats, sends to Lark
- `POST /callback/analysis-result` — receives async results, sends to Lark
- `local-task.ts` — no-op stub, intended extension point

Only one front-end project exists. All Zentao bugs are filed against it.

## 2. Target flow

```
Zentao webhook → Cloud: create task
                   ├─ immediate: send "bug received" to Lark (existing)
                   └─ enqueue task for analysis

Local worker → Cloud: poll for pending task
Local worker → Triage: is this a front-end bug?
                   ├─ No  → callback: "skipped, not front-end"
                   └─ Yes → Claude Code: explore source, find root cause
                                └─ callback: "found X" or "could not determine"
                                             → Cloud → Lark
```

## 3. Core architectural decisions

### 3.1 Poll, don't push

The worker **pulls** tasks from the cloud. The cloud does **not** push to the worker.

Rationale:

| Concern | Push (via tunnel) | Poll (worker-initiated) |
|---|---|---|
| Tunnel dependency | Persistent ngrok/frp required | None |
| Auth complexity | Local endpoint must validate caller | Worker holds a static API token |
| Worker lifecycle | Cloud must handle worker-down | Worker polls when ready |
| Retry | Cloud needs retry logic | Natural: worker retries on next poll |
| Concurrency control | Cloud must track worker capacity | Worker self-throttles |

The user mentioned "通过内网穿透传给本地机器". My read: the tunnel is needed **only if** the cloud pushes to local. With polling, the tunnel is eliminated from the critical path entirely — the worker calls out to the cloud's public API, which needs no tunnel.

The only potential tunnel use: if the cloud needs to reach a webhook on the local machine. Under poll architecture, it doesn't.

### 3.2 Task storage: start with in-memory, graduate to SQLite

Phase 1: in-memory `Map` with a REST API. Simplest possible thing.

```ts
// New: code/src/services/task-store.ts
const tasks = new Map<string, AnalysisTask>();

export const taskStore = {
  enqueue(task: AnalysisTask): void { ... },
  claim(): AnalysisTask | null { ... },       // claim one queued task
  update(taskId: string, patch: Partial<AnalysisTask>): void { ... },
  listPending(): AnalysisTask[] { ... },
};
```

Phase 2 (only if needed): SQLite via `bun:sqlite`. Same interface, persistent storage.

This avoids introducing a database dependency before the flow is validated end-to-end.

### 3.3 Single worker, single agent

One local machine, one worker process, one agent: Claude Code. No multi-agent abstraction. No worker pool. This matches the "当前只做一个前端项目" constraint.

The worker is a separate Bun script at the repo root (not under `code/`):

```
D:\codes\projects\lark-h5-bug-bot\
├── code/          # Cloud service (existing)
├── worker/        # Local worker (new)
│   ├── index.ts       # Entry: poll loop
│   ├── triage.ts      # Front-end classification
│   ├── runner.ts      # Claude Code invocation
│   └── reporter.ts    # Callback to cloud
└── .env           # Shared env
```

### 3.4 Triage: "Is this a front-end bug?"

This is the pivotal design question. Two approaches:

#### Option A: Rules-only

Match Chinese keywords in bug title + description against a curated list.

```ts
const FRONTEND_SIGNALS = [
  /页面/, /样式/, /UI/, /布局/, /渲染/, /显示/,
  /按钮/, /点击/, /弹窗/, /表单/, /输入/, /下拉/,
  /前端/, /浏览器/, /兼容/, /控制台/, /console/,
  /loading/, /刷新/, /滚动/, /适配/, /响应式/,
];

const BACKEND_SIGNALS = [
  /接口/, /API/, /数据库/, /SQL/, /后端/, /服务端/,
  /nginx/, /服务器/, /部署/, /定时任务/, /队列/,
  /redis/, /缓存/, /日志.{0,4}报错/, /docker/,
];
```

**Pros**: zero latency, zero API cost, deterministic, debuggable.
**Cons**: semantic drift ("点击没反应" could be API failure); rules need maintenance.

**Mitigation**: when uncertain, default to `frontend` — a false positive costs one Claude Code invocation, which is cheap compared to a missed real bug.

#### Option B: Hybrid (rules + lightweight LLM)

Rules first, LLM classifier for uncertain cases. The existing doc recommends this.

**Pros**: better recall on ambiguous cases.
**Cons**: adds latency, cost, and a dependency on an LLM API.

#### My recommendation: start with Option A, instrument it, decide later

Ship rules-only first. Every triage decision gets logged. After 1-2 weeks of real bugs, review the log:

- How many were classified as `frontend`? How many `non-frontend`?
- Spot-check a sample of `non-frontend` classifications — were any wrong?
- If misclassification rate is acceptable, stay with rules.
- If too many front-end bugs are being skipped, add the LLM step.

This is a **data-driven** decision instead of a speculative one. The rules list above is already a decent starting point for a Chinese-speaking QA team filing bugs against a known front-end project.

### 3.5 Claude Code invocation

Use Claude Code CLI in non-interactive mode, pointed at the **front-end project repo** (not this bot repo):

```bash
claude -p "<prompt>" --output-format text --max-turns 30 --allowedTools "Read,Grep,Glob,Bash"
```

Keep the prompt focused:

```
You are a front-end bug investigator. You have access to the source code
of the front-end project at {repoPath}.

Bug report:
  Title: {title}
  Description: {description}

Steps:
1. Read the bug carefully. Identify what behavior is expected vs observed.
2. Explore the codebase to find relevant components, pages, or logic.
3. Determine the most likely root cause.
4. Report your findings in this exact JSON format:

{
  "status": "suspected" | "resolved" | "inconclusive",
  "summary": "<one-line finding in Chinese>",
  "reason": "<brief explanation>",
  "files": ["<relevant file paths>"]
}
```

Key constraints:
- `--max-turns 30` prevents runaway sessions
- Tool allowlist restricts to read-only exploration
- Structured JSON output is parseable by the reporter

### 3.6 Callback format

The worker posts results to the existing `POST /callback/analysis-result`:

```json
{
  "taskId": "zentao-1714000000000-abc123",
  "issueId": "BUG-456",
  "traceId": "zentao-1714000000000-abc123",
  "status": "suspected",
  "summary": "表单提交按钮的 loading 状态未在 API 返回后重置",
  "reason": "src/views/order-form.vue:142 — finally 块缺少 this.submitting = false",
  "triageLabel": "frontend",
  "triageSource": "rules",
  "files": ["src/views/order-form.vue", "src/api/order.ts"]
}
```

The existing `POST /callback/analysis-result` only needs the `formatMessage` function updated to render this structured result nicely.

## 4. New cloud-side code

Minimal additions to the existing Elysia service:

### `code/src/services/task-store.ts` (new)
In-memory task queue. Enqueue on webhook, claim/serve via API.

### `code/src/routes/agent-tasks.ts` (new)
Worker-facing endpoints:

```
GET  /agent/tasks/pending    → { task: AnalysisTask | null }
POST /agent/tasks/:id/claim  → { ok: true }
POST /agent/tasks/:id/status → { ok: true }   // update status
```

### `code/src/services/event-processor.ts` (modified)
In `handleEvent`, for `zentao.webhook.received`:
- Keep the existing Feishu notification ("bug received")
- **Add**: enqueue an `AnalysisTask` to `task-store`

### `code/src/routes/analysis-callback.ts` (modified)
Already exists. Only `formatMessage` needs updating to handle the richer callback payload.

## 5. New local-side code

### `worker/index.ts`
Main loop:

```ts
while (true) {
  const task = await fetchPendingTask();
  if (!task) { await sleep(5000); continue; }

  await claimTask(task.taskId);
  await processTask(task);
}
```

### `worker/triage.ts`
Keyword-based classifier. Returns `{ label, source, reason }`.

### `worker/runner.ts`
Spawns Claude Code CLI, captures stdout, parses JSON result.

### `worker/reporter.ts`
POSTs structured result to cloud's `/callback/analysis-result`.

## 6. Security boundaries

- Worker API endpoints (`/agent/tasks/*`) auth'd via a shared `AGENT_API_TOKEN` env var.
- Callback endpoint already exists; same token-based auth.
- Claude Code runs with read-only tool allowlist.
- All task state changes are logged with `traceId`.

## 7. Phase plan

### Phase 1 (ship this week)
- In-memory task store + worker API endpoints
- Worker with poll loop, rules-only triage, Claude Code runner
- Structured callback → Lark message formatting
- Single concurrency, 5-minute timeout per task

### Phase 2 (after validation)
- SQLite persistence for task store
- Triage log dashboard → decide if LLM triage needed
- Task timeout + retry
- Worker health check endpoint

### Phase 3 (if/when needed)
- Multi-project support
- Multi-agent adapter (Codex, Cursor)
- Formal message queue (Redis/NSQ)

---

# Comparison with existing architecture document

The existing doc at `docs/claude-code-analysis-architecture.md` is thorough and well-reasoned. Here's where my proposal agrees, where it differs, and which I'd choose.

## Agreement points (no debate needed)

| Topic | Both say |
|---|---|
| Cloud does not execute analysis | Agreed |
| Worker polls, cloud doesn't push | Agreed |
| Separate `AnalysisTask` from `AppEvent` | Agreed |
| Read-only Claude Code, timeout-limited | Agreed |
| Token-based auth on all worker APIs | Agreed |
| Claude Code only, no multi-agent in phase 1 | Agreed |
| Two-tier result status (task status vs analysis outcome) | Agreed |
| Callback reuses existing `/callback/analysis-result` | Agreed |

## Points of difference

### 1. Triage: rules-only (mine) vs rules+LLM hybrid (existing)

**Existing doc**: "我不建议完全依赖纯规则" — recommends a lightweight LLM for uncertain cases from day one.

**My proposal**: Start rules-only, collect data, then decide.

**Why I prefer rules-first**:
- The cost of a false positive (Claude Code on a non-front-end bug) is low: ~1-2 minutes of compute time. The result says "inconclusive" and the group sees it.
- The cost of false negatives (missing a front-end bug) is also low: the tester re-pings or someone manually triages.
- The cost of adding an LLM dependency prematurely is higher: another API key, another failure mode, another latency source, another thing to debug.
- After 1-2 weeks of real data, you'll KNOW whether rules are enough. You won't have to guess.

If I had to bet: rules alone will catch 80-90% of front-end bugs for a single known project. The remaining 10-20% are edge cases that even an LLM might get wrong. The LLM step buys marginal improvement at non-trivial complexity cost.

**But**: if after data collection the miss rate is unacceptable, I'd adopt the existing doc's hybrid approach. The infrastructure for it is a small addition to `triage.ts`.

### 2. Task storage: in-memory (mine) vs abstracted "task storage" (existing)

**Existing doc**: Describes `AnalysisTask` entity and a storage layer but doesn't specify implementation. Mentions `DB` in the architecture diagram.

**My proposal**: Concrete: in-memory `Map` for phase 1, SQLite for phase 2.

**Why I prefer in-memory-first**: The existing doc's `DB` block is right in spirit but too abstract for implementation. An in-memory store is 30 lines of code, zero dependencies, and trivially replaceable with SQLite later. Specifying the concrete implementation reduces ambiguity.

### 3. Tunnel role: callback channel (existing) vs not needed (mine)

**Existing doc**: "内网穿透主要用于 HTTPS 回传" — positions the tunnel as the callback channel. The architecture diagram routes worker→tunnel→callback.

**My proposal**: If the cloud has a public endpoint (which it must, to receive Zentao webhooks), the worker calls it directly. No tunnel needed for either direction under the poll model.

**Why I prefer no tunnel**: The callback from worker to cloud is a standard HTTPS POST to a public URL. The worker is making an outbound request — no NAT traversal needed. The tunnel is only required if the cloud initiates connections to the worker, which the poll model avoids.

### 4. Worker repo structure (mine) vs conceptual description (existing)

**Existing doc**: Describes worker components conceptually (`worker/poller`, `worker/task-classifier`, etc.) but doesn't place them in the repository.

**My proposal**: Places `worker/` as a sibling to `code/` in the same repo, with concrete file names and responsibilities.

**Why**: The worker and the cloud service share the same repo (they're developed together) but are deployed separately. Making the directory structure explicit removes the "where does this code live?" ambiguity.

## Overall preference

The existing doc is a strong architecture document — it correctly identifies the poll model, the task abstraction, the triage step, and the phase plan. I'd adopt it as the reference with **three adjustments**:

1. **Triage starts rules-only** — collect data before adding an LLM. This is lower risk and faster to ship.
2. **Task store starts as in-memory Map** — concrete, trivial, replaceable. Avoids over-engineering before the flow is validated.
3. **Drop the tunnel from the critical path** — the poll model doesn't need it. If a tunnel is wanted for operational access (SSH to the worker machine), that's separate infrastructure.

The existing doc's data model (`AnalysisTask`, callback payload, `TriageResult`) is well-designed and I'd use it directly.

**In one line**: The existing doc is 95% right. Ship with rules-only triage + in-memory store + no tunnel, and add complexity only when data demands it.
