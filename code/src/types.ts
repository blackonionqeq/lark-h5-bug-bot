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
