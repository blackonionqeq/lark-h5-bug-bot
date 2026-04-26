import { describe, it, expect } from "bun:test";
import { formatMessage } from "../format-message";
import { makeAppEvent, makeAnalysisCallbackPayload, makeZentaoPayload } from "../../test-fixtures";

describe("formatMessage", () => {
  describe("zentao.webhook.received", () => {
    it("formats a zentao bug notification", () => {
      const event = makeAppEvent({
        type: "zentao.webhook.received",
        payload: makeZentaoPayload({ title: "登录按钮无响应", issueId: "BUG-200" }),
        meta: { issueId: "BUG-200" },
      });

      const result = formatMessage(event);
      expect(result).toContain("收到禅道 Bug");
      expect(result).toContain("登录按钮无响应");
      expect(result).toContain("BUG-200");
    });

    it("includes description truncated to 200 chars", () => {
      const longDesc = "x".repeat(300);
      const event = makeAppEvent({
        type: "zentao.webhook.received",
        payload: makeZentaoPayload({ description: longDesc }),
      });

      const result = formatMessage(event);
      const descPart = result.split("描述: ")[1] ?? "";
      expect(descPart.length).toBeLessThanOrEqual(201);
    });
  });

  describe("analysis.result.received", () => {
    it("formats analysis result with all fields", () => {
      const event = makeAppEvent({
        type: "analysis.result.received",
        source: "bugbot-callback",
        payload: makeAnalysisCallbackPayload({
          status: "suspected",
          summary: "疑似由空值判断缺失导致",
          reason: "未做 null check",
          triageLabel: "frontend",
          triageSource: "rules",
          files: ["src/a.ts", "src/b.ts"],
        }),
        meta: { issueId: "BUG-100" },
      });

      const result = formatMessage(event);
      expect(result).toContain("自动查 bug 结果");
      expect(result).toContain("BUG-100");
      expect(result).toContain("frontend");
      expect(result).toContain("疑似由空值判断缺失导致");
      expect(result).toContain("src/a.ts");
      expect(result).toContain("src/b.ts");
    });

    it("uses correct emoji for each status", () => {
      const resolved = makeAnalysisCallbackPayload({ status: "resolved" });
      const failed = makeAnalysisCallbackPayload({ status: "failed" });
      const skipped = makeAnalysisCallbackPayload({ status: "skipped" });
      const inconclusive = makeAnalysisCallbackPayload({ status: "inconclusive" });

      expect(formatMessage(makeAppEvent({ type: "analysis.result.received", source: "bugbot-callback", payload: resolved }))).toContain("✅");
      expect(formatMessage(makeAppEvent({ type: "analysis.result.received", source: "bugbot-callback", payload: failed }))).toContain("❌");
      expect(formatMessage(makeAppEvent({ type: "analysis.result.received", source: "bugbot-callback", payload: skipped }))).toContain("⏭️");
      expect(formatMessage(makeAppEvent({ type: "analysis.result.received", source: "bugbot-callback", payload: inconclusive }))).toContain("❓");
    });

    it("omits files section when files is empty", () => {
      const event = makeAppEvent({
        type: "analysis.result.received",
        source: "bugbot-callback",
        payload: makeAnalysisCallbackPayload({ files: [] }),
      });

      const result = formatMessage(event);
      expect(result).not.toContain("文件:");
    });
  });

  describe("unknown event type", () => {
    it("falls back to JSON stringify of payload", () => {
      const event = makeAppEvent({
        type: "local.manual.requested",
        source: "local",
        payload: { customField: "hello" },
      });

      const result = formatMessage(event);
      expect(result).toContain("customField");
      expect(result).toContain("hello");
    });
  });
});
