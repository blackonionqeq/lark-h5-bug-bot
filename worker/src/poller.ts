import { error } from "./logger";
import { describeFetchError, describeHttpFailure } from "./net-diagnostics";
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
    const url = `${cloudUrl}/agent/tasks/pending`;
    let res: Response;

    try {
      res = await fetch(url, {
        headers: authHeaders,
      });
    } catch (err) {
      error("poller", `拉取任务异常: ${describeFetchError(url, err)}`);
      return null;
    }

    if (!res.ok) {
      error("poller", `拉取任务失败: ${await describeHttpFailure(url, res)}`);
      return null;
    }

    const data = (await res.json()) as { task: AnalysisTask | null };
    return data.task ?? null;
  }

  async function submitResult(
    taskId: string,
    patch: Record<string, unknown>
  ): Promise<void> {
    const url = `${cloudUrl}/agent/tasks/${taskId}/result`;
    let res: Response;

    try {
      res = await fetch(url, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(patch),
      });
    } catch (err) {
      error("poller", `提交结果异常: ${describeFetchError(url, err)}`);
      return;
    }

    if (!res.ok) {
      error("poller", `提交结果失败: ${await describeHttpFailure(url, res)}`);
    }
  }

  return { fetchPending, submitResult };
}
