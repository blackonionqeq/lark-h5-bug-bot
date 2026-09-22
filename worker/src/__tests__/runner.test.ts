import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, mock } from "bun:test";
import { buildPreAnalysisCommand, extractCodexResult, extractResult, runClaudeAnalysis } from "../runner";
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

function codexMessageEvent(text: string): string {
  return JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } }) + "\n";
}

describe("buildPreAnalysisCommand", () => {
  it("runs shell scripts through the configured Bash executable", () => {
    expect(buildPreAnalysisCommand(
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\worker\\scripts\\pre-analysis.sh"
    )).toEqual([
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\worker\\scripts\\pre-analysis.sh",
    ]);
  });
});

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
    expect(result.summary).toBe("分析结果格式不正确");
    expect(result.reason).toContain("原始输出片段");
  });

  it("returns failed with model invocation hint when result is empty", () => {
    const jsonl = JSON.stringify({
      type: "result",
      result: "",
    }) + "\n";

    const result = extractResult(jsonl);
    expect(result.status).toBe("failed");
    expect(result.summary).toBe("分析结果为空，请检查模型唤起是否异常");
    expect(result.reason).toContain("Claude CLI 返回了空结果");
  });

  it("returns failed for empty input", () => {
    const result = extractResult("");
    expect(result.status).toBe("failed");
  });
});

