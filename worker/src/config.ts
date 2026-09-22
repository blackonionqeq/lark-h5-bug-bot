import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

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
  agentProviderOrder: AgentProvider[];
  preAnalysisScript: string;
  bashExecutable: string;
  projectContextFile: string;
}

export type AgentProvider = "claude" | "codex";

export function resolveRepoPath(repoPath: string): string {
  return isAbsolute(repoPath) ? repoPath : resolve(REPOSITORY_ROOT, repoPath);
}

function requireRepoPath(): string {
  const repoPath = resolveRepoPath(requireEnv("REPO_PATH"));
  if (!existsSync(repoPath)) {
    throw new Error(`REPO_PATH directory does not exist: ${repoPath}`);
  }
  return repoPath;
}

function getDefaultBashExecutable(): string {
  if (process.platform !== "win32") return Bun.which("bash") || "bash";

  const candidates = [
    join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "bash.exe"),
    process.env["ProgramFiles(x86)"]
      ? join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe")
      : "",
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe")
      : "",
  ];

  return candidates.find((candidate) => candidate && existsSync(candidate)) || Bun.which("bash") || "bash";
}

function parseAgentProviderOrder(value: string): AgentProvider[] {
  const providers = value
    .split(",")
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean);

  if (providers.length === 0) {
    throw new Error("AGENT_PROVIDER_ORDER must include at least one provider");
  }

  const uniqueProviders: AgentProvider[] = [];
  for (const provider of providers) {
    if (provider !== "claude" && provider !== "codex") {
      throw new Error(`Invalid AGENT_PROVIDER_ORDER provider: ${provider}`);
    }
    if (!uniqueProviders.includes(provider)) {
      uniqueProviders.push(provider);
    }
  }

  return uniqueProviders;
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
    agentProviderOrder: ["codex", "claude"],
    preAnalysisScript: "./scripts/pre-analysis.sh",
    bashExecutable: getDefaultBashExecutable(),
    projectContextFile: "",
  };

  if (overrides) {
    return {
      ...defaults,
      ...overrides,
    };
  }

  const enableCodexFallback = Bun.env.ENABLE_CODEX_FALLBACK !== "false";
  const agentProviderOrder = Bun.env.AGENT_PROVIDER_ORDER
    ? parseAgentProviderOrder(Bun.env.AGENT_PROVIDER_ORDER)
    : enableCodexFallback
      ? defaults.agentProviderOrder
      : (["claude"] satisfies AgentProvider[]);

  return {
    cloudUrl: requireEnv("CLOUD_URL"),
    agentApiToken: requireEnv("AGENT_API_TOKEN"),
    repoPath: requireRepoPath(),
    logDir: Bun.env.LOG_DIR || "./logs",
    pollIntervalMs: Number(Bun.env.POLL_INTERVAL_MS) || 20000,
    maxTurns: Number(Bun.env.MAX_TURNS) || 40,
    timeoutSeconds: Number(Bun.env.TIMEOUT_SECONDS) || 600,
    claudeModel: Bun.env.CLAUDE_MODEL || "sonnet",
    claudeExecutable: Bun.env.CLAUDE_EXECUTABLE || "claude",
    codexModel: Bun.env.CODEX_MODEL || "",
    codexExecutable: Bun.env.CODEX_EXECUTABLE || "codex",
    codexSandbox: Bun.env.CODEX_SANDBOX || "read-only",
    enableCodexFallback,
    agentProviderOrder,
    preAnalysisScript: Bun.env.PRE_ANALYSIS_SCRIPT || "./scripts/pre-analysis.sh",
    bashExecutable: Bun.env.BASH_EXECUTABLE || getDefaultBashExecutable(),
    projectContextFile: Bun.env.PROJECT_CONTEXT_FILE || "",
  };
}
