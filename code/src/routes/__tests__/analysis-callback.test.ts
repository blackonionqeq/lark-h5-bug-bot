import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { createAnalysisCallbackRouter } from "../analysis-callback";
import { makeAppConfig } from "../../test-fixtures";

describe("POST /callback/analysis-result", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let app: Elysia;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "fake-token", data: {} }))
      )
    );
    const config = makeAppConfig();
    app = new Elysia().use(createAnalysisCallbackRouter(config));
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

    const app2 = new Elysia().use(createAnalysisCallbackRouter(makeAppConfig()));
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
