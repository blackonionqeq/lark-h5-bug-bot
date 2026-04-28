import { sendMessageToChat } from "./feishu";
import { enqueueTask } from "./local-task";
import { formatMessage } from "../utils/format-message";
import type { AppConfig, AppEvent, EventMeta, EventSource, EventType, ZentaoParsedFields } from "../types";

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

  const messageContent = formatMessage(event, config.userMentions);
  const messageResult = await sendMessageToChat(config, messageContent);

  return {
    traceId: event.traceId,
    messageResult,
  };
}
