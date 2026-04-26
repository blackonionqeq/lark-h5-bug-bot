import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { taskStore } from "../task-store";
import { enqueueTask } from "../local-task";
import { makeAppEvent, makeZentaoPayload, makeAnalysisTask } from "../../test-fixtures";

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
      payload: makeZentaoPayload({
        title: "测试标题",
        description: "测试描述",
        issueId: "BUG-999",
      }),
      meta: { issueId: "BUG-999" },
    });

    const result = enqueueTask(event);

    expect(result.accepted).toBe(true);
    expect(result.taskId).toBe("trace-enqueue-test");

    const stored = taskStore.get("trace-enqueue-test");
    expect(stored).toBeDefined();
    expect(stored!.status).toBe("queued");
    expect(stored!.title).toBe("测试标题");
    expect(stored!.description).toBe("测试描述");
    expect(stored!.issueId).toBe("BUG-999");
  });

  it("handles payload without title and description gracefully", () => {
    const event = makeAppEvent({
      type: "zentao.webhook.received",
      traceId: "trace-no-title",
      payload: makeZentaoPayload({ title: undefined, description: undefined }),
      meta: {},
    });

    const result = enqueueTask(event);
    expect(result.accepted).toBe(true);

    const stored = taskStore.get("trace-no-title");
    expect(stored!.title).toBeUndefined();
    expect(stored!.description).toBeUndefined();
  });
});
