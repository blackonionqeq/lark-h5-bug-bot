import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createAnalysisCallbackRouter } from "../analysis-callback";
import { makeAppConfig } from "../../test-fixtures";

function mockFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return spyOn(globalThis, "fetch").mockImplementation(implementation as unknown as typeof fetch);
}

describe("POST /callback/analysis-result", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let app: ReturnType<typeof createAnalysisCallbackRouter>;

  beforeEach(() => {
    fetchSpy = mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "fake-token", data: {} }))
      )
    );
    const config = makeAppConfig();
    app = createAnalysisCallbackRouter(config);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("returns success with traceId on valid payload", async () => {
    const res = await app.handle(
      new Request("http://localhost/callback/analysis-result", {
        method: "POST",
        body: JSON.stringify({
          taskId: "task-1",
          issueId: "BUG-1",
          status: "suspected",
          summary: "Suspected issue found",
          reason: "Null check missing",
          triageLabel: "frontend",
          triageSource: "rules",
          files: ["src/a.ts"],
        }),
        headers: { "content-type": "application/json" },
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.traceId).toBeTruthy();
  });

  it("returns 500 on error", async () => {
    fetchSpy?.mockRestore();
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    const app2 = createAnalysisCallbackRouter(makeAppConfig());
    const res = await app2.handle(
      new Request("http://localhost/callback/analysis-result", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      })
    );

    expect(res.status).toBe(500);
  });
});
