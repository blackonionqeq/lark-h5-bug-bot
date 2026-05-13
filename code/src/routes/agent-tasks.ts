import { Elysia } from "elysia";
import { sendMessageToChat } from "../services/feishu";
import { createEvent } from "../services/event-processor";
import { formatMessage } from "../utils/format-message";
import { taskStore } from "../services/task-store";
import type { AnalysisResult, AnalysisTask, AppConfig, TriageResult } from "../types";

function requireAuth(context: { headers: Record<string, string | undefined> }, expectedToken: string): boolean {
  const auth = context.headers["authorization"];
  if (!auth) return false;
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  return token === expectedToken;
}

export function createAgentTasksRouter(config: AppConfig) {
  const agentToken = config.agentApiToken ?? "";

  return new Elysia()
    .get("/agent/tasks/pending", async (context) => {
      if (!requireAuth(context, agentToken)) {
        context.set.status = 401;
        return { error: "unauthorized" };
      }
      const task = taskStore.claim();
      if (!task) {
        return { task: null };
      }
      return { task };
    })
    .post("/agent/tasks/:id/claim", async (context) => {
      if (!requireAuth(context, agentToken)) {
        context.set.status = 401;
        return { error: "unauthorized" };
      }
      const task = taskStore.get(context.params.id);
      if (!task) {
        context.set.status = 404;
        return { error: "task not found" };
      }
      task.status = "claimed";
      task.updatedAt = new Date().toISOString();
      return { task };
    })
    .post("/agent/tasks/:id/result", async (context) => {
      if (!requireAuth(context, agentToken)) {
        context.set.status = 401;
        return { error: "unauthorized" };
      }
      const body = (context.body ?? {}) as Record<string, unknown>;
      const taskId = context.params.id;

      const existingTask = taskStore.get(taskId);
      if (!existingTask) {
        context.set.status = 404;
        return { error: "task not found" };
      }

      const patch: Partial<AnalysisTask> = {};

      if (body.triageResult) {
        patch.triageResult = body.triageResult as TriageResult;
      }
      if (body.analysisResult) {
        patch.analysisResult = body.analysisResult as AnalysisResult;
      }
      if (body.status && ["queued", "claimed", "running", "completed", "failed"].includes(body.status as string)) {
        patch.status = body.status as AnalysisTask["status"];
      }

      taskStore.update(taskId, patch);

      const nextTask = taskStore.get(taskId);
      const shouldNotifyStarted =
        body.status === "running" &&
        patch.triageResult?.label === "frontend" &&
        !existingTask.startedNotifiedAt &&
        !!nextTask;

      if (shouldNotifyStarted && nextTask) {
        try {
          const event = createEvent({
            source: "local",
            type: "analysis.task.running",
            payload: {
              taskId: nextTask.taskId,
              issueId: nextTask.issueId,
              traceId: nextTask.traceId,
              title: nextTask.title,
              triageLabel: nextTask.triageResult?.label,
              triageSource: nextTask.triageResult?.source,
            },
            meta: {
              taskId: nextTask.taskId,
              issueId: nextTask.issueId,
              traceId: nextTask.traceId,
            },
          });

          const messageContent = formatMessage(event, config.userMentions);
          await sendMessageToChat(config, messageContent);
          taskStore.update(taskId, { startedNotifiedAt: new Date().toISOString() });
        } catch (error) {
          console.error("ERROR: 发送开始排查通知失败", (error as Error).message);
        }
      }

      return { success: true };
    });
}
