import { getConfig } from "./config";
import { createCloudTaskApi } from "./poller";
import { reportToCallback } from "./reporter";
import { triage } from "./triage";
import { runAgentAnalysis } from "./runner";
import { runFixAgent } from "./fix-runner";
import { cleanupFixBranch, commitFix, getRepoSnapshot, runProjectChecks, validateWorkspaceChanges, withPreparedFixWorkspace } from "./fix-workspace";
import { error, log } from "./logger";
import { getTaskType } from "../../code/src/types";
import type { AnalysisTask, FixCleanupTask, FixTask } from "../../code/src/types";

const config = getConfig();
const api = createCloudTaskApi(config.cloudUrl, config.agentApiToken);

log("worker", "=== Bug 分析 Worker 启动 ===");
log("worker", `云端地址: ${config.cloudUrl}`);
log("worker", `分析仓库: ${config.repoPath}`);
log("worker", `修复工作区根目录: ${config.fixWorktreeRoot}`);
log("worker", `日志目录: ${config.logDir}`);
log("worker", `轮询间隔: ${config.pollIntervalMs}ms`);
log("worker", `Agent 顺序: ${config.agentProviderOrder.join(" -> ")}`);
log("worker", `Claude 模型: ${config.claudeModel}`);
log("worker", `Claude CLI: ${config.claudeExecutable}`);
log("worker", `Codex CLI: ${config.codexExecutable}`);
log("worker", `分析前脚本: ${config.preAnalysisScript}`);
log("worker", `项目补充提示词: ${config.projectContextFile || "./prompts/project-context.local.md（可选）"}`);
log("worker", `超时: ${config.timeoutSeconds}s / 最多 ${config.maxTurns} turns`);

let running = false;

async function processAnalysisTask(task: AnalysisTask): Promise<void> {
    log("worker", `认领分析任务: ${task.taskId}, issueId: ${task.issueId ?? "N/A"}`);
    const triageResult = triage(task.title, task.description);
    log("worker", `分诊结果: ${triageResult.label} — ${triageResult.reason}`);
    const repoSnapshot = await getRepoSnapshot(config.repoPath);

    await api.submitResult(task.taskId, {
      status: "running",
      triageResult,
      repoSnapshot,
    });

    if (triageResult.label === "non-frontend") {
      log("worker", "非前端 bug，跳过分析");
      await reportToCallback(config.cloudUrl, config.agentApiToken, task, triageResult, {
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

    const { result: analysisResult, logPath } = await runAgentAnalysis(
      task.title ?? "",
      task.description ?? "",
      task.taskId,
      config
    );

    log("worker", `分析结果: ${analysisResult.status} — ${analysisResult.summary}`);
    log("worker", `日志: ${logPath}`);

    await reportToCallback(config.cloudUrl, config.agentApiToken, task, triageResult, analysisResult);

    await api.submitResult(task.taskId, {
      status: analysisResult.status === "failed" ? "failed" : "completed",
      analysisResult,
    });

    log("worker", `任务完成: ${task.taskId}`);
}

async function processFixTask(task: FixTask): Promise<void> {
  log("worker", `认领修复任务: ${task.taskId}, issueId: ${task.issueId ?? "N/A"}`);
  await api.submitResult(task.taskId, { status: "preparing" });
  const result = await withPreparedFixWorkspace(task, config, async (workspacePath) => {
    await api.submitResult(task.taskId, { status: "fixing" });
    const agent = await runFixAgent(task, workspacePath, config);
    log("worker", `修复 Agent 结果: ${agent.result.status} — ${agent.result.summary}`);
    if (agent.result.status === "failed") throw new Error(agent.result.summary);

    await api.submitResult(task.taskId, { status: "validating" });
    await validateWorkspaceChanges(workspacePath);
    const checks = await runProjectChecks(workspacePath);
    await api.submitResult(task.taskId, { status: "committing", checks });
    const commit = await commitFix(task, workspacePath, config, checks);
    return { ...commit, checks };
  });

  await api.submitResult(task.taskId, {
    status: "completed",
    outcome: result.outcome,
    branchName: result.branchName,
    commitSha: result.commitSha,
    changedFiles: result.changedFiles,
    checks: result.checks,
  });
  log("worker", `修复任务完成: ${task.taskId}, outcome=${result.outcome}, commit=${result.commitSha ?? "N/A"}`);
}

async function processCleanupTask(task: FixCleanupTask): Promise<void> {
  await api.submitResult(task.taskId, { status: "running" });
  await cleanupFixBranch(task, config);
  await api.submitResult(task.taskId, { status: "completed" });
}

async function processOneTask(): Promise<void> {
  if (running) return;

  running = true;
  let taskId: string | undefined;
  try {
    const task = await api.fetchPending();
    if (!task) {
      log("worker", "无待处理任务");
      return;
    }
    taskId = task.taskId;
    const taskType = getTaskType(task);
    if (taskType === "analysis.run") await processAnalysisTask(task as AnalysisTask);
    else if (taskType === "fix.run") await processFixTask(task as FixTask);
    else await processCleanupTask(task as FixCleanupTask);
  } catch (err) {
    error("worker", `处理任务出错: ${(err as Error).message}`);
    if (taskId) await api.submitResult(taskId, { status: "failed" }).catch(() => undefined);
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
