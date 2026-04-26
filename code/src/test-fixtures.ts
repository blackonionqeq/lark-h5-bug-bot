import type {
  AppConfig,
  AppEvent,
  AnalysisTask,
  TriageResult,
  AnalysisResult,
  ZentaoWebhookPayload,
  AnalysisCallbackPayload,
} from "./types";

export function makeAppConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    appID: "test-app-id",
    appSecret: "test-app-secret",
    chatID: "test-chat-id",
    port: 3000,
    ...overrides,
  };
}

export function makeZentaoPayload(overrides?: Partial<ZentaoWebhookPayload>): ZentaoWebhookPayload {
  return {
    id: 1,
    bugId: 100,
    issueId: "BUG-100",
    title: "页面白屏报错",
    description: "用户打开首页时页面白屏，控制台报错 TypeError: Cannot read property 'foo' of undefined",
    ...overrides,
  };
}

export function makeAnalysisCallbackPayload(
  overrides?: Partial<AnalysisCallbackPayload>
): AnalysisCallbackPayload {
  return {
    taskId: "task-001",
    issueId: "BUG-100",
    traceId: "trace-001",
    status: "suspected",
    summary: "疑似由空值判断缺失导致",
    reason: "在 src/components/Header.tsx 中发现未做 null check 直接访问属性",
    triageLabel: "frontend",
    triageSource: "rules",
    files: ["src/components/Header.tsx", "src/utils/helper.ts"],
    ...overrides,
  };
}

export function makeAppEvent(overrides?: Partial<AppEvent>): AppEvent {
  return {
    source: "zentao",
    type: "zentao.webhook.received",
    payload: makeZentaoPayload(),
    meta: { issueId: "BUG-100" },
    traceId: "trace-001",
    timestamp: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeAnalysisTask(overrides?: Partial<AnalysisTask>): AnalysisTask {
  return {
    taskId: "task-001",
    traceId: "trace-001",
    issueId: "BUG-100",
    title: "页面白屏报错",
    description: "用户打开首页时页面白屏，控制台报错",
    status: "queued",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeTriageResult(overrides?: Partial<TriageResult>): TriageResult {
  return {
    label: "frontend",
    source: "rules",
    reason: "命中规则: frontend:/页面/, frontend:/白屏/",
    matchedRules: ["frontend:/页面/", "frontend:/白屏/"],
    ...overrides,
  };
}

export function makeAnalysisResult(overrides?: Partial<AnalysisResult>): AnalysisResult {
  return {
    status: "suspected",
    summary: "疑似由空值判断缺失导致",
    reason: "在 src/components/Header.tsx 中发现未做 null check",
    files: ["src/components/Header.tsx"],
    ...overrides,
  };
}
