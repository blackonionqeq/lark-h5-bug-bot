import { sendCardToChat, sendMessageToChat } from "./feishu";
import { enqueueTask } from "./local-task";
import { formatMessage } from "../utils/format-message";
import { buildAnalysisResultCard } from "../utils/format-card";
import { taskStore } from "./task-store";
import type { AnalysisCallbackPayload, AppConfig, AppEvent, EventMeta, EventSource, EventType, ZentaoParsedFields } from "../types";

export function createEvent<TPayload extends Record<string, unknown>>({
  source,
  type,
  payload,
  meta,
}: {
  source: EventSource;
  type: EventType;
  payload: TPayload;
  meta?: EventMeta;
}): AppEvent<TPayload> {
  return {
    source,
    type,
    payload,
    meta: meta || {},
    traceId:
      meta?.traceId || `${source}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    timestamp: new Date().toISOString(),
  };
}

function shouldHandleZentaoEvent(event: AppEvent): boolean {
  const payload = event.payload as Record<string, unknown> & { _parsed?: ZentaoParsedFields };
  const status = payload._parsed?.status?.trim().toLowerCase();
  return status === "active";
}

export async function handleEvent(event: AppEvent, config: AppConfig) {
  console.log("收到事件:", {
    source: event.source,
    type: event.type,
    traceId: event.traceId,
  });

  if (event.type === "zentao.webhook.received") {
    if (!shouldHandleZentaoEvent(event)) {
      const payload = event.payload as Record<string, unknown> & {
        _parsed?: { bugId?: string; status?: string; operator?: string; assignee?: string };
      };
      console.log(
        `非 active 禅道 Bug 事件仅发送通知，不进入分析队列: bugId=${payload._parsed?.bugId ?? "unknown"}, status=${payload._parsed?.status ?? "unknown"}, operator=${payload._parsed?.operator ?? "unknown"}, assignee=${payload._parsed?.assignee ?? "unknown"}`
      );
    } else {
      enqueueTask(event);
    }
  }

  let messageResult: Record<string, unknown> | undefined;
  if (event.type === "analysis.result.received") {
    const payload = event.payload as AnalysisCallbackPayload;
    const analysisTask = payload.taskId ? taskStore.get(payload.taskId) : undefined;
    const allowFix = !!(
      (config.larkEncryptKey || config.larkVerificationToken) &&
      analysisTask?.repoSnapshot &&
      !analysisTask.repoSnapshot.dirty
    );
    messageResult = await sendCardToChat(config, buildAnalysisResultCard(payload, allowFix));
    if (payload.taskId) {
      const messageId = typeof messageResult?.message_id === "string" ? messageResult.message_id : undefined;
      taskStore.update(payload.taskId, {
        analysisResult: {
          status: payload.status as "suspected" | "resolved" | "inconclusive" | "skipped" | "failed",
          summary: payload.summary ?? "",
          reason: payload.reason ?? "",
          files: payload.files ?? [],
        },
        resultMessageId: messageId,
      });
    }
  } else {
    const messageContent = formatMessage(event, config.userMentions);
    messageResult = await sendMessageToChat(config, messageContent);
  }

  return {
    traceId: event.traceId,
    messageResult,
  };
}
