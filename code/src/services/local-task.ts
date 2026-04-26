import type { AppEvent, AnalysisTask, ZentaoWebhookPayload } from "../types";
import { taskStore } from "./task-store";

export function enqueueTask(event: AppEvent): { accepted: boolean; taskId?: string } {
  const payload = event.payload as ZentaoWebhookPayload;

  const task: AnalysisTask = {
    taskId: event.traceId,
    traceId: event.traceId,
    issueId: event.meta.issueId,
    title: typeof payload.title === "string" ? payload.title : undefined,
    description: typeof payload.description === "string" ? payload.description : undefined,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  taskStore.enqueue(task);
  console.log(`[local-task] 任务已入队: ${task.taskId}, issueId: ${task.issueId ?? "N/A"}`);

  return { accepted: true, taskId: task.taskId };
}
