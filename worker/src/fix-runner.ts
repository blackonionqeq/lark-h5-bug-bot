import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixTask } from "../../code/src/types";
import type { WorkerConfig } from "./config";
import { error, log } from "./logger";

type FixAgentResult = { status: "changed" | "inconclusive" | "failed"; summary: string; files: string[] };

function parseResult(text: string): FixAgentResult {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { status: "failed", summary: "Agent 未返回约定 JSON", files: [] };
  try {
    const parsed = JSON.parse(match[0]) as Partial<FixAgentResult>;
    return {
      status: parsed.status === "changed" || parsed.status === "inconclusive" ? parsed.status : "failed",
      summary: parsed.summary ?? "",
      files: Array.isArray(parsed.files) ? parsed.files.filter((file): file is string => typeof file === "string") : [],
    };
  } catch {
    return { status: "failed", summary: "Agent 返回的 JSON 无法解析", files: [] };
  }
}

function extractFinal(provider: "claude" | "codex", jsonl: string): FixAgentResult {
  const lines = jsonl.trim().split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const event = JSON.parse(lines[index]);
      if (provider === "claude" && event.type === "result") return parseResult(event.result ?? "");
      if (provider === "codex" && event.type === "item.completed" && event.item?.type === "agent_message") {
        return parseResult(event.item.text ?? "");
      }
    } catch {
      // Ignore non-JSON output lines.
    }
  }
  return { status: "failed", summary: "Agent 输出中没有最终结果", files: [] };
}

async function buildFixPrompt(task: FixTask): Promise<string> {
  const templatePath = fileURLToPath(new URL("../prompts/fix-bug.txt", import.meta.url));
  const template = await readFile(templatePath, "utf-8");
  return template
    .replace("{{TITLE}}", task.title)
    .replace("{{DESCRIPTION}}", task.description)
    .replace("{{SUMMARY}}", task.analysisResult.summary)
    .replace("{{REASON}}", task.analysisResult.reason)
    .replace("{{FILES}}", (task.analysisResult.files ?? []).join(", ") || "未指定");
}

export async function runFixAgent(
  task: FixTask,
  workspacePath: string,
  config: WorkerConfig
): Promise<{ result: FixAgentResult; logPath: string }> {
  const provider = config.agentProviderOrder[0] ?? "claude";
  const prompt = await buildFixPrompt(task);
  await mkdir(config.logDir, { recursive: true });
  const logPath = join(config.logDir, `${task.taskId}-${provider}-fix.jsonl`);
  const command = provider === "claude"
    ? [
        config.claudeExecutable,
        "-p",
        "--output-format", "stream-json",
        "--verbose",
        "--max-turns", String(config.maxTurns),
        "--model", config.claudeModel,
        "--permission-mode", "dontAsk",
        "--allowedTools", "Read,Grep,Glob,Edit,Write",
      ]
    : [
        config.codexExecutable,
        "--ask-for-approval", "never",
        ...(config.codexModel ? ["--model", config.codexModel] : []),
        "exec", "--json", "--sandbox", "workspace-write", "-",
      ];

  log("fix-runner", `启动 ${provider} 修复, taskId=${task.taskId}, workspace=${workspacePath}`);
  const proc = Bun.spawn(command, {
    cwd: workspacePath,
    stdin: new Blob([prompt], { type: "text/plain;charset=utf-8" }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), config.timeoutSeconds * 1000);
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    proc.stdout ? new Response(proc.stdout).text() : Promise.resolve(""),
    proc.stderr ? new Response(proc.stderr).text() : Promise.resolve(""),
  ]);
  clearTimeout(timer);
  await writeFile(logPath, stdout, "utf-8");

  if (exitCode !== 0) {
    error("fix-runner", `${provider} 修复异常退出 (${exitCode}): ${(stderr || stdout).slice(0, 500)}`);
    return { result: { status: "failed", summary: `${provider} 异常退出 (${exitCode})`, files: [] }, logPath };
  }
  return { result: extractFinal(provider, stdout), logPath };
}
