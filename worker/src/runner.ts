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

async function buildPrompt(title: string, description: string): Promise<string> {
  const templatePath = fileURLToPath(new URL("../prompts/analyze-bug.txt", import.meta.url));
  const template = await readFile(templatePath, "utf-8");
  return template.replace("{title}", title).replace("{description}", description);
}

function resolveWorkerPath(path: string): string {
  if (isAbsolute(path)) return path;
  return resolve(fileURLToPath(new URL("..", import.meta.url)), path);
}

export function extractResult(jsonl: string): AnalysisResult {
  const lines = jsonl.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const event = JSON.parse(lines[i]);
      if (event.type === "result") {
        const text: string = event.result ?? "";
        // Try to extract JSON from the result text
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
        return { status: "failed", summary: "无法解析分析结果", reason: text.slice(0, 500), files: [] };
      }
    } catch {
      // skip unparseable lines
    }
  }
  return { status: "failed", summary: "无法提取分析结果", reason: "JSONL 中未找到 result 事件", files: [] };
}

export async function runClaudeAnalysis(
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

  const prompt = await buildPrompt(title, description);

  // Write prompt to temp file
  const promptFile = join(tmpdir(), `${taskId}-prompt.txt`);
  await writeFile(promptFile, prompt, "utf-8");

  // Prepare log directory
  await mkdir(config.logDir, { recursive: true });
  const logPath = join(config.logDir, `${taskId}.jsonl`);

  // Read prompt from file for the -p argument
  const promptContent = await readFile(promptFile, "utf-8");

  log("runner", `启动分析, taskId=${taskId}`);
  log("runner", `工作目录: ${config.repoPath}`);
  log("runner", `日志文件: ${logPath}`);
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
        logPath,
      };
    }
  }

  const proc = runnerDeps.spawn(
    [config.claudeExecutable, "-p", promptContent, "--output-format", "stream-json", "--verbose", "--max-turns", String(config.maxTurns), "--model", config.claudeModel],
    {
      cwd: config.repoPath,
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const timeout = runnerDeps.setTimeoutFn(() => {
    log("runner", `分析超时 (${config.timeoutSeconds}s), 正在终止进程`);
    proc.kill();
  }, config.timeoutSeconds * 1000);

  const exitCode = await proc.exited;
  runnerDeps.clearTimeoutFn(timeout);

  const stdout = proc.stdout ? await new Response(proc.stdout).text() : "";
  const stderr = proc.stderr ? await new Response(proc.stderr).text() : "";

  // Write output to log file
  await writeFile(logPath, stdout, "utf-8");

  // Clean up temp file
  await unlink(promptFile);

  if (exitCode === 124 || exitCode === null) {
    error("runner", "分析超时或被终止");
    return {
      result: { status: "failed", summary: "分析超时", reason: `超时限制 ${config.timeoutSeconds}s`, files: [] },
      logPath,
    };
  }

  if (exitCode !== 0) {
    error("runner", `Claude CLI 退出码: ${exitCode}`);
    error("runner", `stderr: ${stderr.slice(0, 500)}`);
    return {
      result: { status: "failed", summary: `Claude CLI 异常退出 (${exitCode})`, reason: stderr.slice(0, 500), files: [] },
      logPath,
    };
  }

  const result = extractResult(stdout);
  log("runner", `分析完成, status=${result.status}`);
  return { result, logPath };
}
