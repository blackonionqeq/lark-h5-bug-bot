import { Elysia } from "elysia";
import { getConfig } from "./config";
import { createZentaoRouter } from "./routes/zentao";
import { createAnalysisCallbackRouter } from "./routes/analysis-callback";
import { createAgentTasksRouter } from "./routes/agent-tasks";

const config = getConfig();

const app = new Elysia({ name: "lark-h5-bug-bot" })
  .use(createZentaoRouter(config))
  .use(createAnalysisCallbackRouter(config))
  .use(createAgentTasksRouter(config))
  .listen(config.port);

console.log("飞书机器人服务已启动，等待事件触发...");
console.log(`服务器正在监听端口 ${app.server?.port ?? config.port}`);
console.log("Webhook 地址: http://your-domain.com/webhook/zentao");
console.log("分析结果回调地址: http://your-domain.com/callback/analysis-result");
if (config.agentApiToken) {
  console.log("Agent API 已启用: /agent/tasks/*");
}
