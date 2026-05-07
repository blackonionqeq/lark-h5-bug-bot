import { getConfig } from "./config";
import { createCloudTaskApi } from "./poller";
import { reportToCallback } from "./reporter";
import { triage } from "./triage";
import { runClaudeAnalysis } from "./runner";
import { error, log } from "./logger";

const config = getConfig();
const api = createCloudTaskApi(config.cloudUrl, config.agentApiToken);

log("worker", "=== Bug 分析 Worker 启动 ===");
log("worker", `云端地址: ${config.cloudUrl}`);
log("worker", `分析仓库: ${config.repoPath}`);
log("worker", `日志目录: ${config.logDir}`);
log("worker", `轮询间隔: ${config.pollIntervalMs}ms`);
log("worker", `模型: ${config.claudeModel}`);
log("worker", `Claude CLI: ${config.claudeExecutable}`);
log("worker", `分析前脚本: ${config.preAnalysisScript}`);
log("worker", `超时: ${config.timeoutSeconds}s / 最多 ${config.maxTurns} turns`);

let running = false;

async function processOneTask(): Promise<void> {
  if (running) return;

  running = true;
  try {
    // 1. 拉取并认领任务
    const task = await api.fetchPending();
    if (!task) {
      log("worker", "无待处理任务");
      return;
    }

    log("worker", `认领任务: ${task.taskId}, issueId: ${task.issueId ?? "N/A"}`);

    // 2. 分诊
    const triageResult = triage(task.title, task.description);
    log("worker", `分诊结果: ${triageResult.label} — ${triageResult.reason}`);

    // 3. 提交分诊中间状态
    await api.submitResult(task.taskId, {
      status: "running",
      triageResult,
    });

    if (triageResult.label === "non-frontend") {
      log("worker", "非前端 bug，跳过分析");
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

    log("worker", `分析结果: ${analysisResult.status} — ${analysisResult.summary}`);
    log("worker", `日志: ${logPath}`);

    // 5. 回调云端
    await reportToCallback(config.cloudUrl, task, triageResult, analysisResult);

    // 6. 提交最终状态
    await api.submitResult(task.taskId, {
      status: analysisResult.status === "failed" ? "failed" : "completed",
      analysisResult,
    });

    log("worker", `任务完成: ${task.taskId}`);
  } catch (err) {
    error("worker", `处理任务出错: ${(err as Error).message}`);
  } finally {
    running = false;
  }
}

// Main loop
setInterval(async () => {
  try {
    await processOneTask();
  } catch (err) {
    error("worker", `主循环异常: ${(err as Error).message}`);
    running = false;
  }
}, config.pollIntervalMs);

// Graceful shutdown
process.on("SIGINT", () => {
  log("worker", "收到 SIGINT，正在退出...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("worker", "收到 SIGTERM，正在退出...");
  process.exit(0);
});
