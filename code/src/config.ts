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
      ...overrides,
    };
  }

  const portValue = Bun.env.PORT;
  const port = portValue ? Number(portValue) : 3000;

  if (Number.isNaN(port)) {
    throw new Error("PORT must be a valid number");
  }

  return {
    appID: requireEnv("APP_ID"),
    appSecret: requireEnv("APP_SECRET"),
    chatID: requireEnv("CHAT_ID"),
    port,
    agentApiToken: Bun.env.AGENT_API_TOKEN,
  };
}
