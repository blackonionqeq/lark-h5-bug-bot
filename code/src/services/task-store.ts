import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";
import type { FixTask, TaskStore, WorkerTask } from "../types";
import { getTaskType } from "../types";

const ACTIVE_FIX_STATUSES = new Set(["queued", "claimed", "preparing", "fixing", "validating", "committing"]);

class MemoryTaskStore implements TaskStore {
  private tasks = new Map<string, WorkerTask>();
  private queue: string[] = [];

  enqueue(task: WorkerTask): void {
    this.tasks.set(task.taskId, structuredClone(task));
    this.queue.push(task.taskId);
    console.log(`[TaskStore] 任务入队: ${task.taskId}, type=${getTaskType(task)}, 队列长度: ${this.queue.length}`);
  }

  claim<T extends WorkerTask = import("../types").AnalysisTask>(): T | null {
    while (this.queue.length > 0) {
      const taskId = this.queue.shift();
      if (!taskId) return null;
      const task = this.tasks.get(taskId);
      if (!task || task.status !== "queued") continue;
      task.status = "claimed";
      task.updatedAt = new Date().toISOString();
      return structuredClone(task) as T;
    }
    return null;
  }

  update<T extends WorkerTask = import("../types").AnalysisTask>(taskId: string, patch: Partial<T>): void {
    const task = this.tasks.get(taskId);
    if (!task) {
      console.warn(`[TaskStore] 更新失败，任务不存在: ${taskId}`);
      return;
    }
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
  }

  get<T extends WorkerTask = import("../types").AnalysisTask>(taskId: string): T | undefined {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) as T : undefined;
  }

  findActiveFixByAnalysisTask(analysisTaskId: string): FixTask | undefined {
    for (const task of this.tasks.values()) {
      if (
        getTaskType(task) === "fix.run" &&
        (task as FixTask).analysisTaskId === analysisTaskId &&
        ACTIVE_FIX_STATUSES.has(task.status)
      ) {
        return structuredClone(task as FixTask);
      }
    }
    return undefined;
  }

  findFixByAnalysisTask(analysisTaskId: string): FixTask | undefined {
    let found: FixTask | undefined;
    for (const task of this.tasks.values()) {
      if (getTaskType(task) === "fix.run" && (task as FixTask).analysisTaskId === analysisTaskId) {
        found = structuredClone(task as FixTask);
      }
    }
    return found;
  }
}

type TaskRow = { payload: string };

