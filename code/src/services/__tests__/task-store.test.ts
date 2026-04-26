import { describe, it, expect, beforeEach } from "bun:test";
import { createTaskStore } from "../task-store";
import type { TaskStore } from "../../types";
import { makeAnalysisTask } from "../../test-fixtures";

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
