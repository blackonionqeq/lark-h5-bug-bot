import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { createZentaoRouter } from "../zentao";
import { taskStore } from "../../services/task-store";
import { makeAppConfig } from "../../test-fixtures";

function mockFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return spyOn(globalThis, "fetch").mockImplementation(implementation as unknown as typeof fetch);
}

const ZENTAO_TEXT = `【🔔 禅道BUG修改提醒】
🧑‍💻 创建人：张三
🎬 操作人：李四
👤 指派人：王五
📝 BUG标题：页面白屏
🆔 BUG编号：#80407
📊 BUG状态：active
⚡ 优先级：3
💥 严重程度：3
🧾 BUG描述：打开首页后白屏
📋 重现步骤：1. 登录
2. 进入首页
✅ 期望结果：页面正常展示
❌ 实际结果：页面白屏
🔗 详情链接：http://zentao.example.com/bug-view-80407.html`;

const RESOLVED_ZENTAO_TEXT = `【🔔 禅道BUG修改提醒】
🧑‍💻 创建人：张三
🎬 操作人：李四
👤 指派人：测试同学
📝 BUG标题：页面白屏
🆔 BUG编号：#80408
📊 BUG状态：resolved
⚡ 优先级：3
💥 严重程度：3
🔗 详情链接：http://zentao.example.com/bug-view-80408.html`;

describe("POST /webhook/zentao", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  let app: ReturnType<typeof createZentaoRouter>;

  beforeEach(() => {
    let task = taskStore.claim();
    while (task) task = taskStore.claim();
    fetchSpy = mockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "fake-token", data: {} }))
      )
    );

    const config = makeAppConfig();
    app = createZentaoRouter(config);
  });

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("returns success on valid payload", async () => {
    const res = await app.handle(
      new Request("http://localhost/webhook/zentao", {
        method: "POST",
        body: JSON.stringify({ text: ZENTAO_TEXT }),
        headers: { "content-type": "application/json" },
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("enqueues a task for the active bug", async () => {
    await app.handle(
      new Request("http://localhost/webhook/zentao", {
        method: "POST",
        body: JSON.stringify({ text: ZENTAO_TEXT }),
        headers: { "content-type": "application/json" },
      })
    );

    const task = taskStore.claim();
    expect(task).not.toBeNull();
    expect(task!.issueId).toBe("80407");
    expect(task!.description).toContain("描述: 打开首页后白屏");
    expect(task!.description).toContain("重现步骤: 1. 登录\n2. 进入首页");
  });

  it("does not enqueue a task for non-active bug updates", async () => {
    const res = await app.handle(
      new Request("http://localhost/webhook/zentao", {
        method: "POST",
        body: JSON.stringify({ text: RESOLVED_ZENTAO_TEXT }),
        headers: { "content-type": "application/json" },
      })
    );

    expect(res.status).toBe(200);
    const task = taskStore.claim();
    expect(task).toBeNull();
  });

  it("returns failure when text is unparseable", async () => {
    const res = await app.handle(
      new Request("http://localhost/webhook/zentao", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(false);
  });

  it("returns 500 on error by restoring fetch to throw", async () => {
    fetchSpy?.mockRestore();
    fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    const app2 = createZentaoRouter(makeAppConfig());
    const res = await app2.handle(
      new Request("http://localhost/webhook/zentao", {
        method: "POST",
        body: JSON.stringify({ text: ZENTAO_TEXT }),
        headers: { "content-type": "application/json" },
      })
    );

    expect(res.status).toBe(500);
  });
});
