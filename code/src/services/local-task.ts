import type { AppEvent, AnalysisTask, ZentaoParsedFields } from "../types";
import { taskStore } from "./task-store";

function buildTaskDescription(parsed: ZentaoParsedFields): string {
  return [
    `状态: ${parsed.status} | 优先级: ${parsed.priority} | 严重程度: ${parsed.severity}`,
    parsed.description ? `描述: ${parsed.description}` : undefined,
    parsed.steps ? `重现步骤: ${parsed.steps}` : undefined,
    parsed.expected ? `期望结果: ${parsed.expected}` : undefined,
    parsed.actual ? `实际结果: ${parsed.actual}` : undefined,
    parsed.link,
  ].filter(Boolean).join("\n");
}

export function enqueueTask(event: AppEvent): { accepted: boolean; taskId?: string } {
  const payload = event.payload as Record<string, unknown> & { _parsed?: ZentaoParsedFields };
  const parsed = payload._parsed;

  const task: AnalysisTask = {
    taskId: event.traceId,
    traceId: event.traceId,
    issueId: event.meta.issueId,
    title: parsed?.title,
    description: parsed ? buildTaskDescription(parsed) : undefined,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  taskStore.enqueue(task);
  console.log(`[local-task] 任务已入队: ${task.taskId}, issueId: ${task.issueId ?? "N/A"}`);

  return { accepted: true, taskId: task.taskId };
}
