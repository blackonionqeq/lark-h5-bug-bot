import { describe, it, expect } from "bun:test";
import { formatMessage } from "../format-message";
import { makeAppEvent, makeAnalysisCallbackPayload, makeZentaoPayload } from "../../test-fixtures";
import type { ZentaoParsedFields } from "../../types";

const testParsed: ZentaoParsedFields = {
  bugId: "100",
  title: "页面白屏报错",
  status: "active",
  priority: "3",
  severity: "3",
  creator: "张三",
  operator: "李四",
  assignee: "王五",
  link: "http://zentao.example.com/bug-view-100.html",
};

describe("formatMessage", () => {
  describe("zentao.webhook.received", () => {
    it("formats a zentao bug notification", () => {
      const event = makeAppEvent({
        type: "zentao.webhook.received",
        meta: { issueId: "100" },
      });

      const result = formatMessage(event);
      expect(result).toContain("禅道 Bug #100");
      expect(result).toContain("页面白屏报错");
      expect(result).toContain("active");
    });

    it("falls back when no _parsed field", () => {
      const event = makeAppEvent({
        type: "zentao.webhook.received",
        payload: { text: "something" },
        meta: {},
      });

      const result = formatMessage(event);
      expect(result).toContain("收到禅道 Bug 通知");
    });

    it("includes @ mention when userMentions provided", () => {
      const event = makeAppEvent({
        type: "zentao.webhook.received",
        meta: { issueId: "100" },
      });

      const result = formatMessage(event, { "王五": "ou_abc123" });
      expect(result).toContain('<at user_id="ou_abc123">王五</at>');
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
