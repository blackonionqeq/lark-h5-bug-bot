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

  it("enqueues task for zentao.webhook.received events", async () => {
    const event = createEvent({
      source: "zentao",
      type: "zentao.webhook.received",
      payload: makeZentaoPayload({ bugId: 999, issueId: "BUG-999" }),
      meta: { issueId: "BUG-999" },
    });

    const config = makeAppConfig();
    const result = await handleEvent(event, config);

    expect(result.traceId).toBe(event.traceId);

    const task = taskStore.claim();
    expect(task).not.toBeNull();
    expect(task!.issueId).toBe("BUG-999");
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