describe("extractCodexResult", () => {
  it("extracts result from Codex agent_message JSONL", () => {
    const jsonl = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "turn.started" }),
      codexMessageEvent(JSON.stringify({ status: "resolved", summary: "codex done", reason: "found it", files: ["src/b.ts"] })),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");

    const result = extractCodexResult(jsonl);
    expect(result.status).toBe("resolved");
    expect(result.summary).toBe("codex done");
    expect(result.files).toEqual(["src/b.ts"]);
  });

  it("returns last Codex agent message when multiple exist", () => {
    const jsonl = [
      codexMessageEvent(JSON.stringify({ status: "suspected", summary: "first" })),
      codexMessageEvent(JSON.stringify({ status: "resolved", summary: "second" })),
    ].join("\n");

    const result = extractCodexResult(jsonl);
    expect(result.status).toBe("resolved");
    expect(result.summary).toBe("second");
  });

  it("returns failed when no Codex agent message exists", () => {
    const result = extractCodexResult(JSON.stringify({ type: "turn.completed" }));
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("Codex agent_message");
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
    expect(logPath).toBe(join(logDir, `${taskId}-claude.jsonl`));
    expect(await readFile(logPath, "utf-8")).toContain('"type":"result"');
    expect(clearTimeoutFn).toHaveBeenCalledWith(timeoutHandle);
    expect(await pathExists(join(tmpdir(), `${taskId}-prompt.txt`))).toBe(false);
  });

  it("combines the shared template with an explicitly configured project context", async () => {
    const taskId = `runner-project-context-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const projectContextFile = join(logDir, "project-context.md");
    await Bun.write(projectContextFile, "优先读取项目内的 checkout-flow Skill。\n");
    const config = makeWorkerConfig({ logDir, projectContextFile });
    let command: string[] | undefined;
    let promptInput: Blob | undefined;

    await runClaudeAnalysis(
      "结算页白屏",
      "点击提交订单后页面白屏",
      taskId,
      config,
      {
        spawn: (spawnCommand, options) => {
          command = spawnCommand;
          promptInput = options.stdin;
          return {
            exited: Promise.resolve(0),
            stdout: streamFromText(resultEvent(JSON.stringify({ status: "resolved", summary: "done", reason: "found", files: [] }))),
            stderr: streamFromText(""),
            kill: mock(() => {}),
          };
        },
        setTimeoutFn: () => ({ id: "timeout-project-context" }),
        clearTimeoutFn: mock(() => {}),
      }
    );

    const prompt = await promptInput?.text() ?? "";
    expect(command).not.toContain(prompt);
    expect(command?.slice(0, 2)).toEqual(["claude", "-p"]);
    expect(prompt).toContain("## 项目补充说明");
    expect(prompt).toContain("checkout-flow Skill");
    expect(prompt).toContain("标题：结算页白屏");
    expect(prompt).toContain("描述：点击提交订单后页面白屏");
    expect(prompt).not.toContain("{{PROJECT_CONTEXT}}");
  });

  it("fails before launching an agent when an explicit project context file is missing", async () => {
    const taskId = `runner-missing-project-context-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const spawn = mock(() => ({
      exited: Promise.resolve(0),
      stdout: streamFromText(""),
      stderr: streamFromText(""),
      kill: mock(() => {}),
    }));
    const config = makeWorkerConfig({
      logDir,
      projectContextFile: join(logDir, "missing-project-context.md"),
    });

    await expect(runClaudeAnalysis(
      "配置错误",
      "项目补充提示词不存在",
      taskId,
      config,
      { spawn }
    )).rejects.toThrow("无法读取项目补充提示词");
    expect(spawn).not.toHaveBeenCalled();
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

    expect(runPreAnalysisScript).toHaveBeenCalledWith(
      expect.stringContaining(join("worker", "scripts", "pre-analysis.sh")),
      config.repoPath,
      config.bashExecutable
    );
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

  it("falls back to Codex when claude exits with non-zero code", async () => {
    const taskId = `runner-exit-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const config = makeWorkerConfig({ logDir, timeoutSeconds: 5 });
    const commands: string[][] = [];
    const promptInputs: Blob[] = [];

    const { result, logPath } = await runClaudeAnalysis(
      "接口报错",
      "执行过程中异常退出",
      taskId,
      config,
      {
        spawn: (command, options) => {
          commands.push(command);
          promptInputs.push(options.stdin);
          if (command[0] === "claude") {
            return {
              exited: Promise.resolve(2),
              stdout: streamFromText("partial output"),
              stderr: streamFromText("fatal error"),
              kill: mock(() => {}),
            };
          }
          return {
            exited: Promise.resolve(0),
            stdout: streamFromText(codexMessageEvent(JSON.stringify({ status: "resolved", summary: "codex recovered", reason: "fallback worked", files: [] }))),
            stderr: streamFromText(""),
            kill: mock(() => {}),
          };
        },
        setTimeoutFn: () => ({ id: "timeout-2" }),
        clearTimeoutFn: mock(() => {}),
      }
    );

    expect(commands).toHaveLength(2);
    const prompts = await Promise.all(promptInputs.map((input) => input.text()));
    expect(commands[1]?.slice(0, 4)).toEqual(["codex", "--ask-for-approval", "never", "exec"]);
    expect(commands[1]?.at(-1)).toBe("-");
    expect(prompts[1]).toContain("标题：接口报错");
    expect(prompts[1]).toContain("描述：执行过程中异常退出");
    expect(prompts[1]).toBe(prompts[0]);
    expect(result.status).toBe("resolved");
    expect(result.summary).toBe("codex recovered");
    expect(logPath).toBe(join(logDir, `${taskId}-codex.jsonl`));
    expect(await readFile(join(logDir, `${taskId}-claude.jsonl`), "utf-8")).toBe("partial output");
  });

  it("runs Codex first when configured as the preferred provider", async () => {
    const taskId = `runner-codex-first-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const config = makeWorkerConfig({ logDir, timeoutSeconds: 5, agentProviderOrder: ["codex", "claude"] });
    const commands: string[][] = [];
    let promptInput: Blob | undefined;

    const { result, logPath } = await runClaudeAnalysis(
      "Codex 优先",
      "验证优先级配置",
      taskId,
      config,
      {
        spawn: (command, options) => {
          commands.push(command);
          promptInput = options.stdin;
          return {
            exited: Promise.resolve(0),
            stdout: streamFromText(codexMessageEvent(JSON.stringify({ status: "resolved", summary: "codex first", reason: "ok", files: [] }))),
            stderr: streamFromText(""),
            kill: mock(() => {}),
          };
        },
        setTimeoutFn: () => ({ id: "timeout-codex-first" }),
        clearTimeoutFn: mock(() => {}),
      }
    );

    expect(commands).toHaveLength(1);
    const prompt = await promptInput?.text() ?? "";
    expect(commands[0]?.[0]).toBe("codex");
    expect(commands[0]?.at(-1)).toBe("-");
    expect(prompt).toContain("标题：Codex 优先");
    expect(prompt).toContain("描述：验证优先级配置");
    expect(result.summary).toBe("codex first");
    expect(logPath).toBe(join(logDir, `${taskId}-codex.jsonl`));
  });

  it("falls back to Claude when Codex fails first", async () => {
    const taskId = `runner-codex-to-claude-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const config = makeWorkerConfig({ logDir, timeoutSeconds: 5, agentProviderOrder: ["codex", "claude"] });
    const commands: string[][] = [];

    const { result, logPath } = await runClaudeAnalysis(
      "Codex 失败",
      "验证 Claude fallback",
      taskId,
      config,
      {
        spawn: (command) => {
          commands.push(command);
          if (command[0] === "codex") {
            return {
              exited: Promise.resolve(1),
              stdout: streamFromText(""),
              stderr: streamFromText("codex failed"),
              kill: mock(() => {}),
            };
          }
          return {
            exited: Promise.resolve(0),
            stdout: streamFromText(resultEvent(JSON.stringify({ status: "suspected", summary: "claude recovered", reason: "fallback worked", files: [] }))),
            stderr: streamFromText(""),
            kill: mock(() => {}),
          };
        },
        setTimeoutFn: () => ({ id: "timeout-codex-to-claude" }),
        clearTimeoutFn: mock(() => {}),
      }
    );

    expect(commands.map((command) => command[0])).toEqual(["codex", "claude"]);
    expect(result.summary).toBe("claude recovered");
    expect(logPath).toBe(join(logDir, `${taskId}-claude.jsonl`));
  });

  it("returns stderr content when claude exits with error and Codex fallback is disabled", async () => {
    const taskId = `runner-stderr-only-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const config = makeWorkerConfig({ logDir, timeoutSeconds: 5, enableCodexFallback: false });

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

  it("falls back to Codex when Claude JSONL cannot be parsed", async () => {
    const taskId = `runner-parse-fallback-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const config = makeWorkerConfig({ logDir, timeoutSeconds: 5 });
    const commands: string[][] = [];

    const { result } = await runClaudeAnalysis(
      "格式异常",
      "Claude 没有 result 事件",
      taskId,
      config,
      {
        spawn: (command) => {
          commands.push(command);
          if (command[0] === "claude") {
            return {
              exited: Promise.resolve(0),
              stdout: streamFromText(JSON.stringify({ type: "assistant", text: "hello" })),
              stderr: streamFromText(""),
              kill: mock(() => {}),
            };
          }
          return {
            exited: Promise.resolve(0),
            stdout: streamFromText(codexMessageEvent(JSON.stringify({ status: "suspected", summary: "codex parsed", reason: "fallback parse", files: ["src/c.ts"] }))),
            stderr: streamFromText(""),
            kill: mock(() => {}),
          };
        },
        setTimeoutFn: () => ({ id: "timeout-parse-fallback" }),
        clearTimeoutFn: mock(() => {}),
      }
    );

    expect(commands.map((command) => command[0])).toEqual(["claude", "codex"]);
    expect(result.status).toBe("suspected");
    expect(result.summary).toBe("codex parsed");
  });

  it("returns combined failure when Claude and Codex both fail", async () => {
    const taskId = `runner-both-fail-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const config = makeWorkerConfig({ logDir, timeoutSeconds: 5 });

    const { result, logPath } = await runClaudeAnalysis(
      "双失败",
      "两个 CLI 都失败",
      taskId,
      config,
      {
        spawn: (command) => {
          if (command[0] === "claude") {
            return {
              exited: Promise.resolve(1),
              stdout: streamFromText(""),
              stderr: streamFromText("claude failed"),
              kill: mock(() => {}),
            };
          }
          return {
            exited: Promise.resolve(1),
            stdout: streamFromText(""),
            stderr: streamFromText("codex failed"),
            kill: mock(() => {}),
          };
        },
        setTimeoutFn: () => ({ id: "timeout-both-fail" }),
        clearTimeoutFn: mock(() => {}),
      }
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toBe("Claude 与 Codex 分析均失败");
    expect(result.reason).toContain("claude failed");
    expect(result.reason).toContain("codex failed");
    expect(logPath).toBe(join(logDir, `${taskId}-codex.jsonl`));
  });

  it("uses configured Codex executable and model for fallback", async () => {
    const taskId = `runner-codex-config-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const config = makeWorkerConfig({
      logDir,
      timeoutSeconds: 5,
      codexExecutable: "/opt/homebrew/bin/codex",
      codexModel: "gpt-5.1-codex",
      codexSandbox: "workspace-write",
    });
    const commands: string[][] = [];

    await runClaudeAnalysis(
      "Codex 配置",
      "验证 fallback 命令",
      taskId,
      config,
      {
        spawn: (command) => {
          commands.push(command);
          if (commands.length === 1) {
            return {
              exited: Promise.resolve(1),
              stdout: streamFromText(""),
              stderr: streamFromText("claude failed"),
              kill: mock(() => {}),
            };
          }
          return {
            exited: Promise.resolve(0),
            stdout: streamFromText(codexMessageEvent(JSON.stringify({ status: "resolved", summary: "done", reason: "", files: [] }))),
            stderr: streamFromText(""),
            kill: mock(() => {}),
          };
        },
        setTimeoutFn: () => ({ id: "timeout-codex-config" }),
        clearTimeoutFn: mock(() => {}),
      }
    );

    expect(commands[1]?.slice(0, 6)).toEqual(["/opt/homebrew/bin/codex", "--ask-for-approval", "never", "--model", "gpt-5.1-codex", "exec"]);
    expect(commands[1]).toContain("workspace-write");
  });

  it("kills the process and returns timeout result when timer fires and fallback is disabled", async () => {
    const taskId = `runner-timeout-${crypto.randomUUID()}`;
    const logDir = await createLogDir();
    const config = makeWorkerConfig({ logDir, timeoutSeconds: 1, enableCodexFallback: false });
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
