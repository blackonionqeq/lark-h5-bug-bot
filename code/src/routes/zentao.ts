import { Elysia } from "elysia";
import { createEvent, handleEvent } from "../services/event-processor";
import { parseZentaoText } from "../utils/parse-zentao";
import type { AppConfig, ZentaoWebhookPayload } from "../types";

export function createZentaoRouter(config: AppConfig) {
  return new Elysia().post("/webhook/zentao", async (context) => {
    const { body, set } = context;

    try {
      console.log("收到禅道 Webhook 请求");
      console.log("原始请求体:", JSON.stringify(body, null, 2));

      const payload = (body ?? {}) as ZentaoWebhookPayload;
      const parsed = parseZentaoText(payload);

      if (!parsed) {
        console.warn("无法解析禅道 webhook text，跳过处理");
        return { success: false, message: "无法解析禅道 webhook 内容" };
      }

      console.log("解析结果:", JSON.stringify(parsed, null, 2));

      const event = createEvent({
        source: "zentao",
        type: "zentao.webhook.received",
        payload: { ...payload, _parsed: parsed },
        meta: {
          issueId: parsed.bugId,
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
