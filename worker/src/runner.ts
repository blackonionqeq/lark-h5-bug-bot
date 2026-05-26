import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { error, log } from "./logger";
import type { WorkerConfig } from "./config";
import type { AnalysisResult } from "../../code/src/types";

type SpawnOptions = {
  cwd: string;
  stdout: "pipe";
  stderr: "pipe";
};

type SpawnedProcess = {
  exited: Promise<number | null>;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  kill(): void;
};

type PreAnalysisResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

type AgentProvider = "claude" | "codex";

type AgentRunResult = {
  provider: AgentProvider;
  result: AnalysisResult;
  logPath: string;
};

export interface RunnerDeps {
  spawn(command: string[], options: SpawnOptions): SpawnedProcess;
  runPreAnalysisScript(scriptPath: string, cwd: string): Promise<PreAnalysisResult>;
  setTimeoutFn(callback: () => void, ms: number): unknown;
  clearTimeoutFn(timeoutHandle: unknown): void;
}

const defaultRunnerDeps: RunnerDeps = {
  spawn(command, options) {
    return Bun.spawn(command, options);
  },
  async runPreAnalysisScript(scriptPath, cwd) {
    const proc = Bun.spawn([scriptPath], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
      proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
    ]);
    return { exitCode, stdout, stderr };
  },
  setTimeoutFn(callback, ms) {
    return setTimeout(callback, ms);
  },
  clearTimeoutFn(timeoutHandle) {
    clearTimeout(timeoutHandle as ReturnType<typeof setTimeout>);
  },
};

async function buildPrompt(provider: AgentProvider, title: string, description: string): Promise<string> {
  const templateName = provider === "claude" ? "analyze-bug.txt" : "analyze-bug-codex.txt";
  const templatePath = fileURLToPath(new URL(`../prompts/${templateName}`, import.meta.url));
  const template = await readFile(templatePath, "utf-8");
  return template.replace("{title}", title).replace("{description}", description);
}

function resolveWorkerPath(path: string): string {
  if (isAbsolute(path)) return path;
  return resolve(fileURLToPath(new URL("..", import.meta.url)), path);
}

function parseAnalysisText(text: string, providerLabel: string): AnalysisResult {
  if (!text.trim()) {
    return {
      status: "failed",
      summary: "分析结果为空，请检查模型唤起是否异常",
      reason: `${providerLabel} 返回了空结果，未产出任何分析文本；请检查模型服务、CLI 调用链路或鉴权状态。`,
      files: [],
    };
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      status: parsed.status ?? "inconclusive",
      summary: parsed.summary ?? "",
      reason: parsed.reason ?? "",
      files: parsed.files ?? [],
    };
  }

  return {
    status: "failed",
    summary: "分析结果格式不正确",
    reason: `${providerLabel} 已返回文本，但未输出约定的 JSON 对象。原始输出片段: ${text.slice(0, 500)}`,
    files: [],
  };
}

export function extractClaudeResult(jsonl: string): AnalysisResult {
  const lines = jsonl.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);
      if (event.type === "result") {
        const text: string = event.result ?? "";
        return parseAnalysisText(text, "Claude CLI");
      }
    } catch {
      // skip unparseable lines
    }
  }
  return { status: "failed", summary: "无法提取分析结果", reason: "JSONL 中未找到 result 事件", files: [] };
}

export function extractCodexResult(jsonl: string): AnalysisResult {
  const lines = jsonl.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        const text: string = event.item.text ?? "";
        return parseAnalysisText(text, "Codex CLI");
      }
    } catch {
      // skip unparseable lines
    }
  }
  return { status: "failed", summary: "无法提取分析结果", reason: "JSONL 中未找到 Codex agent_message 事件", files: [] };
}

export const extractResult = extractClaudeResult;

function buildClaudeCommand(config: WorkerConfig, prompt: string): string[] {
  return [
    config.claudeExecutable,
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    String(config.maxTurns),
    "--model",
    config.claudeModel,
  ];
}

function buildCodexCommand(config: WorkerConfig, prompt: string): string[] {
  const command = [config.codexExecutable, "--ask-for-approval", "never"];
  if (config.codexModel) {
    command.push("--model", config.codexModel);
  }
  command.push("exec", "--json", "--sandbox", config.codexSandbox, prompt);
  return command;
}

