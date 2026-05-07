import { error } from "./logger";
import type { AnalysisTask } from "../../code/src/types";

export interface CloudTaskApi {
  fetchPending(): Promise<AnalysisTask | null>;
  submitResult(
    taskId: string,
    patch: Record<string, unknown>
  ): Promise<void>;
}

export function createCloudTaskApi(cloudUrl: string, agentToken: string): CloudTaskApi {
  const authHeaders = {
    Authorization: `Bearer ${agentToken}`,
    "Content-Type": "application/json",
  };

  async function fetchPending(): Promise<AnalysisTask | null> {
    const res = await fetch(`${cloudUrl}/agent/tasks/pending`, {
      headers: authHeaders,
    });
    if (!res.ok) {
      error("poller", `拉取任务失败: HTTP ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { task: AnalysisTask | null };
    return data.task ?? null;
  }

  async function submitResult(
    taskId: string,
    patch: Record<string, unknown>
  ): Promise<void> {
    const res = await fetch(`${cloudUrl}/agent/tasks/${taskId}/result`, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      error("poller", `提交结果失败: HTTP ${res.status}`);
    }
  }

  return { fetchPending, submitResult };
}
