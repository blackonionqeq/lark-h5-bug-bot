import { describe, it, expect, afterEach, mock, spyOn } from "bun:test";
import { extractResult } from "../runner";
import type { AnalysisResult } from "../../../code/src/types";

describe("extractResult", () => {
  const resultEvent = (json: string) =>
    JSON.stringify({ type: "result", result: json }) + "\n";

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
