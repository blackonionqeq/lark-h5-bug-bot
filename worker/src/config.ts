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
  preAnalysisScript: string;
}

export function getConfig(overrides?: Partial<WorkerConfig>): WorkerConfig {
  const defaults: WorkerConfig = {
    cloudUrl: "",
    agentApiToken: "",
    repoPath: "",
    logDir: "./logs",
    pollIntervalMs: 20000,
    maxTurns: 20,
    timeoutSeconds: 300,
    claudeModel: "sonnet",
    claudeExecutable: "claude",
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
    maxTurns: Number(Bun.env.MAX_TURNS) || 20,
    timeoutSeconds: Number(Bun.env.TIMEOUT_SECONDS) || 300,
    claudeModel: Bun.env.CLAUDE_MODEL || "sonnet",
    claudeExecutable: Bun.env.CLAUDE_EXECUTABLE || "claude",
    preAnalysisScript: Bun.env.PRE_ANALYSIS_SCRIPT || "./scripts/pre-analysis.sh",
  };
}
