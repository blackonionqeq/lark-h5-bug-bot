import type { AppEvent } from "../types";

function stringifyPayload(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

export function formatMessage(event: AppEvent): string {
  if (event.type === "analysis.result.received") {
    return [
      "自动查 bug 结果已返回",
      `source: ${event.source}`,
      event.meta.taskId ? `taskId: ${event.meta.taskId}` : null,
      event.meta.issueId ? `issueId: ${event.meta.issueId}` : null,
      stringifyPayload(event.payload),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  return stringifyPayload(event.payload);
}
