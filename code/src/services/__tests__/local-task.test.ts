import { describe, it, expect, beforeEach } from "bun:test";
import { taskStore } from "../task-store";
import { enqueueTask } from "../local-task";
import { makeAppEvent, makeZentaoPayload } from "../../test-fixtures";
import type { ZentaoParsedFields } from "../../types";

const testParsed: ZentaoParsedFields = {
  bugId: "999",
  title: "测试标题",
  status: "active",
  priority: "2",
  severity: "2",
  creator: "张三",
  operator: "李四",
  assignee: "王五",
  description: "用户打开首页后白屏",
  steps: "进入首页",
  link: "http://zentao.example.com/bug-view-999.html",
};

describe("enqueueTask", () => {
  beforeEach(() => {
    // Drain the task store
    let task = taskStore.claim();
    while (task) {
      task = taskStore.claim();
    }
  });

  it("creates a task from an event and enqueues it", () => {
    const event = makeAppEvent({
      type: "zentao.webhook.received",
      traceId: "trace-enqueue-test",
      payload: {
        ...makeZentaoPayload(),
        _parsed: testParsed,
      },
      meta: { issueId: "BUG-999" },
    });

    const result = enqueueTask(event);

    expect(result.accepted).toBe(true);
    expect(result.taskId).toBe("trace-enqueue-test");

    const stored = taskStore.get("trace-enqueue-test");
    expect(stored).toBeDefined();
    expect(stored!.status).toBe("queued");
    expect(stored!.title).toBe("测试标题");
    expect(stored!.description).toContain("active");
    expect(stored!.description).toContain("描述: 用户打开首页后白屏");
    expect(stored!.description).toContain("重现步骤: 进入首页");
    expect(stored!.issueId).toBe("BUG-999");
  });

  it("禅道原生 payload 缺描述时给出明确提示，不再输出空字段壳", () => {
    // 2026-09-22 用户真实禅道 bug #8 的解析结果：优先级/严重程度/指派人全为空
    const nativeParsed: ZentaoParsedFields = {
      bugId: "8",
      title: "[白屏]agent连通性测试",
      status: "active",
      priority: "",
      severity: "",
      creator: "admin",
      operator: "admin",
      assignee: "",
      link: "http://blackonion.tail05ae45.ts.net/zentao/bug-view-8.html",
    };

    const event = makeAppEvent({
      type: "zentao.webhook.received",
      traceId: "trace-native-test",
      payload: {
        ...makeZentaoPayload(),
        _parsed: nativeParsed,
      },
      meta: { issueId: "8" },
    });

    enqueueTask(event);

    const stored = taskStore.get("trace-native-test");
    expect(stored!.description).toBe(
      [
        "状态: active",
        "描述: （禅道 webhook 未提供描述与复现步骤，请仅依据标题、链接与代码证据判断）",
        "http://blackonion.tail05ae45.ts.net/zentao/bug-view-8.html",
      ].join("\n")
    );
    expect(stored!.description).not.toContain("优先级:");
    expect(stored!.description).not.toContain("严重程度:");
  });

  it("禅道补了扩展字段（steps）时，不再误报「未提供复现步骤」", () => {
    const withSteps: ZentaoParsedFields = {
      bugId: "8",
      title: "[白屏]列表页白屏",
      status: "active",
      priority: "3",
      severity: "3",
      creator: "admin",
      operator: "admin",
      assignee: "李四",
      steps: "1. 打开列表页\n2. 下拉刷新",
      link: "http://zentao.example.com/bug-view-8.html",
    };

    const event = makeAppEvent({
      type: "zentao.webhook.received",
      traceId: "trace-steps-test",
      payload: { ...makeZentaoPayload(), _parsed: withSteps },
      meta: { issueId: "8" },
    });

    enqueueTask(event);

    const stored = taskStore.get("trace-steps-test");
    expect(stored!.description).toBe(
      [
        "状态: active | 优先级: 3 | 严重程度: 3",
        "重现步骤: 1. 打开列表页\n2. 下拉刷新",
        "http://zentao.example.com/bug-view-8.html",
      ].join("\n")
    );
    expect(stored!.description).not.toContain("未提供描述与复现步骤");
  });

  it("handles payload without _parsed gracefully", () => {
    const event = makeAppEvent({
      type: "zentao.webhook.received",
      traceId: "trace-no-title",
      payload: makeZentaoPayload(),
      meta: {},
    });

    const result = enqueueTask(event);
    expect(result.accepted).toBe(true);

    const stored = taskStore.get("trace-no-title");
    expect(stored!.title).toBeUndefined();
    expect(stored!.description).toBeUndefined();
  });
});
