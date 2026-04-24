import { Elysia } from "elysia";
import { createEvent, handleEvent } from "../services/event-processor";
import type { AnalysisCallbackPayload, AppConfig } from "../types";

export function createAnalysisCallbackRouter(config: AppConfig) {
  return new Elysia().post("/callback/analysis-result", async (context) => {
    const { body, set } = context;

    try {
      console.log("收到自动查 bug 结果回调");

      const payload = (body ?? {}) as AnalysisCallbackPayload;
      const event = createEvent({
        source: "bugbot-callback",
        type: "analysis.result.received",
        payload,
        meta: {
          taskId: payload.taskId,
          issueId: payload.issueId,
          traceId: payload.traceId,
        },
      });

      const result = await handleEvent(event, config);

      return {
        success: true,
        message: "分析结果已转发到飞书群聊",
        traceId: result.traceId,
      };
    } catch (error) {
      set.status = 500;
      console.error("ERROR: 处理分析结果回调失败", (error as Error).message);
      return { success: false, error: (error as Error).message };
    }
  });
}
