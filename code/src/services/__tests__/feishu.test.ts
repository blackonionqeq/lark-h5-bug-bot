import { describe, it, expect, afterEach, spyOn } from "bun:test";
import { sendMessageToChat } from "../feishu";
import { makeAppConfig } from "../../test-fixtures";

function mockFetch(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>) {
  return spyOn(globalThis, "fetch").mockImplementation(implementation as unknown as typeof fetch);
}

describe("sendMessageToChat", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it("calls token endpoint and message endpoint in sequence", async () => {
    fetchSpy = mockFetch((url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      if (typeof url === "string" && url.includes("tenant_access_token")) {
        return Promise.resolve(new Response(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "fake-token" })));
      }
      return Promise.resolve(new Response(JSON.stringify({ code: 0, msg: "ok", data: { message_id: "msg-1" } })));
    });

    const config = makeAppConfig();
    const result = await sendMessageToChat(config, "测试消息");

    expect(result).toEqual({ message_id: "msg-1" });

    const calls = fetchSpy.mock.calls;
    expect(calls.length).toBe(2);
    expect((calls[0][0] as string)).toContain("tenant_access_token");
    expect((calls[1][0] as string)).toContain("im/v1/messages");
  });

  it("throws when token response has non-zero code", async () => {
    fetchSpy = mockFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ code: 999, msg: "invalid app" })))
    );

    const config = makeAppConfig();
    await expect(sendMessageToChat(config, "test")).rejects.toThrow("failed to get tenant_access_token");
  });

  it("throws when token HTTP response is not ok", async () => {
    fetchSpy = mockFetch(() =>
      Promise.resolve(new Response("", { status: 500 }))
    );

    const config = makeAppConfig();
    await expect(sendMessageToChat(config, "test")).rejects.toThrow("HTTP 500");
  });

  it("throws when message send response has non-zero code", async () => {
    fetchSpy = mockFetch((url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      if (typeof url === "string" && url.includes("tenant_access_token")) {
        return Promise.resolve(new Response(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "fake-token" })));
      }
      return Promise.resolve(new Response(JSON.stringify({ code: 999, msg: "send failed" })));
    });

    const config = makeAppConfig();
    await expect(sendMessageToChat(config, "test")).rejects.toThrow("failed to send message");
  });

  it("throws when message HTTP response is not ok", async () => {
    fetchSpy = mockFetch((url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      if (typeof url === "string" && url.includes("tenant_access_token")) {
        return Promise.resolve(new Response(JSON.stringify({ code: 0, msg: "ok", tenant_access_token: "fake-token" })));
      }
      return Promise.resolve(new Response("", { status: 403 }));
    });

    const config = makeAppConfig();
    await expect(sendMessageToChat(config, "test")).rejects.toThrow("HTTP 403");
  });
});
