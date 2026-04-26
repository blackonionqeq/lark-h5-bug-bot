import type { AnalysisTask, TaskStore } from "../types";

class MemoryTaskStore implements TaskStore {
  private tasks = new Map<string, AnalysisTask>();
  private queue: string[] = [];

  enqueue(task: AnalysisTask): void {
    this.tasks.set(task.taskId, task);
    this.queue.push(task.taskId);
    console.log(`[TaskStore] 任务入队: ${task.taskId}, 队列长度: ${this.queue.length}`);
  }

  claim(): AnalysisTask | null {
    const taskId = this.queue.shift();
    if (!taskId) return null;
    const task = this.tasks.get(taskId);
    if (!task) return null;
    task.status = "claimed";
    task.updatedAt = new Date().toISOString();
    return task;
  }

  update(taskId: string, patch: Partial<AnalysisTask>): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn(`[TaskStore] 更新失败，任务不存在: ${taskId}`);
      return;
    }
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  }

  get(taskId: string): AnalysisTask | undefined {
    return this.tasks.get(taskId);
  }
}

export function createTaskStore(): TaskStore {
  return new MemoryTaskStore();
}

export const taskStore: TaskStore = createTaskStore();
