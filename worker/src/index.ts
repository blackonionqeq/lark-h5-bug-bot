import { getConfig } from "./config";
import { createCloudTaskApi } from "./poller";
import { reportToCallback } from "./reporter";
import { triage } from "./triage";
import { runClaudeAnalysis } from "./runner";

const config = getConfig();
const api = createCloudTaskApi(config.cloudUrl, config.agentApiToken);

console.log("=== Bug 分析 Worker 启动 ===");
console.log(`云端地址: ${config.cloudUrl}`);
console.log(`分析仓库: ${config.repoPath}`);
console.log(`日志目录: ${config.logDir}`);
console.log(`轮询间隔: ${config.pollIntervalMs}ms`);
console.log(`模型: ${config.claudeModel}`);
console.log(`Claude CLI: ${config.claudeExecutable}`);
console.log(`超时: ${config.timeoutSeconds}s / 最多 ${config.maxTurns} turns`);

let running = false;

async function processOneTask(): Promise<void> {
  if (running) return;

  running = true;
  try {
    // 1. 拉取并认领任务
    const task = await api.fetchPending();
    if (!task) {
      console.log(`[worker] 无待处理任务, ${new Date().toISOString()}`);
      return;
    }

    console.log(`[worker] 认领任务: ${task.taskId}, issueId: ${task.issueId ?? "N/A"}`);

    // 2. 分诊
    const triageResult = triage(task.title, task.description);
    console.log(`[worker] 分诊结果: ${triageResult.label} — ${triageResult.reason}`);

    // 3. 提交分诊中间状态
    await api.submitResult(task.taskId, {
      status: "running",
      triageResult,
    });

    if (triageResult.label === "non-frontend") {
      console.log(`[worker] 非前端 bug，跳过分析`);
      await reportToCallback(config.cloudUrl, task, triageResult, {
        status: "skipped",
        summary: "非前端问题，已跳过",
        reason: triageResult.reason,
        files: [],
      });
      await api.submitResult(task.taskId, {
        status: "completed",
        analysisResult: {
          status: "skipped",
          summary: "非前端问题，已跳过",
          reason: triageResult.reason,
          files: [],
        },
      });
      return;
    }

    // 4. 执行 Claude Code 分析
    const { result: analysisResult, logPath } = await runClaudeAnalysis(
      task.title ?? "",
      task.description ?? "",
      task.taskId,
      config
    );

    console.log(`[worker] 分析结果: ${analysisResult.status} — ${analysisResult.summary}`);
    console.log(`[worker] 日志: ${logPath}`);

    // 5. 回调云端
    await reportToCallback(config.cloudUrl, task, triageResult, analysisResult);

    // 6. 提交最终状态
    await api.submitResult(task.taskId, {
      status: analysisResult.status === "failed" ? "failed" : "completed",
      analysisResult,
    });

    console.log(`[worker] 任务完成: ${task.taskId}`);
  } catch (err) {
    console.error("[worker] 处理任务出错:", (err as Error).message);
  } finally {
    running = false;
  }
}

// Main loop
setInterval(async () => {
  try {
    await processOneTask();
  } catch (err) {
    console.error("[worker] 主循环异常:", (err as Error).message);
    running = false;
  }
}, config.pollIntervalMs);

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n[worker] 收到 SIGINT，正在退出...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[worker] 收到 SIGTERM，正在退出...");
  process.exit(0);
});
