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
  taskDbPath?: string;
  larkVerificationToken?: string;
  larkEncryptKey?: string;
  fixAllowedOpenIds: string[];
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
  /** 本项目对禅道通用 Webhook 的本地扩展字段。 */
  title?: string;
  steps?: string;
  status?: string;
  pri?: string | number;
  severity?: string | number;
  openedBy?: string;
  assignedTo?: string;
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
  taskType?: "analysis.run";
  taskId: string;
  traceId: string;
  issueId?: string | number;
  title?: string;
  description?: string;
  status: "queued" | "claimed" | "running" | "completed" | "failed";
  triageResult?: TriageResult;
  analysisResult?: AnalysisResult;
  repoSnapshot?: RepoSnapshot;
  resultMessageId?: string;
  startedNotifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoSnapshot {
  projectName: string;
  commitSha: string;
  dirty: boolean;
}

export type FixTaskStatus =
  | "queued"
  | "claimed"
  | "preparing"
  | "fixing"
  | "validating"
  | "committing"
  | "completed"
  | "failed"
  | "cancelled";

export type FixTaskOutcome =
  | "ready_for_verification"
  | "validation_failed"
  | "no_changes"
  | "stale_analysis"
  | "workspace_conflict";

export interface FixCheckResult {
  command: string;
  status: "passed" | "failed" | "skipped";
  exitCode?: number | null;
  summary?: string;
}

export interface FixTask {
  taskType: "fix.run";
  taskId: string;
  analysisTaskId: string;
  traceId: string;
  issueId?: string | number;
  projectName: string;
  requestedBy: string;
  status: FixTaskStatus;
  outcome?: FixTaskOutcome;
  baseCommitSha: string;
  title: string;
  description: string;
  analysisResult: AnalysisResult;
  branchName?: string;
  commitSha?: string;
  changedFiles?: string[];
  checks?: FixCheckResult[];
  resultNotifiedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FixCleanupTask {
  taskType: "fix.cleanup";
  taskId: string;
  fixTaskId: string;
  traceId: string;
  projectName: string;
  requestedBy: string;
  resolution: "handled" | "discarded";
  branchName: string;
  commitSha: string;
  status: "queued" | "claimed" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
}

export type WorkerTask = AnalysisTask | FixTask | FixCleanupTask;

export function getTaskType(task: WorkerTask): "analysis.run" | "fix.run" | "fix.cleanup" {
  return task.taskType ?? "analysis.run";
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
  enqueue(task: WorkerTask): void;
  claim<T extends WorkerTask = AnalysisTask>(): T | null;
  update<T extends WorkerTask = AnalysisTask>(taskId: string, patch: Partial<T>): void;
  get<T extends WorkerTask = AnalysisTask>(taskId: string): T | undefined;
  findActiveFixByAnalysisTask(analysisTaskId: string): FixTask | undefined;
  findFixByAnalysisTask(analysisTaskId: string): FixTask | undefined;
  close?(): void;
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
