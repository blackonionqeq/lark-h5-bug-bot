import { error, log } from "./logger";
import type { AnalysisResult, TriageResult, AnalysisTask } from "../../code/src/types";

export async function reportToCallback(
  cloudUrl: string,
  task: AnalysisTask,
  triageResult: TriageResult,
  analysisResult: AnalysisResult
): Promise<void> {
  const payload = {
    taskId: task.taskId,
    issueId: task.issueId,
    traceId: task.traceId,
    status: analysisResult.status,
    summary: analysisResult.summary,
    reason: analysisResult.reason,
    triageLabel: triageResult.label,
    triageSource: triageResult.source,
    files: analysisResult.files,
  };

  log("reporter", `回调云端: ${cloudUrl}/callback/analysis-result`);

  const res = await fetch(`${cloudUrl}/callback/analysis-result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    error("reporter", `回调失败: HTTP ${res.status}`);
  } else {
    log("reporter", "回调成功");
  }
}
