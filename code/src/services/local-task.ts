import type { AppEvent, AnalysisTask, ZentaoParsedFields } from "../types";
import { taskStore } from "./task-store";

/** 禅道原生 webhook 默认只推 action 表的列，不带 bug 的描述/步骤 —— 明说清楚，
 *  免得 agent 把「上游没给」当成「任务描述有问题」而在结论里反复抱怨。
 *  注意：禅道侧补了扩展字段（steps 等）时不能再报「未提供复现步骤」，否则自相矛盾 */
const MISSING_DESCRIPTION_HINT = "（禅道 webhook 未提供描述与复现步骤，请仅依据标题、链接与代码证据判断）";

function buildTaskDescription(parsed: ZentaoParsedFields): string {
  const metaParts = [
    parsed.status && `状态: ${parsed.status}`,
    parsed.priority && `优先级: ${parsed.priority}`,
    parsed.severity && `严重程度: ${parsed.severity}`,
  ].filter(Boolean);

  // 描述缺失时：有复现步骤就干脆不写「描述:」这行（正文已经在步骤里），
  // 两者都缺才补一句说明，避免 agent 把「上游没给」误判成报告本身有问题
  const descriptionLine = parsed.description
    ? `描述: ${parsed.description}`
    : parsed.steps
      ? undefined
      : `描述: ${MISSING_DESCRIPTION_HINT}`;

  return [
    metaParts.join(" | "),
    descriptionLine,
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
