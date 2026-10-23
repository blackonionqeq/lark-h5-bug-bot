import { createDecipheriv, createHash, timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import { taskStore } from "../services/task-store";
import { updateCardByToken } from "../services/feishu";
import { buildFixQueuedCard } from "../utils/format-card";
import { getTaskType } from "../types";
import type { AnalysisTask, AppConfig, FixCleanupTask, FixTask } from "../types";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" ? value as JsonObject : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function calculateLarkSignature(timestamp: string, nonce: string, encryptKey: string, rawBody: string): string {
  return createHash("sha256").update(timestamp + nonce + encryptKey + rawBody).digest("hex");
}

export function decryptLarkEvent(encrypted: string, encryptKey: string): string {
  const buffer = Buffer.from(encrypted, "base64");
  if (buffer.length <= 16) throw new Error("encrypted callback is too short");
  const key = createHash("sha256").update(encryptKey).digest();
  const decipher = createDecipheriv("aes-256-cbc", key, buffer.subarray(0, 16));
  return Buffer.concat([decipher.update(buffer.subarray(16)), decipher.final()]).toString("utf8");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifyCallback(request: Request, body: JsonObject, rawBody: string, config: AppConfig): boolean {
  if (config.larkEncryptKey) {
    const timestamp = request.headers.get("x-lark-request-timestamp") ?? "";
    const nonce = request.headers.get("x-lark-request-nonce") ?? "";
    const signature = request.headers.get("x-lark-signature") ?? "";
    const timestampMs = Number(timestamp) * 1000;
    if (!timestamp || !nonce || !signature || !Number.isFinite(timestampMs)) return false;
    if (Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) return false;
    return safeEqual(calculateLarkSignature(timestamp, nonce, config.larkEncryptKey, rawBody), signature);
  }

  if (config.larkVerificationToken) {
    const header = object(body.header);
    const token = string(header.token) ?? string(body.verification_token) ?? string(body.token);
    return !!token && safeEqual(token, config.larkVerificationToken);
  }

  return false;
}

function parseAction(body: JsonObject): { action?: string; analysisTaskId?: string; fixTaskId?: string; resolution?: string; operatorId: string; updateToken?: string } {
  const event = object(body.event);
  const action = object(event.action ?? body.action);
  const value = object(action.value);
  const operator = object(event.operator ?? body.operator);
  const operatorId = object(operator.operator_id);
  return {
    action: string(value.action),
    analysisTaskId: string(value.analysisTaskId),
    fixTaskId: string(value.fixTaskId),
    resolution: string(value.resolution),
    operatorId: string(operatorId.open_id) ?? string(operator.open_id) ?? string(body.open_id) ?? "unknown",
    updateToken: string(event.token) ?? string(body.card_token),
  };
}

export function createFeishuCardCallbackRouter(config: AppConfig) {
  return new Elysia().post("/callback/feishu/card", async ({ request, set }) => {
    const rawBody = await request.text();
    let body: JsonObject;
    try {
      body = JSON.parse(rawBody) as JsonObject;
      if (typeof body.encrypt === "string") {
        if (!config.larkEncryptKey) throw new Error("missing encrypt key");
        body = JSON.parse(decryptLarkEvent(body.encrypt, config.larkEncryptKey)) as JsonObject;
      }
    } catch {
      set.status = 400;
      return { error: "invalid json" };
    }

    if (body.type === "url_verification") {
      const tokenOk = !config.larkVerificationToken || body.token === config.larkVerificationToken;
      if (!tokenOk) {
        set.status = 401;
        return { error: "unauthorized" };
      }
      return { challenge: body.challenge };
    }

    if (!verifyCallback(request, body, rawBody, config)) {
      set.status = 401;
      return { error: "unauthorized" };
    }

    const action = parseAction(body);
    if (config.fixAllowedOpenIds.length > 0 && !config.fixAllowedOpenIds.includes(action.operatorId)) {
      set.status = 403;
      return { error: "operator is not allowed to manage fixes" };
    }
    if (action.action === "fix.cleanup" && action.fixTaskId) {
      const source = taskStore.get<import("../types").WorkerTask>(action.fixTaskId);
      if (!source || getTaskType(source) !== "fix.run") {
        set.status = 404;
        return { error: "fix task not found" };
      }
      const fixTask = source as FixTask;
      if (!fixTask.branchName || !fixTask.commitSha) {
        set.status = 409;
        return { error: "fix task has no branch" };
      }
      const now = new Date().toISOString();
      const cleanupTaskId = `cleanup-${fixTask.taskId}`;
      if (taskStore.get<FixCleanupTask>(cleanupTaskId)) {
        return { toast: { type: "info", content: "该清理任务已存在" } };
      }
      const cleanupTask: FixCleanupTask = {
        taskType: "fix.cleanup",
        taskId: cleanupTaskId,
        fixTaskId: fixTask.taskId,
        traceId: fixTask.traceId,
        projectName: fixTask.projectName,
        requestedBy: action.operatorId,
        resolution: action.resolution === "discarded" ? "discarded" : "handled",
        branchName: fixTask.branchName,
        commitSha: fixTask.commitSha,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      };
      taskStore.enqueue(cleanupTask);
      return { toast: { type: "success", content: "清理任务已创建" } };
    }

    if (action.action !== "fix.request" || !action.analysisTaskId) {
      set.status = 400;
      return { error: "unsupported action" };
    }

    const existing = taskStore.findFixByAnalysisTask(action.analysisTaskId);
    if (existing) {
      return { toast: { type: "info", content: "该 Bug 已有修复任务" } };
    }

    const source = taskStore.get<import("../types").WorkerTask>(action.analysisTaskId);
    if (!source || getTaskType(source) !== "analysis.run") {
      set.status = 404;
      return { error: "analysis task not found" };
    }
    const analysis = source as AnalysisTask;
    if (analysis.analysisResult?.status !== "resolved") {
      set.status = 409;
      return { error: "analysis is not eligible for auto-fix" };
    }
    if (!analysis.repoSnapshot || analysis.repoSnapshot.dirty) {
      set.status = 409;
      return { error: "analysis repository snapshot is unavailable or dirty" };
    }

    const now = new Date().toISOString();
    const task: FixTask = {
      taskType: "fix.run",
      taskId: `fix-${crypto.randomUUID()}`,
      analysisTaskId: analysis.taskId,
      traceId: analysis.traceId,
      issueId: analysis.issueId,
      projectName: analysis.repoSnapshot.projectName,
      requestedBy: action.operatorId,
      status: "queued",
      baseCommitSha: analysis.repoSnapshot.commitSha,
      title: analysis.title ?? "",
      description: analysis.description ?? "",
      analysisResult: analysis.analysisResult,
      createdAt: now,
      updatedAt: now,
    };
    taskStore.enqueue(task);

    if (action.updateToken) {
      setTimeout(() => {
        updateCardByToken(config, action.updateToken!, buildFixQueuedCard(task.issueId))
          .catch((error) => console.error("ERROR: 更新飞书修复卡片失败", (error as Error).message));
      }, 0);
    }

    return { toast: { type: "success", content: "修复任务已创建" } };
  }, { parse: "none" });
}
