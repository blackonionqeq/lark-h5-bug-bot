import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createEvent, handleEvent } from "../event-processor";
import { taskStore } from "../task-store";
import { makeAppConfig, makeZentaoPayload, makeAnalysisCallbackPayload } from "../../test-fixtures";

function mockFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return spyOn(globalThis, "fetch").mockImplementation(implementation as unknown as typeof fetch);
}

describe("createEvent", () => {
  it("creates an event with generated traceId and timestamp", () => {
    const event = createEvent({
      source: "zentao",
      type: "zentao.webhook.received",
      payload: { title: "test" },
    });

    expect(event.source).toBe("zentao");
    expect(event.type).toBe("zentao.webhook.received");
    expect(event.traceId).toBeTruthy();
    expect(event.timestamp).toBeTruthy();
    expect(event.meta).toEqual({});
  });

  it("uses provided traceId from meta", () => {
    const event = createEvent({
      source: "zentao",
      type: "zentao.webhook.received",
      payload: {},
      meta: { traceId: "custom-trace" },
    });

    expect(event.traceId).toBe("custom-trace");
  });
});

describe("handleEvent", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    let task = taskStore.claim();
    while (task) task = taskStore.claim();

    fetchSpy = mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "fake-token", data: {} }))
      )
    );
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("enqueues task for active zentao.webhook.received events", async () => {
    const payload = makeZentaoPayload();
    const event = createEvent({
      source: "zentao",
      type: "zentao.webhook.received",
      payload: {
        ...payload,
        _parsed: {
          bugId: "999",
          title: "active bug",
          status: "active",
          priority: "3",
          severity: "3",
          creator: "张三",
          operator: "李四",
          assignee: "王五",
          link: "http://zentao.example.com/bug-view-999.html",
        },
      },
      meta: { issueId: "BUG-999" },
    });

    const config = makeAppConfig();
    const result = await handleEvent(event, config);

    expect(result.traceId).toBe(event.traceId);

    const task = taskStore.claim();
    expect(task).not.toBeNull();
    expect(task!.issueId).toBe("BUG-999");
  });

  it("skips non-active zentao.webhook.received events", async () => {
    const payload = makeZentaoPayload();
    const event = createEvent({
      source: "zentao",
      type: "zentao.webhook.received",
      payload: {
        ...payload,
        _parsed: {
          bugId: "888",
          title: "resolved bug",
          status: "resolved",
          priority: "3",
          severity: "3",
          creator: "张三",
          operator: "李四",
          assignee: "测试同学",
          link: "http://zentao.example.com/bug-view-888.html",
        },
      },
      meta: { issueId: "BUG-888" },
    });

    const config = makeAppConfig();
    const result = await handleEvent(event, config);

    expect(result.traceId).toBe(event.traceId);
    expect(result.messageResult).toBeNull();

    const task = taskStore.claim();
    expect(task).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does NOT enqueue task for non-zentao events", async () => {
    const event = createEvent({
      source: "bugbot-callback",
      type: "analysis.result.received",
      payload: makeAnalysisCallbackPayload(),
    });

    const config = makeAppConfig();
    await handleEvent(event, config);

    const task = taskStore.claim();
    expect(task).toBeNull();
  });
});
