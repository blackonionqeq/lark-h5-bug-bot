import type { AppEvent, AnalysisCallbackPayload, ZentaoParsedFields } from "../types";

function stringifyPayload(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

export function formatMessage(event: AppEvent, userMentions?: Record<string, string>): string {
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
    const p = event.payload as Record<string, unknown> & { _parsed?: ZentaoParsedFields };
    const parsed = p._parsed;
    if (!parsed) {
      return `收到禅道 Bug 通知`;
    }

    const statusEmoji: Record<string, string> = {
      active: "🔴",
      resolved: "🟢",
      closed: "✅",
    };
    const emoji = statusEmoji[parsed.status] ?? "🟡";

    const lines: string[] = [];
    lines.push(`${emoji} 禅道 Bug #${parsed.bugId} — ${parsed.title}`);
    lines.push(`状态: ${parsed.status} | 优先级: ${parsed.priority} | 严重程度: ${parsed.severity}`);
    lines.push(`创建人: ${parsed.creator} → 操作人: ${parsed.operator} → 指派人: ${mentionUser(parsed.assignee, userMentions)}`);
    if (parsed.description) lines.push(`描述: ${parsed.description}`);
    if (parsed.steps) lines.push(`重现步骤: ${parsed.steps}`);
    if (parsed.expected) lines.push(`期望结果: ${parsed.expected}`);
    if (parsed.actual) lines.push(`实际结果: ${parsed.actual}`);
    if (parsed.link) lines.push(`详情: ${parsed.link}`);
    return lines.join("\n");
  }

  return stringifyPayload(event.payload);
}

function mentionUser(name: string, userMentions?: Record<string, string>): string {
  const openId = userMentions?.[name];
  if (openId) {
    return `<at user_id="${openId}">${name}</at>`;
  }
  return name;
}
