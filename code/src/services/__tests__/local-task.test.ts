import { describe, it, expect, beforeEach } from "bun:test";
import { taskStore } from "../task-store";
import { enqueueTask } from "../local-task";
import { makeAppEvent, makeZentaoPayload, makeAnalysisTask } from "../../test-fixtures";
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
    expect(stored!.issueId).toBe("BUG-999");
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
