import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, mock } from "bun:test";
import { extractResult, runClaudeAnalysis } from "../runner";
import { makeWorkerConfig } from "../test-fixtures";

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function resultEvent(json: string): string {
  return JSON.stringify({ type: "result", result: json }) + "\n";
}

describe("extractResult", () => {
  it("extracts suspected result from JSONL", () => {
    const jsonl = resultEvent(JSON.stringify({
      status: "suspected",
      summary: "疑似空值判断缺失",
      reason: "未做 null check",
      files: ["src/a.ts"],
    }));

    const result = extractResult(jsonl);
    expect(result.status).toBe("suspected");
    expect(result.summary).toBe("疑似空值判断缺失");
    expect(result.reason).toBe("未做 null check");
    expect(result.files).toEqual(["src/a.ts"]);
  });

  it("extracts resolved result with empty files", () => {
    const jsonl = resultEvent(JSON.stringify({
      status: "resolved",
      summary: "已修复",
      reason: "",
      files: [],
    }));

    const result = extractResult(jsonl);
    expect(result.status).toBe("resolved");
    expect(result.files).toEqual([]);
  });

  it("extracts inconclusive when status is missing", () => {
    const jsonl = resultEvent(JSON.stringify({
      summary: "无法确定",
      reason: "不够信息",
    }));

    const result = extractResult(jsonl);
    expect(result.status).toBe("inconclusive");
  });

  it("finds result event among other JSONL events", () => {
    const jsonl = [
      JSON.stringify({ type: "system", data: "init" }),
      JSON.stringify({ type: "assistant", text: "thinking..." }),
      resultEvent(JSON.stringify({ status: "resolved", summary: "done", reason: "found it" })),
    ].join("\n");

    const result = extractResult(jsonl);
    expect(result.status).toBe("resolved");
    expect(result.summary).toBe("done");
  });

  it("returns last result event when multiple exist", () => {
    const jsonl = [
      resultEvent(JSON.stringify({ status: "suspected", summary: "first" })),
      resultEvent(JSON.stringify({ status: "resolved", summary: "second" })),
    ].join("\n");

    const result = extractResult(jsonl);
    expect(result.status).toBe("resolved");
    expect(result.summary).toBe("second");
  });

  it("handles result with JSON embedded in text", () => {
    const jsonl = JSON.stringify({
      type: "result",
      result: "Here is my analysis: {\"status\":\"suspected\",\"summary\":\"found bug\",\"reason\":\"null check\"}",
    }) + "\n";

    const result = extractResult(jsonl);
    expect(result.status).toBe("suspected");
    expect(result.summary).toBe("found bug");
  });

  it("returns failed when no result event found", () => {
    const jsonl = [
      JSON.stringify({ type: "system", data: "init" }),
      JSON.stringify({ type: "assistant", text: "hello" }),
    ].join("\n");

    const result = extractResult(jsonl);
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("无法提取");
  });

  it("returns failed when result has no JSON", () => {
    const jsonl = JSON.stringify({
      type: "result",
      result: "Just some plain text without any JSON object",
    }) + "\n";

    const result = extractResult(jsonl);
    expect(result.status).toBe("failed");
    expect(result.summary).toBe("无法解析分析结果");
  });

  it("returns failed for empty input", () => {
    const result = extractResult("");
    expect(result.status).toBe("failed");
  });
});

