import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createZentaoRouter } from "../zentao";
import { taskStore } from "../../services/task-store";
import { makeAppConfig } from "../../test-fixtures";

function mockFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return spyOn(globalThis, "fetch").mockImplementation(implementation as unknown as typeof fetch);
}

describe("POST /webhook/zentao", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let app: ReturnType<typeof createZentaoRouter>;

  beforeEach(() => {
    let task = taskStore.claim();
    while (task) task = taskStore.claim();
    fetchSpy = mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "fake-token", data: {} }))
      )
    );

    const config = makeAppConfig();
    app = createZentaoRouter(config);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("returns success on valid payload", async () => {
    const res = await app.handle(
      new Request("http://localhost/webhook/zentao", {
        method: "POST",
        body: JSON.stringify({ id: 1, title: "页面白屏", description: "打开首页白屏" }),
        headers: { "content-type": "application/json" },
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("enqueues a task for the bug", async () => {
    await app.handle(
      new Request("http://localhost/webhook/zentao", {
        method: "POST",
        body: JSON.stringify({ id: 42, title: "test bug", description: "desc" }),
        headers: { "content-type": "application/json" },
      })
    );

    const task = taskStore.claim();
    expect(task).not.toBeNull();
    expect(task!.issueId).toBe(42);
  });

  it("returns 500 on error by restoring fetch to throw", async () => {
    fetchSpy?.mockRestore();
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    const app2 = createZentaoRouter(makeAppConfig());
    const res = await app2.handle(
      new Request("http://localhost/webhook/zentao", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      })
    );

    expect(res.status).toBe(500);
  });
});
