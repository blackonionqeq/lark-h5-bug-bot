import { Elysia } from "elysia";
import { sendCardToChat, sendMessageToChat } from "../services/feishu";
import { createEvent } from "../services/event-processor";
import { formatMessage } from "../utils/format-message";
import { taskStore } from "../services/task-store";
import { buildFixResultCard } from "../utils/format-card";
import { getTaskType } from "../types";
import type { AnalysisResult, AnalysisTask, AppConfig, FixTask, TriageResult, WorkerTask } from "../types";

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
      const task = taskStore.claim<WorkerTask>();
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
      const task = taskStore.get<WorkerTask>(context.params.id);
      if (!task) {
        context.set.status = 404;
        return { error: "task not found" };
      }
      task.status = "claimed";
      task.updatedAt = new Date().toISOString();
      taskStore.update(task.taskId, { status: "claimed" } as Partial<WorkerTask>);
      return { task };
    })
    .post("/agent/tasks/:id/result", async (context) => {
      if (!requireAuth(context, agentToken)) {
        context.set.status = 401;
        return { error: "unauthorized" };
      }
      const body = (context.body ?? {}) as Record<string, unknown>;
      const taskId = context.params.id;

      const existingTask = taskStore.get<WorkerTask>(taskId);
      if (!existingTask) {
        context.set.status = 404;
        return { error: "task not found" };
      }

      const taskType = getTaskType(existingTask);
      const patch: Record<string, unknown> = {};

      if (taskType === "analysis.run" && body.triageResult) {
        patch.triageResult = body.triageResult as TriageResult;
      }
      if (taskType === "analysis.run" && body.analysisResult) {
        patch.analysisResult = body.analysisResult as AnalysisResult;
      }
      if (taskType === "analysis.run" && body.repoSnapshot) {
        patch.repoSnapshot = body.repoSnapshot as AnalysisTask["repoSnapshot"];
      }
      if (taskType === "fix.run") {
        for (const key of ["outcome", "branchName", "commitSha", "changedFiles", "checks"] as const) {
          if (body[key] !== undefined) Object.assign(patch, { [key]: body[key] });
        }
      }
      const allowedStatuses = taskType === "analysis.run"
        ? ["queued", "claimed", "running", "completed", "failed"]
        : taskType === "fix.run"
          ? ["queued", "claimed", "preparing", "fixing", "validating", "committing", "completed", "failed", "cancelled"]
          : ["queued", "claimed", "running", "completed", "failed"];
      if (body.status && allowedStatuses.includes(body.status as string)) {
        Object.assign(patch, { status: body.status });
      }

      taskStore.update<WorkerTask>(taskId, patch as Partial<WorkerTask>);

      const nextTask = taskStore.get<WorkerTask>(taskId);
      const shouldNotifyStarted =
        body.status === "running" &&
        taskType === "analysis.run" &&
        (patch as Partial<AnalysisTask>).triageResult?.label === "frontend" &&
        !(existingTask as AnalysisTask).startedNotifiedAt &&
        !!nextTask;

      if (shouldNotifyStarted && nextTask) {
        try {
          const analysisTask = nextTask as AnalysisTask;
          const event = createEvent({
            source: "local",
            type: "analysis.task.running",
            payload: {
              taskId: nextTask.taskId,
              issueId: analysisTask.issueId,
              traceId: analysisTask.traceId,
              title: analysisTask.title,
              triageLabel: analysisTask.triageResult?.label,
              triageSource: analysisTask.triageResult?.source,
            },
            meta: {
              taskId: nextTask.taskId,
              issueId: analysisTask.issueId,
              traceId: analysisTask.traceId,
            },
          });

          const messageContent = formatMessage(event, config.userMentions);
          await sendMessageToChat(config, messageContent);
          taskStore.update(taskId, { startedNotifiedAt: new Date().toISOString() });
        } catch (error) {
          console.error("ERROR: 发送开始排查通知失败", (error as Error).message);
        }
      }

      const completedFix = taskType === "fix.run" ? taskStore.get<FixTask>(taskId) : undefined;
      if (
        completedFix &&
        (completedFix.status === "completed" || completedFix.status === "failed") &&
        !completedFix.resultNotifiedAt
      ) {
        try {
          await sendCardToChat(config, buildFixResultCard(completedFix));
          taskStore.update(taskId, { resultNotifiedAt: new Date().toISOString() } as Partial<WorkerTask>);
        } catch (error) {
          console.error("ERROR: 发送修复结果通知失败", (error as Error).message);
        }
      }

      return { success: true };
    });
}
