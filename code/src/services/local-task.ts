import type { AppEvent } from "../types";

export function callLocalMethod(event: AppEvent): { accepted: true } {
  console.log("=== 本地方法执行 ===");
  console.log("事件来源:", event.source);
  console.log("事件类型:", event.type);
  console.log("收到内容:", JSON.stringify(event.payload, null, 2));

  return {
    accepted: true,
  };
}