class SqliteTaskStore implements TaskStore {
  private db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL UNIQUE,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL,
        analysis_task_id TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_claim ON tasks(status, sequence);
      CREATE INDEX IF NOT EXISTS idx_tasks_analysis ON tasks(analysis_task_id, task_type, status);
    `);
    this.recoverInterruptedTasks();
  }

  enqueue(task: WorkerTask): void {
    const type = getTaskType(task);
    const analysisTaskId = type === "fix.run" ? (task as FixTask).analysisTaskId : null;
    this.run(`
      INSERT INTO tasks(task_id, task_type, status, analysis_task_id, payload, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      ON CONFLICT(task_id) DO NOTHING
    `, task.taskId, type, task.status, analysisTaskId, JSON.stringify(task), task.createdAt, task.updatedAt);
  }

  claim<T extends WorkerTask = import("../types").AnalysisTask>(): T | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.getRow(`SELECT payload FROM tasks WHERE status = 'queued' ORDER BY sequence LIMIT 1`) as TaskRow | null;
      if (!row) {
        this.db.exec("COMMIT");
        return null;
      }
      const task = JSON.parse(row.payload) as WorkerTask;
      task.status = "claimed";
      task.updatedAt = new Date().toISOString();
      this.write(task);
      this.db.exec("COMMIT");
      return task as T;
    } catch (error) {
      if (this.db.inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  update<T extends WorkerTask = import("../types").AnalysisTask>(taskId: string, patch: Partial<T>): void {
    const task = this.get<WorkerTask>(taskId);
    if (!task) {
      console.warn(`[TaskStore] 更新失败，任务不存在: ${taskId}`);
      return;
    }
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.write(task);
  }

  get<T extends WorkerTask = import("../types").AnalysisTask>(taskId: string): T | undefined {
    const row = this.getRow("SELECT payload FROM tasks WHERE task_id = ?1", taskId) as TaskRow | null;
    return row ? JSON.parse(row.payload) as T : undefined;
  }

  findActiveFixByAnalysisTask(analysisTaskId: string): FixTask | undefined {
    const statuses = [...ACTIVE_FIX_STATUSES];
    const placeholders = statuses.map(() => "?").join(", ");
    const row = this.getRow(`
      SELECT payload FROM tasks
      WHERE task_type = 'fix.run' AND analysis_task_id = ? AND status IN (${placeholders})
      ORDER BY sequence DESC LIMIT 1
    `, analysisTaskId, ...statuses) as TaskRow | null;
    return row ? JSON.parse(row.payload) as FixTask : undefined;
  }

  findFixByAnalysisTask(analysisTaskId: string): FixTask | undefined {
    const row = this.getRow(`
      SELECT payload FROM tasks
      WHERE task_type = 'fix.run' AND analysis_task_id = ?1
      ORDER BY sequence DESC LIMIT 1
    `, analysisTaskId) as TaskRow | null;
    return row ? JSON.parse(row.payload) as FixTask : undefined;
  }

  close(): void {
    this.db.close(true);
  }

  private write(task: WorkerTask): void {
    this.run(
      `UPDATE tasks SET status = ?1, payload = ?2, updated_at = ?3 WHERE task_id = ?4`,
      task.status,
      JSON.stringify(task),
      task.updatedAt,
      task.taskId
    );
  }

  private recoverInterruptedTasks(): void {
    const rows = this.allRows(`
      SELECT payload FROM tasks
      WHERE status IN ('claimed', 'running', 'preparing', 'fixing', 'validating', 'committing')
    `) as TaskRow[];
    for (const row of rows) {
      const task = JSON.parse(row.payload) as WorkerTask;
      task.status = "queued";
      task.updatedAt = new Date().toISOString();
      this.write(task);
    }
  }

  private run(sql: string, ...params: any[]): void {
    const statement = this.db.query(sql);
    try {
      statement.run(...params);
    } finally {
      statement.finalize();
    }
  }

  private getRow(sql: string, ...params: any[]): unknown {
    const statement = this.db.query(sql);
    try {
      return statement.get(...params);
    } finally {
      statement.finalize();
    }
  }

  private allRows(sql: string, ...params: any[]): unknown[] {
    const statement = this.db.query(sql);
    try {
      return statement.all(...params);
    } finally {
      statement.finalize();
    }
  }
}

export function createTaskStore(): TaskStore {
  return new MemoryTaskStore();
}

export function createSqliteTaskStore(path: string): TaskStore {
  return new SqliteTaskStore(path);
}

let activeStore: TaskStore = createTaskStore();

export const taskStore: TaskStore = {
  enqueue: (task) => activeStore.enqueue(task),
  claim: <T extends WorkerTask = import("../types").AnalysisTask>() => activeStore.claim<T>(),
  update: <T extends WorkerTask = import("../types").AnalysisTask>(taskId: string, patch: Partial<T>) => activeStore.update<T>(taskId, patch),
  get: <T extends WorkerTask = import("../types").AnalysisTask>(taskId: string) => activeStore.get<T>(taskId),
  findActiveFixByAnalysisTask: (analysisTaskId) => activeStore.findActiveFixByAnalysisTask(analysisTaskId),
  findFixByAnalysisTask: (analysisTaskId) => activeStore.findFixByAnalysisTask(analysisTaskId),
  close: () => activeStore.close?.(),
};

export function configureTaskStore(path: string): void {
  activeStore.close?.();
  activeStore = createSqliteTaskStore(path);
}