describe("runClaudeAnalysis", () => {
  const createdLogDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(createdLogDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function createLogDir(): Promise<string> {
    const logDir = await mkdtemp(join(tmpdir(), "runner-test-"));
    createdLogDirs.push(logDir);
    return logDir;
  }

  it("writes log and returns parsed result when claude exits successfully", async () => {
    const taskId = `runner-success-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const config = makeWorkerConfig({ logDir, timeoutSeconds: 5 });
    const timeoutHandle = { id: "timeout-1" };
    const clearTimeoutFn = mock(() => {});
    let command: string[] | undefined;

    const { result, logPath } = await runClaudeAnalysis(
      "白屏问题",
      "打开页面后白屏",
      taskId,
      config,
      {
        spawn: (spawnCommand) => {
          command = spawnCommand;
          return {
            exited: Promise.resolve(0),
            stdout: streamFromText(resultEvent(JSON.stringify({ status: "resolved", summary: "done", reason: "fixed", files: ["src/a.ts"] }))),
            stderr: streamFromText(""),
            kill: mock(() => {}),
          };
        },
        setTimeoutFn: () => timeoutHandle,
        clearTimeoutFn,
      }
    );

    expect(command?.[0]).toBe("claude");
    expect(result.status).toBe("resolved");
    expect(result.summary).toBe("done");
    expect(logPath).toBe(join(logDir, `${taskId}.jsonl`));
    expect(await readFile(logPath, "utf-8")).toContain('"type":"result"');
    expect(clearTimeoutFn).toHaveBeenCalledWith(timeoutHandle);
    expect(await pathExists(join(tmpdir(), `${taskId}-prompt.txt`))).toBe(false);
  });

  it("runs configured pre-analysis script before Claude", async () => {
    const taskId = `runner-pre-analysis-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const config = makeWorkerConfig({
      logDir,
      timeoutSeconds: 5,
      preAnalysisScript: "./scripts/pre-analysis.sh",
    });
    const runPreAnalysisScript = mock(async () => ({ exitCode: 0, stdout: "pulled", stderr: "" }));
    const spawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: streamFromText(resultEvent(JSON.stringify({ status: "resolved", summary: "done", reason: "fixed", files: [] }))),
      stderr: streamFromText(""),
      kill: mock(() => {}),
    }));

    await runClaudeAnalysis(
      "预处理",
      "验证分析前脚本",
      taskId,
      config,
      {
        spawn,
        runPreAnalysisScript,
        setTimeoutFn: () => ({ id: "timeout-pre-analysis" }),
        clearTimeoutFn: mock(() => {}),
      }
    );

    expect(runPreAnalysisScript).toHaveBeenCalledWith(expect.stringContaining("/worker/scripts/pre-analysis.sh"), config.repoPath);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("returns failed result when pre-analysis script exits non-zero", async () => {
    const taskId = `runner-pre-analysis-fail-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const config = makeWorkerConfig({
      logDir,
      timeoutSeconds: 5,
      preAnalysisScript: "./scripts/pre-analysis.sh",
    });
    const spawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: streamFromText(""),
      stderr: streamFromText(""),
      kill: mock(() => {}),
    }));

    const { result } = await runClaudeAnalysis(
      "预处理失败",
      "验证脚本失败会中断分析",
      taskId,
      config,
      {
        spawn,
        runPreAnalysisScript: async () => ({ exitCode: 1, stdout: "", stderr: "pull failed" }),
        setTimeoutFn: () => ({ id: "timeout-pre-analysis-fail" }),
        clearTimeoutFn: mock(() => {}),
      }
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("分析前脚本异常退出");
    expect(result.reason).toBe("pull failed");
    expect(spawn).not.toHaveBeenCalled();
    expect(await pathExists(join(tmpdir(), `${taskId}-prompt.txt`))).toBe(false);
  });

  it("uses configured claude executable override", async () => {
    const taskId = `runner-custom-bin-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const config = makeWorkerConfig({
      logDir,
      timeoutSeconds: 5,
      claudeExecutable: "/opt/homebrew/bin/claude",
    });
    let command: string[] | undefined;

    await runClaudeAnalysis(
      "自定义命令",
      "验证自定义 Claude 可执行路径",
      taskId,
      config,
      {
        spawn: (spawnCommand) => {
          command = spawnCommand;
          return {
            exited: Promise.resolve(0),
            stdout: streamFromText(resultEvent(JSON.stringify({ status: "resolved", summary: "done", reason: "fixed", files: [] }))),
            stderr: streamFromText(""),
            kill: mock(() => {}),
          };
        },
        setTimeoutFn: () => ({ id: "timeout-custom-bin" }),
        clearTimeoutFn: mock(() => {}),
      }
    );

    expect(command?.[0]).toBe("/opt/homebrew/bin/claude");
  });

  it("returns failed result when claude exits with non-zero code", async () => {
    const taskId = `runner-exit-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const config = makeWorkerConfig({ logDir, timeoutSeconds: 5 });

    const { result, logPath } = await runClaudeAnalysis(
      "接口报错",
      "执行过程中异常退出",
      taskId,
      config,
      {
        spawn: () => ({
          exited: Promise.resolve(2),
          stdout: streamFromText("partial output"),
          stderr: streamFromText("fatal error"),
          kill: mock(() => {}),
        }),
        setTimeoutFn: () => ({ id: "timeout-2" }),
        clearTimeoutFn: mock(() => {}),
      }
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("2");
    expect(result.reason).toContain("fatal error");
    expect(await readFile(logPath, "utf-8")).toBe("partial output");
  });

  it("returns stderr content when claude exits with error and stdout is empty", async () => {
    const taskId = `runner-stderr-only-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const config = makeWorkerConfig({ logDir, timeoutSeconds: 5 });

    const { result, logPath } = await runClaudeAnalysis(
      "命令异常",
      "CLI 没有标准输出",
      taskId,
      config,
      {
        spawn: () => ({
          exited: Promise.resolve(1),
          stdout: streamFromText(""),
          stderr: streamFromText("only stderr output"),
          kill: mock(() => {}),
        }),
        setTimeoutFn: () => ({ id: "timeout-2b" }),
        clearTimeoutFn: mock(() => {}),
      }
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("1");
    expect(result.reason).toBe("only stderr output");
    expect(await readFile(logPath, "utf-8")).toBe("");
  });

  it("kills the process and returns timeout result when timer fires", async () => {
    const taskId = `runner-timeout-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const config = makeWorkerConfig({ logDir, timeoutSeconds: 1 });
    const kill = mock(() => {});
    const clearTimeoutFn = mock(() => {});
    const timeoutHandle = { id: "timeout-3" };

    const { result } = await runClaudeAnalysis(
      "超时问题",
      "分析执行超时",
      taskId,
      config,
      {
        spawn: () => ({
          exited: Promise.resolve(null),
          stdout: streamFromText(""),
          stderr: streamFromText(""),
          kill,
        }),
        setTimeoutFn: (callback) => {
          callback();
          return timeoutHandle;
        },
        clearTimeoutFn,
      }
    );

    expect(kill).toHaveBeenCalledTimes(1);
    expect(clearTimeoutFn).toHaveBeenCalledWith(timeoutHandle);
    expect(result.status).toBe("failed");
    expect(result.summary).toBe("分析超时");
  });
});
