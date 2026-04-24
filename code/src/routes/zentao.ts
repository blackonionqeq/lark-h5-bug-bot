import { Elysia } from "elysia";
import { createEvent, handleEvent } from "../services/event-processor";
import type { AppConfig, ZentaoWebhookPayload } from "../types";

export function createZentaoRouter(config: AppConfig) {
  return new Elysia().post("/webhook/zentao", async (context) => {
    const { body, set } = context;

    try {
      console.log("收到禅道 Webhook 请求");

      const payload = (body ?? {}) as ZentaoWebhookPayload;
      const event = createEvent({
        source: "zentao",
        type: "zentao.webhook.received",
        payload,
        meta: {
          issueId: payload.id ?? payload.bugId ?? payload.issueId,
        },
      });

      await handleEvent(event, config);

      console.log("处理完成，返回成功响应");
      return { success: true, message: "消息已转发到飞书群聊" };
    } catch (error) {
      set.status = 500;
      console.error("ERROR: 处理 Webhook 请求失败", (error as Error).message);
      return { success: false, error: (error as Error).message };
    }
  });
}
