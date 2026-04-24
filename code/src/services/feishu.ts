import type { AppConfig, FeishuMessageResponse, FeishuTokenResponse } from "../types";

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) {
    throw new Error("Empty response body");
  }
  return JSON.parse(text) as T;
}

async function getTenantAccessToken(appID: string, appSecret: string): Promise<string> {
  const response = await fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: appID,
        app_secret: appSecret,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`Error getting tenant_access_token: HTTP ${response.status}`);
  }

  const result = await parseJsonResponse<FeishuTokenResponse>(response);
  if (result.code !== 0 || !result.tenant_access_token) {
    console.error("Error:", result);
    throw new Error(`failed to get tenant_access_token: ${result.msg}`);
  }

  return result.tenant_access_token;
}

export async function sendMessageToChat(
  config: AppConfig,
  messageContent: string
): Promise<Record<string, unknown> | undefined> {
  const tenantAccessToken = await getTenantAccessToken(config.appID, config.appSecret);
  const url = "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id";

  const payload = {
    receive_id: config.chatID,
    msg_type: "text",
    content: JSON.stringify({
      text: messageContent,
    }),
  };

  console.log("POST:", url);
  console.log("Request payload:", payload);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tenantAccessToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Error sending message: HTTP ${response.status}`);
  }

  const result = await parseJsonResponse<FeishuMessageResponse>(response);
  if (result.code !== 0) {
    console.error("ERROR: 发送消息失败", result);
    throw new Error(`failed to send message: ${result.msg}`);
  }

  console.log("消息发送成功:", result.data);
  return result.data;
}
