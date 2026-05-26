function requireEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export interface WorkerConfig {
  cloudUrl: string;
  agentApiToken: string;
  repoPath: string;
  logDir: string;
  pollIntervalMs: number;
  maxTurns: number;
  timeoutSeconds: number;
  claudeModel: string;
  claudeExecutable: string;
  codexModel: string;
  codexExecutable: string;
  codexSandbox: string;
  enableCodexFallback: boolean;
  preAnalysisScript: string;
}

export function getConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  const defaults: WorkerConfig = {
    cloudUrl: "",
    agentApiToken: "",
    repoPath: "",
    logDir: "./logs",
    pollIntervalMs: 20000,
    maxTurns: 40,
    timeoutSeconds: 600,
    claudeModel: "sonnet",
    claudeExecutable: "claude",
    codexModel: "",
    codexExecutable: "codex",
    codexSandbox: "read-only",
    enableCodexFallback: true,
    preAnalysisScript: "./scripts/pre-analysis.sh",
  };

  if (overrides) {
    return {
      ...defaults,
      ...overrides,
    };
  }

  return {
    cloudUrl: requireEnv("CLOUD_URL"),
    agentApiToken: requireEnv("AGENT_API_TOKEN"),
    repoPath: requireEnv("REPO_PATH"),
    logDir: Bun.env.LOG_DIR || "./logs",
    pollIntervalMs: Number(Bun.env.POLL_INTERVAL_MS) || 20000,
    maxTurns: Number(Bun.env.MAX_TURNS) || 40,
    timeoutSeconds: Number(Bun.env.TIMEOUT_SECONDS) || 600,
    claudeModel: Bun.env.CLAUDE_MODEL || "sonnet",
    claudeExecutable: Bun.env.CLAUDE_EXECUTABLE || "claude",
    codexModel: Bun.env.CODEX_MODEL || "",
    codexExecutable: Bun.env.CODEX_EXECUTABLE || "codex",
    codexSandbox: Bun.env.CODEX_SANDBOX || "read-only",
    enableCodexFallback: Bun.env.ENABLE_CODEX_FALLBACK !== "false",
    preAnalysisScript: Bun.env.PRE_ANALYSIS_SCRIPT || "./scripts/pre-analysis.sh",
  };
}
