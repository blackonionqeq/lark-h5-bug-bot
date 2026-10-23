import type { AnalysisCallbackPayload, FixTask } from "../types";

function escapeMarkdown(value: string): string {
  return value.replace(/[\\*_~`]/g, "\\$&");
}

export function buildAnalysisResultCard(payload: AnalysisCallbackPayload, allowFix = true): Record<string, unknown> {
  const canFix = allowFix && payload.status === "resolved" && !!payload.taskId;
  const content = [
    payload.issueId ? `**Issue:** ${escapeMarkdown(String(payload.issueId))}` : undefined,
    payload.summary ? `**结论:** ${escapeMarkdown(payload.summary)}` : undefined,
    payload.reason ? `**分析:** ${escapeMarkdown(payload.reason)}` : undefined,
    payload.files?.length ? `**相关文件:**\n${payload.files.map((file) => `- ${escapeMarkdown(file)}`).join("\n")}` : undefined,
  ].filter(Boolean).join("\n\n");

  const elements: Record<string, unknown>[] = [
    { tag: "div", text: { tag: "lark_md", content } },
  ];
  if (canFix) {
    elements.push({
      tag: "action",
      actions: [{
        tag: "button",
        text: { tag: "plain_text", content: "尝试修复" },
        type: "primary",
        value: { action: "fix.request", analysisTaskId: payload.taskId },
      }],
    });
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: payload.status === "resolved" ? "green" : "orange",
      title: { tag: "plain_text", content: "自动查 Bug 结果" },
    },
    elements,
  };
}

export function buildFixResultCard(task: FixTask): Record<string, unknown> {
  const checks = task.checks?.map((check) => `${check.status === "passed" ? "✅" : check.status === "failed" ? "❌" : "⏭️"} ${check.command}`).join("\n") || "未发现可运行检查";
  const ready = task.outcome === "ready_for_verification";
  const outcomeText: Record<string, string> = {
    ready_for_verification: "修复已准备好，等待人工验证",
    validation_failed: "修改已提交，但自动检查未通过；不建议直接 cherry-pick",
    no_changes: "Agent 未产生可提交的修改",
    stale_analysis: "分析基线已过期，需要重新分析",
    workspace_conflict: "本地修复工作区冲突",
  };
  const content = [
    task.issueId ? `**Issue:** ${escapeMarkdown(String(task.issueId))}` : undefined,
    `**结果:** ${outcomeText[task.outcome ?? ""] ?? "修复失败"}`,
    task.branchName ? `**分支:** ${escapeMarkdown(task.branchName)}` : undefined,
    task.commitSha ? `**提交:** ${task.commitSha}` : undefined,
    `**检查:**\n${checks}`,
    task.changedFiles?.length ? `**修改文件:**\n${task.changedFiles.map((file) => `- ${escapeMarkdown(file)}`).join("\n")}` : undefined,
    task.commitSha ? `**在你的开发分支执行：**\n\`git cherry-pick ${task.commitSha}\`` : undefined,
  ].filter(Boolean).join("\n\n");

  const elements: Record<string, unknown>[] = [{ tag: "div", text: { tag: "lark_md", content } }];
  if (task.branchName && task.commitSha) {
    elements.push({
      tag: "action",
      layout: "bisected",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "已处理" },
          type: "primary",
          value: { action: "fix.cleanup", fixTaskId: task.taskId, resolution: "handled" },
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "放弃修复" },
          type: "danger",
          value: { action: "fix.cleanup", fixTaskId: task.taskId, resolution: "discarded" },
        },
      ],
    });
  }

  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: ready ? "green" : "orange",
      title: { tag: "plain_text", content: "Bug 自动修复结果" },
    },
    elements,
  };
}

export function buildFixQueuedCard(issueId?: string | number): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: "blue", title: { tag: "plain_text", content: "Bug 修复已排队" } },
    elements: [{
      tag: "div",
      text: { tag: "lark_md", content: issueId ? `Issue ${escapeMarkdown(String(issueId))} 已进入本地修复队列。` : "修复任务已进入本地队列。" },
    }],
  };
}
