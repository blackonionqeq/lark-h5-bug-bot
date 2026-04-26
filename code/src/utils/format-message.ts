import type { AppEvent, AnalysisCallbackPayload } from "../types";

function stringifyPayload(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

export function formatMessage(event: AppEvent): string {
  if (event.type === "analysis.result.received") {
    const p = event.payload as AnalysisCallbackPayload;
    const statusEmoji: Record<string, string> = {
      suspected: "⚠️",
      resolved: "✅",
      inconclusive: "❓",
      skipped: "⏭️",
      failed: "❌",
    };

    const lines: string[] = [];
    lines.push(`${statusEmoji[p.status ?? "inconclusive"] ?? "❓"} 自动查 bug 结果`);
    if (event.meta.issueId) lines.push(`Issue: ${event.meta.issueId}`);
    if (p.triageLabel) lines.push(`分诊: ${p.triageLabel} (${p.triageSource ?? "unknown"})`);
    if (p.summary) lines.push(`结论: ${p.summary}`);
    if (p.reason) lines.push(`分析: ${p.reason}`);
    if (p.files && p.files.length > 0) lines.push(`文件:\n${p.files.map((f) => `  - ${f}`).join("\n")}`);

    return lines.join("\n\n");
  }

  if (event.type === "zentao.webhook.received") {
    const p = event.payload as Record<string, unknown>;
    const lines: string[] = ["收到禅道 Bug"];
    if (p.title) lines.push(`标题: ${p.title}`);
    if (event.meta.issueId) lines.push(`ID: ${event.meta.issueId}`);
    if (p.description) lines.push(`描述: ${String(p.description).slice(0, 200)}`);
    return lines.join("\n\n");
  }

  return stringifyPayload(event.payload);
}
