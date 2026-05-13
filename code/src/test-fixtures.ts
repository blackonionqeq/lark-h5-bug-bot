import type {
  AppConfig,
  AppEvent,
  AnalysisTask,
  TriageResult,
  AnalysisResult,
  ZentaoWebhookPayload,
  ZentaoParsedFields,
  AnalysisCallbackPayload,
} from "./types";

export function makeAppConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    appID: "test-app-id",
    appSecret: "test-app-secret",
    chatID: "test-chat-id",
    port: 3000,
    agentApiToken: "test-agent-token",
    userMentions: {},
    ...overrides,
  };
}

export function makeZentaoPayload(overrides?: Partial<ZentaoWebhookPayload>): ZentaoWebhookPayload {
  return {
    text: "【🔔 禅道BUG修改提醒】\n🧑‍💻 创建人：张三\n🎬 操作人：李四\n👤 指派人：王五\n📝 BUG标题：页面白屏报错\n🆔 BUG编号：#100\n📊 BUG状态：active\n⚡ 优先级：3\n💥 严重程度：3\n🔗 详情链接：http://zentao.example.com/bug-view-100.html",
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

const defaultParsed: ZentaoParsedFields = {
  bugId: "100",
  title: "页面白屏报错",
  status: "active",
  priority: "3",
  severity: "3",
  creator: "张三",
  operator: "李四",
  assignee: "王五",
  link: "http://zentao.example.com/bug-view-100.html",
};

export function makeAppEvent(overrides?: Partial<AppEvent>): AppEvent {
  const payload = makeZentaoPayload();
  return {
    source: "zentao",
    type: "zentao.webhook.received",
    payload: { ...payload, _parsed: defaultParsed },
    meta: { issueId: "100" },
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
