import { describe, it, expect, beforeEach } from "bun:test";
import { createSqliteTaskStore, createTaskStore } from "../task-store";
import type { TaskStore } from "../../types";
import { makeAnalysisTask, makeFixTask } from "../../test-fixtures";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("MemoryTaskStore", () => {
  let taskStore: TaskStore;

  beforeEach(() => {
    taskStore = createTaskStore();
  });

  describe("enqueue", () => {
    it("adds a task to the queue and makes it claimable", () => {
      const task = makeAnalysisTask({ taskId: "t1" });
      taskStore.enqueue(task);

      const claimed = taskStore.claim();
      expect(claimed).not.toBeNull();
      expect(claimed!.taskId).toBe("t1");
      expect(claimed!.status).toBe("claimed");
    });

    it("maintains FIFO order", () => {
      taskStore.enqueue(makeAnalysisTask({ taskId: "t1" }));
      taskStore.enqueue(makeAnalysisTask({ taskId: "t2" }));
      taskStore.enqueue(makeAnalysisTask({ taskId: "t3" }));

      expect(taskStore.claim()!.taskId).toBe("t1");
      expect(taskStore.claim()!.taskId).toBe("t2");
      expect(taskStore.claim()!.taskId).toBe("t3");
    });
  });

  describe("claim", () => {
    it("returns null when queue is empty", () => {
      expect(taskStore.claim()).toBeNull();
    });

    it("sets status to claimed and updates updatedAt", () => {
      const task = makeAnalysisTask({ taskId: "t1", status: "queued", updatedAt: "old" });
      taskStore.enqueue(task);

      const claimed = taskStore.claim();
      expect(claimed!.status).toBe("claimed");
      expect(claimed!.updatedAt).not.toBe("old");
    });
  });

  describe("update", () => {
    it("merges patch into existing task", () => {
      const task = makeAnalysisTask({ taskId: "t1", status: "queued" });
      taskStore.enqueue(task);
      taskStore.claim();

      taskStore.update("t1", { status: "completed" });
      const updated = taskStore.get("t1");
      expect(updated!.status).toBe("completed");
    });

    it("does not throw for non-existent task id", () => {
      expect(() => taskStore.update("nonexistent", { status: "completed" })).not.toThrow();
    });
  });

  describe("get", () => {
    it("returns undefined for unknown task id", () => {
      expect(taskStore.get("nonexistent")).toBeUndefined();
    });

    it("returns the task for known id", () => {
      const task = makeAnalysisTask({ taskId: "t1" });
      taskStore.enqueue(task);

      expect(taskStore.get("t1")).toBeDefined();
      expect(taskStore.get("t1")!.taskId).toBe("t1");
    });
  });
});

describe("SqliteTaskStore", () => {
  it("persists queued tasks across reopen", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bugbot-task-store-"));
    const path = join(dir, "tasks.sqlite");
    try {
      let first: TaskStore | undefined = createSqliteTaskStore(path);
      first.enqueue(makeAnalysisTask({ taskId: "persisted" }));
      first.close?.();
      first = undefined;
      Bun.gc(true);

      let second: TaskStore | undefined = createSqliteTaskStore(path);
      expect(second.claim()!.taskId).toBe("persisted");
      second.close?.();
      second = undefined;
      Bun.gc(true);
    } finally {
      Bun.gc(true);
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          await rm(dir, { recursive: true, force: true });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
          if (attempt === 9) break; // Bun SQLite on Windows may keep a closed file handle until process exit.
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
  });

  it("recovers interrupted tasks and finds active fixes", () => {
    const store = createSqliteTaskStore(":memory:");
    const fix = makeFixTask({ taskId: "fix-active", analysisTaskId: "analysis-1" });
    store.enqueue(fix);
    expect(store.findActiveFixByAnalysisTask("analysis-1")?.taskId).toBe("fix-active");
    store.update("fix-active", { status: "completed" });
    expect(store.findActiveFixByAnalysisTask("analysis-1")).toBeUndefined();
    store.close?.();
  });
});
