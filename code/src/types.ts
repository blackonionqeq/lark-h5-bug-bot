export type EventSource = "zentao" | "bugbot-callback" | "local";

export type EventType =
  | "zentao.webhook.received"
  | "analysis.result.received"
  | "analysis.task.running"
  | "local.manual.requested";

export interface EventMeta {
  issueId?: string | number;
  taskId?: string;
  traceId?: string;
}

export interface AppEvent<TPayload = Record<string, unknown>> {
  source: EventSource;
  type: EventType;
  payload: TPayload;
  meta: EventMeta;
  traceId: string;
  timestamp: string;
}

export interface AppConfig {
  appID: string;
  appSecret: string;
  chatID: string;
  port: number;
  agentApiToken?: string;
  /** Map of display name → Feishu open_id for @ mentions */
  userMentions: Record<string, string>;
}

/** Raw payload from Zentao webhook — 既可能是自定义模板的纯 text，也可能是禅道原生字段 */
export interface ZentaoWebhookPayload extends Record<string, unknown> {
  text?: string;
  /** 以下为禅道原生 webhook 的固定字段（标准禅道会一并发送） */
  objectType?: string;
  objectID?: string | number;
  action?: string;
  actor?: string;
  comment?: string;
  date?: string;
}

/** Parsed fields extracted from Zentao webhook text */
export interface ZentaoParsedFields {
  bugId: string;
  title: string;
  status: string;
  priority: string;
  severity: string;
  creator: string;
  operator: string;
  assignee: string;
  description?: string;
  steps?: string;
  expected?: string;
  actual?: string;
  link: string;
}

export interface AnalysisCallbackPayload extends Record<string, unknown> {
  taskId?: string;
  issueId?: string | number;
  traceId?: string;
  status?: string;
  summary?: string;
  reason?: string;
  triageLabel?: string;
  triageSource?: string;
  files?: string[];
}

export interface AnalysisProgressPayload extends Record<string, unknown> {
  taskId?: string;
  issueId?: string | number;
  traceId?: string;
  title?: string;
  triageLabel?: string;
  triageSource?: string;
}

export interface AnalysisTask {
  taskId: string;
  traceId: string;
  issueId?: string | number;
  title?: string;
  description?: string;
  status: "queued" | "claimed" | "running" | "completed" | "failed";
  triageResult?: TriageResult;
  analysisResult?: AnalysisResult;
  startedNotifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TriageResult {
  label: "frontend" | "non-frontend";
  source: "rules" | "llm" | "rules+llm";
  reason: string;
  matchedRules?: string[];
}

export interface AnalysisResult {
  status: "suspected" | "resolved" | "inconclusive" | "skipped" | "failed";
  summary: string;
  reason: string;
  files?: string[];
}

export interface TaskStore {
  enqueue(task: AnalysisTask): void;
  claim(): AnalysisTask | null;
  update(taskId: string, patch: Partial<AnalysisTask>): void;
  get(taskId: string): AnalysisTask | undefined;
}

export interface FeishuTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
}

export interface FeishuMessageResponse {
  code: number;
  msg: string;
  data?: Record<string, unknown>;
}
