import type { AnalysisTask, TriageResult, AnalysisResult } from "../../code/src/types";
import type { WorkerConfig } from "./config";

export function makeWorkerConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  const config: WorkerConfig = {
    cloudUrl: "http://localhost:9999",
    agentApiToken: "test-token",
    repoPath: "/tmp/test-repo",
    logDir: "/tmp/test-logs",
    pollIntervalMs: 20000,
    maxTurns: 40,
    timeoutSeconds: 600,
    claudeModel: "sonnet",
    claudeExecutable: "claude",
    codexModel: "",
    codexExecutable: "codex",
    codexSandbox: "read-only",
    enableCodexFallback: true,
    agentProviderOrder: ["claude", "codex"],
    preAnalysisScript: "",
    projectContextFile: "",
    ...overrides,
  };

  if (overrides?.enableCodexFallback === false && !overrides.agentProviderOrder) {
    config.agentProviderOrder = ["claude"];
  }

  return config;
}

export function makeAnalysisTask(overrides?: Partial<AnalysisTask>): AnalysisTask {
  return {
    taskId: "task-001",
    traceId: "trace-001",
    issueId: "BUG-100",
    title: "页面白屏报错",
    description: "用户打开首页时页面白屏，控制台报错 TypeError: Cannot read property 'foo' of undefined",
    status: "claimed",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeTriageResult(overrides?: Partial<TriageResult>): TriageResult {
  return {
    label: "frontend",
    source: "rules",
    reason: "命中规则: frontend:/页面/, frontend:/白屏/",
    matchedRules: ["frontend:/页面/", "frontend:/白屏/"],
    ...overrides,
  };
}

export function makeAnalysisResult(overrides?: Partial<AnalysisResult>): AnalysisResult {
  return {
    status: "suspected",
    summary: "疑似由空值判断缺失导致",
    reason: "在 src/components/Header.tsx 中发现未做 null check",
    files: ["src/components/Header.tsx"],
    ...overrides,
  };
}