async function runProviderAnalysis(
  provider: AgentProvider,
  prompt: string,
  taskId: string,
  config: WorkerConfig,
  deps: RunnerDeps
): Promise<AgentRunResult> {
  const logPath = join(config.logDir, `${taskId}-${provider}.jsonl`);
  const command = provider === "claude" ? buildClaudeCommand(config, prompt) : buildCodexCommand(config, prompt);

  log("runner", `启动 ${provider} 分析, taskId=${taskId}`);
  log("runner", `${provider} 日志文件: ${logPath}`);

  const proc = deps.spawn(command, {
    cwd: config.repoPath,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = deps.setTimeoutFn(() => {
    log("runner", `${provider} 分析超时 (${config.timeoutSeconds}s), 正在终止进程`);
    proc.kill();
  }, config.timeoutSeconds * 1000);

  const exitCode = await proc.exited;
  deps.clearTimeoutFn(timeout);

  const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
  const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";

  await writeFile(logPath, stdout, "utf-8");

  if (exitCode === 124 || exitCode === null) {
    error("runner", `${provider} 分析超时或被终止`);
    return {
      provider,
      result: { status: "failed", summary: "分析超时", reason: `${provider} 超时限制 ${config.timeoutSeconds}s`, files: [] },
      logPath,
    };
  }

  if (exitCode !== 0) {
    const providerLabel = provider === "claude" ? "Claude CLI" : "Codex CLI";
    error("runner", `${providerLabel} 退出码: ${exitCode}`);
    error("runner", `stderr: ${stderr.slice(0, 500)}`);
    return {
      provider,
      result: {
        status: "failed",
        summary: `${providerLabel} 异常退出 (${exitCode})`,
        reason: (stderr || stdout).slice(0, 500),
        files: [],
      },
      logPath,
    };
  }

  const result = provider === "claude" ? extractClaudeResult(stdout) : extractCodexResult(stdout);
  log("runner", `${provider} 分析完成, status=${result.status}`);
  return { provider, result, logPath };
}

function combineFailedResults(primary: AgentRunResult, fallback: AgentRunResult): AnalysisResult {
  return {
    status: "failed",
    summary: "Claude 与 Codex 分析均失败",
    reason: [
      `Claude: ${primary.result.summary}; ${primary.result.reason}; log=${primary.logPath}`,
      `Codex: ${fallback.result.summary}; ${fallback.result.reason}; log=${fallback.logPath}`,
    ].join("\n"),
    files: [],
  };
}

export async function runAgentAnalysis(
  title: string,
  description: string,
  taskId: string,
  config: WorkerConfig,
  deps?: Partial<RunnerDeps>
): Promise<{ result: AnalysisResult; logPath: string }> {
  const runnerDeps: RunnerDeps = {
    ...defaultRunnerDeps,
    ...deps,
  };

  const prompt = await buildPrompt("claude", title, description);

  // Write prompt to temp file
  const promptFile = join(tmpdir(), `${taskId}-prompt.txt`);
  await writeFile(promptFile, prompt, "utf-8");

  // Prepare log directory
  await mkdir(config.logDir, { recursive: true });

  // Read prompt from file for the -p argument
  const promptContent = await readFile(promptFile, "utf-8");

  log("runner", `启动分析, taskId=${taskId}`);
  log("runner", `工作目录: ${config.repoPath}`);
  if (config.preAnalysisScript) {
    const preAnalysisScript = resolveWorkerPath(config.preAnalysisScript);
    log("runner", `执行分析前脚本: ${preAnalysisScript}`);
    const preAnalysis = await runnerDeps.runPreAnalysisScript(preAnalysisScript, config.repoPath);
    if (preAnalysis.stdout) log("runner", `分析前脚本 stdout: ${preAnalysis.stdout.slice(0, 500)}`);
    if (preAnalysis.stderr) error("runner", `分析前脚本 stderr: ${preAnalysis.stderr.slice(0, 500)}`);
    if (preAnalysis.exitCode !== 0) {
      await unlink(promptFile);
      return {
        result: {
          status: "failed",
          summary: `分析前脚本异常退出 (${preAnalysis.exitCode})`,
          reason: (preAnalysis.stderr || preAnalysis.stdout).slice(0, 500),
          files: [],
        },
        logPath: join(config.logDir, `${taskId}-claude.jsonl`),
      };
    }
  }

  try {
    const claudeRun = await runProviderAnalysis("claude", promptContent, taskId, config, runnerDeps);
    if (claudeRun.result.status !== "failed" || !config.enableCodexFallback) {
      return { result: claudeRun.result, logPath: claudeRun.logPath };
    }

    log("runner", `Claude 分析失败，尝试 Codex fallback: ${claudeRun.result.summary}`);
    const codexPrompt = await buildPrompt("codex", title, description);
    const codexRun = await runProviderAnalysis("codex", codexPrompt, taskId, config, runnerDeps);
    if (codexRun.result.status !== "failed") {
      return { result: codexRun.result, logPath: codexRun.logPath };
    }

    return { result: combineFailedResults(claudeRun, codexRun), logPath: codexRun.logPath };
  } finally {
    await unlink(promptFile);
  }
}

export const runClaudeAnalysis = runAgentAnalysis;
