import { Elysia } from "elysia";
import { taskStore } from "../services/task-store";
import type { AnalysisResult, AnalysisTask, TriageResult } from "../types";

function requireAuth(context: { headers: Record<string, string | undefined> }, expectedToken: string): boolean {
  const auth = context.headers["authorization"];
  if (!auth) return false;
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  return token === expectedToken;
}

export function createAgentTasksRouter(agentToken: string) {
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

      if (!taskStore.get(taskId)) {
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
      return { success: true };
    });
}
