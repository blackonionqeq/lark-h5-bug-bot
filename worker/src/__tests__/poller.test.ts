import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { createCloudTaskApi } from "../poller";
import { makeAnalysisTask } from "../test-fixtures";

describe("createCloudTaskApi", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  describe("fetchPending", () => {
    it("returns task when server returns a task", async () => {
      const task = makeAnalysisTask({ taskId: "t1" });
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ task })))
      );

      const api = createCloudTaskApi("http://cloud", "token");
      const result = await api.fetchPending();

      expect(result).not.toBeNull();
      expect(result!.taskId).toBe("t1");
      expect((fetchSpy.mock.calls[0][0] as string)).toBe("http://cloud/agent/tasks/pending");
    });

    it("returns null when server returns null task", async () => {
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ task: null })))
      );

      const api = createCloudTaskApi("http://cloud", "token");
      const result = await api.fetchPending();

      expect(result).toBeNull();
    });

    it("returns null on non-ok response", async () => {
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(new Response("", { status: 500 }))
      );

      const api = createCloudTaskApi("http://cloud", "token");
      const result = await api.fetchPending();

      expect(result).toBeNull();
    });

    it("sends Bearer auth header", async () => {
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ task: null })))
      );

      const api = createCloudTaskApi("http://cloud", "my-secret-token");
      await api.fetchPending();

      const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer my-secret-token");
    });
  });

  describe("submitResult", () => {
    it("POSTs patch to the result endpoint", async () => {
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(new Response("{}"))
      );

      const api = createCloudTaskApi("http://cloud", "token");
      await api.submitResult("task-1", { status: "running", triageResult: { label: "frontend" } });

      expect((fetchSpy.mock.calls[0][0] as string)).toBe("http://cloud/agent/tasks/task-1/result");

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body as string);
      expect(body.status).toBe("running");
      expect(body.triageResult.label).toBe("frontend");
    });

    it("does not throw on non-ok response", async () => {
      fetchSpy = spyOn(globalThis, "fetch").mockImplementation(() =>
        Promise.resolve(new Response("", { status: 500 }))
      );

      const api = createCloudTaskApi("http://cloud", "token");
      await expect(api.submitResult("task-1", {})).resolves.toBeUndefined();
    });
  });
});
