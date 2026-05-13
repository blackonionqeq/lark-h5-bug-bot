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

    it("includes detailed bug fields when provided", () => {
      const event = makeAppEvent({
        type: "zentao.webhook.received",
        payload: {
          ...makeZentaoPayload(),
          _parsed: {
            ...testParsed,
            description: "打开首页后白屏",
            steps: "1. 登录\n2. 进入首页",
            expected: "页面正常展示",
            actual: "页面白屏并报错",
          },
        },
      });

      const result = formatMessage(event);
      expect(result).toContain("描述: 打开首页后白屏");
      expect(result).toContain("重现步骤: 1. 登录\n2. 进入首页");
      expect(result).toContain("期望结果: 页面正常展示");
      expect(result).toContain("实际结果: 页面白屏并报错");
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

  describe("analysis.task.running", () => {
    it("formats running analysis notification", () => {
      const event = makeAppEvent({
        type: "analysis.task.running",
        source: "local",
        payload: {
          taskId: "task-001",
          issueId: "BUG-100",
          traceId: "trace-001",
          title: "页面白屏报错",
          triageLabel: "frontend",
          triageSource: "rules",
        },
        meta: { issueId: "BUG-100", taskId: "task-001", traceId: "trace-001" },
      });

      const result = formatMessage(event);
      expect(result).toContain("自动查 bug 已开始");
      expect(result).toContain("BUG-100");
      expect(result).toContain("页面白屏报错");
      expect(result).toContain("frontend");
      expect(result).toContain("预计 5～8 分钟输出结果");
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
