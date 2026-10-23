import { beforeEach, describe, expect, it } from "bun:test";
import { createFeishuCardCallbackRouter, decryptLarkEvent } from "../feishu-card-callback";
import { taskStore } from "../../services/task-store";
import { makeAnalysisTask, makeAppConfig, makeAnalysisResult } from "../../test-fixtures";
import type { WorkerTask } from "../../types";

describe("POST /callback/feishu/card", () => {
  beforeEach(() => {
    while (taskStore.claim<WorkerTask>()) {
      // Drain queued tasks from the shared in-memory store.
    }
  });

  it("creates one fix task for an eligible analysis and is idempotent", async () => {
    taskStore.enqueue(makeAnalysisTask({
      taskId: "analysis-card-1",
      status: "completed",
      analysisResult: makeAnalysisResult({ status: "resolved" }),
      repoSnapshot: { projectName: "mall-h5", commitSha: "abc123", dirty: false },
    }));
    const app = createFeishuCardCallbackRouter(makeAppConfig({ larkVerificationToken: "verify-token" }));
    const body = {
      header: { token: "verify-token" },
      event: {
        operator: { operator_id: { open_id: "ou_user" } },
        action: { value: { action: "fix.request", analysisTaskId: "analysis-card-1" } },
      },
    };

    const first = await app.handle(new Request("http://localhost/callback/feishu/card", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    const second = await app.handle(new Request("http://localhost/callback/feishu/card", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const fix = taskStore.claim<WorkerTask>();
    expect(fix?.taskType).toBe("fix.run");
    expect(fix && "requestedBy" in fix ? fix.requestedBy : undefined).toBe("ou_user");
    expect(taskStore.claim<WorkerTask>()).toBeNull();
  });

  it("rejects callbacks with an invalid verification token", async () => {
    const app = createFeishuCardCallbackRouter(makeAppConfig({ larkVerificationToken: "expected" }));
    const res = await app.handle(new Request("http://localhost/callback/feishu/card", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ header: { token: "wrong" }, event: {} }),
    }));
    expect(res.status).toBe(401);
  });

  it("answers Feishu URL verification challenges", async () => {
    const app = createFeishuCardCallbackRouter(makeAppConfig({ larkVerificationToken: "verify-token" }));
    const res = await app.handle(new Request("http://localhost/callback/feishu/card", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "url_verification", token: "verify-token", challenge: "challenge-value" }),
    }));
    expect(await res.json()).toEqual({ challenge: "challenge-value" });
  });
});

describe("decryptLarkEvent", () => {
  it("decrypts the official AES-256-CBC sample", () => {
    expect(decryptLarkEvent("P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=", "test key")).toBe("hello world");
  });
});
