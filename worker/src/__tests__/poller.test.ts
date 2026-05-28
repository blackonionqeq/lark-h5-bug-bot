import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { createCloudTaskApi } from "../poller";
import { makeAnalysisTask } from "../test-fixtures";

function mockFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return spyOn(globalThis, "fetch").mockImplementation(implementation as unknown as typeof fetch);
}

describe("createCloudTaskApi", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
  });

  describe("fetchPending", () => {
    it("returns task when server returns a task", async () => {
      const task = makeAnalysisTask({ taskId: "t1" });
      fetchSpy = mockFetch(() =>
        Promise.resolve(new Response(JSON.stringify({ task })))
      );

      const api = createCloudTaskApi("http://cloud", "token");
      const result = await api.fetchPending();

      expect(result).not.toBeNull();
      expect(result!.taskId).toBe("t1");
      expect((fetchSpy.mock.calls[0][0] as string)).toBe("http://cloud/agent/tasks/pending");
    });

    it("returns null when server returns null task", async () => {
      fetchSpy = mockFetch(() =>
        Promise.resolve(new Response(JSON.stringify({ task: null })))
      );

      const api = createCloudTaskApi("http://cloud", "token");
      const result = await api.fetchPending();

      expect(result).toBeNull();
    });

    it("returns null on non-ok response", async () => {
      consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
      fetchSpy = mockFetch(() =>
        Promise.resolve(new Response("origin timeout", {
          status: 522,
          headers: {
            "server": "cloudflare",
            "cf-ray": "ray-1",
          },
        }))
      );

      const api = createCloudTaskApi("http://cloud", "token");
      const result = await api.fetchPending();

      expect(result).toBeNull();
      expect(consoleErrorSpy.mock.calls[0][0]).toContain("拉取任务失败");
      expect(consoleErrorSpy.mock.calls[0][0]).toContain("status=522");
      expect(consoleErrorSpy.mock.calls[0][0]).toContain("server:cloudflare");
      expect(consoleErrorSpy.mock.calls[0][0]).toContain("cf-ray:ray-1");
      expect(consoleErrorSpy.mock.calls[0][0]).toContain("origin timeout");
    });

    it("returns null and logs diagnostics when fetch throws", async () => {
      consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
      fetchSpy = mockFetch(() => Promise.reject(new Error("dns failed")));

      const api = createCloudTaskApi("http://cloud", "token");
      const result = await api.fetchPending();

      expect(result).toBeNull();
      expect(consoleErrorSpy.mock.calls[0][0]).toContain("拉取任务异常");
      expect(consoleErrorSpy.mock.calls[0][0]).toContain("url=http://cloud/agent/tasks/pending");
      expect(consoleErrorSpy.mock.calls[0][0]).toContain("dns failed");
    });

    it("sends Bearer auth header", async () => {
      fetchSpy = mockFetch(() =>
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
      fetchSpy = mockFetch(() =>
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
      consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
      fetchSpy = mockFetch(() =>
        Promise.resolve(new Response("", { status: 500 }))
      );

      const api = createCloudTaskApi("http://cloud", "token");
      await expect(api.submitResult("task-1", {})).resolves.toBeUndefined();
      expect(consoleErrorSpy.mock.calls[0][0]).toContain("提交结果失败");
      expect(consoleErrorSpy.mock.calls[0][0]).toContain("status=500");
    });

    it("does not throw when result submission fetch throws", async () => {
      consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
      fetchSpy = mockFetch(() => Promise.reject(new Error("connection reset")));

      const api = createCloudTaskApi("http://cloud", "token");
      await expect(api.submitResult("task-1", {})).resolves.toBeUndefined();

      expect(consoleErrorSpy.mock.calls[0][0]).toContain("提交结果异常");
      expect(consoleErrorSpy.mock.calls[0][0]).toContain("connection reset");
    });
  });
});
