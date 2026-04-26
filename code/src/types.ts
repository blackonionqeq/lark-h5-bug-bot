export type EventSource = "zentao" | "bugbot-callback" | "local";

export type EventType =
  | "zentao.webhook.received"
  | "analysis.result.received"
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
}

export interface ZentaoWebhookPayload extends Record<string, unknown> {
  id?: string | number;
  bugId?: string | number;
  issueId?: string | number;
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

export interface AnalysisTask {
  taskId: string;
  traceId: string;
  issueId?: string | number;
  title?: string;
  description?: string;
  status: "queued" | "claimed" | "running" | "completed" | "failed";
  triageResult?: TriageResult;
  analysisResult?: AnalysisResult;
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
