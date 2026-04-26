import { describe, it, expect, beforeEach } from "bun:test";
import { createAgentTasksRouter } from "../agent-tasks";
import { taskStore } from "../../services/task-store";
import { makeAnalysisTask, makeTriageResult, makeAnalysisResult } from "../../test-fixtures";

const TOKEN = "test-agent-token";

function authHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    "content-type": "application/json",
  };
}

describe("Agent Tasks API", () => {
  let app: ReturnType<typeof createAgentTasksRouter>;

  beforeEach(() => {
    // Fully drain the queue
    let task = taskStore.claim();
    while (task) task = taskStore.claim();
    app = createAgentTasksRouter(TOKEN);
  });

  describe("authentication", () => {
    it("returns 401 without auth header", async () => {
      const res = await app.handle(
        new Request("http://localhost/agent/tasks/pending")
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with wrong token", async () => {
      const res = await app.handle(
        new Request("http://localhost/agent/tasks/pending", {
          headers: { authorization: "Bearer wrong-token" },
        })
      );
      expect(res.status).toBe(401);
    });

    it("accepts token without Bearer prefix", async () => {
      const res = await app.handle(
        new Request("http://localhost/agent/tasks/pending", {
          headers: { authorization: TOKEN },
        })
      );
      expect(res.status).not.toBe(401);
    });
  });

  describe("GET /agent/tasks/pending", () => {
    it("returns null task when queue is empty", async () => {
      const res = await app.handle(
        new Request("http://localhost/agent/tasks/pending", {
          headers: authHeaders(),
        })
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { task: unknown };
      expect(body.task).toBeNull();
    });

    it("claims and returns the first queued task", async () => {
      taskStore.enqueue(makeAnalysisTask({ taskId: "t1", status: "queued" }));
      taskStore.enqueue(makeAnalysisTask({ taskId: "t2", status: "queued" }));

      const res = await app.handle(
        new Request("http://localhost/agent/tasks/pending", {
          headers: authHeaders(),
        })
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { task: { taskId: string; status: string } };
      expect(body.task.taskId).toBe("t1");
      expect(body.task.status).toBe("claimed");
    });
  });

  describe("POST /agent/tasks/:id/claim", () => {
    it("claims a specific task by id", async () => {
      taskStore.enqueue(makeAnalysisTask({ taskId: "t1", status: "queued" }));

      const res = await app.handle(
        new Request("http://localhost/agent/tasks/t1/claim", {
          method: "POST",
          headers: authHeaders(),
        })
      );

      expect(res.status).toBe(200);
      const body = await res.json() as { task: { status: string } };
      expect(body.task.status).toBe("claimed");
    });

    it("returns 404 for unknown task", async () => {
      const res = await app.handle(
        new Request("http://localhost/agent/tasks/unknown/claim", {
          method: "POST",
          headers: authHeaders(),
        })
      );

      expect(res.status).toBe(404);
    });
  });

  describe("POST /agent/tasks/:id/result", () => {
    it("updates task with triageResult", async () => {
      taskStore.enqueue(makeAnalysisTask({ taskId: "t1", status: "queued" }));

      const res = await app.handle(
        new Request("http://localhost/agent/tasks/t1/result", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            triageResult: makeTriageResult({ label: "frontend" }),
            status: "running",
          }),
        })
      );

      expect(res.status).toBe(200);
      const updated = taskStore.get("t1");
      expect(updated!.triageResult!.label).toBe("frontend");
      expect(updated!.status).toBe("running");
    });

    it("updates task with analysisResult", async () => {
      taskStore.enqueue(makeAnalysisTask({ taskId: "t1", status: "running" }));

      const res = await app.handle(
        new Request("http://localhost/agent/tasks/t1/result", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            analysisResult: makeAnalysisResult({ status: "resolved" }),
            status: "completed",
          }),
        })
      );

      expect(res.status).toBe(200);
      const updated = taskStore.get("t1");
      expect(updated!.analysisResult!.status).toBe("resolved");
      expect(updated!.status).toBe("completed");
    });

    it("rejects invalid status values", async () => {
      taskStore.enqueue(makeAnalysisTask({ taskId: "t1", status: "queued" }));

      const res = await app.handle(
        new Request("http://localhost/agent/tasks/t1/result", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({ status: "invalid-status" }),
        })
      );

      expect(res.status).toBe(200);
      // Status should NOT have been updated to the invalid value
      const updated = taskStore.get("t1");
      expect(updated!.status).toBe("queued");
    });

    it("returns 404 for unknown task", async () => {
      const res = await app.handle(
        new Request("http://localhost/agent/tasks/unknown/result", {
          method: "POST",
          headers: authHeaders(),
        })
      );

      expect(res.status).toBe(404);
    });
  });
});
