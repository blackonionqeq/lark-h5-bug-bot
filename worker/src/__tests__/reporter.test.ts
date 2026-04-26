import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { reportToCallback } from "../reporter";
import { makeAnalysisTask, makeTriageResult, makeAnalysisResult } from "../test-fixtures";

function mockFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return spyOn(globalThis, "fetch").mockImplementation(implementation as unknown as typeof fetch);
}

describe("reportToCallback", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("POSTs analysis result to cloud callback endpoint", async () => {
    fetchSpy = mockFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ success: true })))
    );

    const task = makeAnalysisTask({
      taskId: "t1",
      traceId: "trace-1",
      issueId: "BUG-1",
    });
    const triage = makeTriageResult({ label: "frontend" });
    const analysis = makeAnalysisResult({ status: "suspected" });

    await reportToCallback("http://cloud", task, triage, analysis);

    expect((fetchSpy.mock.calls[0][0] as string)).toBe("http://cloud/callback/analysis-result");

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.taskId).toBe("t1");
    expect(body.traceId).toBe("trace-1");
    expect(body.issueId).toBe("BUG-1");
    expect(body.status).toBe("suspected");
    expect(body.triageLabel).toBe("frontend");
  });

  it("does not throw on non-ok response", async () => {
    fetchSpy = mockFetch(() =>
      Promise.resolve(new Response("", { status: 500 }))
    );

    const task = makeAnalysisTask({});
    const triage = makeTriageResult({});
    const analysis = makeAnalysisResult({});

    await expect(
      reportToCallback("http://cloud", task, triage, analysis)
    ).resolves.toBeUndefined();
  });
});
