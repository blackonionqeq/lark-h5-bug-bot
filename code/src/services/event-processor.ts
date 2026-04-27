import { sendMessageToChat } from "./feishu";
import { enqueueTask } from "./local-task";
import { formatMessage } from "../utils/format-message";
import type { AppConfig, AppEvent, EventMeta, EventSource, EventType } from "../types";

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

export async function handleEvent(event: AppEvent, config: AppConfig) {
  console.log("收到事件:", {
    source: event.source,
    type: event.type,
    traceId: event.traceId,
  });

  if (event.type === "zentao.webhook.received") {
    enqueueTask(event);
  }

  const messageContent = formatMessage(event, config.userMentions);
  const messageResult = await sendMessageToChat(config, messageContent);

  return {
    traceId: event.traceId,
    messageResult,
  };
}
