import type { AppConfig } from "./types";

function requireEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getConfig(overrides?: Partial<AppConfig>): AppConfig {
  if (overrides) {
    return {
      appID: "",
      appSecret: "",
      chatID: "",
      port: 3000,
      userMentions: {},
      ...overrides,
    };
  }

  const portValue = Bun.env.PORT;
  const port = portValue ? Number(portValue) : 3000;

  if (Number.isNaN(port)) {
    throw new Error("PORT must be a valid number");
  }

  let userMentions: Record<string, string> = {};
  if (Bun.env.USER_MENTIONS) {
    try {
      userMentions = JSON.parse(Bun.env.USER_MENTIONS);
    } catch {
      console.warn("USER_MENTIONS 格式错误，应为 JSON 对象");
    }
  }

  return {
    appID: requireEnv("APP_ID"),
    appSecret: requireEnv("APP_SECRET"),
    chatID: requireEnv("CHAT_ID"),
    port,
    agentApiToken: Bun.env.AGENT_API_TOKEN,
    userMentions,
  };
}
