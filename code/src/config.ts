import type { AppConfig } from "./types";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CODE_ROOT = fileURLToPath(new URL("..", import.meta.url));

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
      taskDbPath: ":memory:",
      fixAllowedOpenIds: [],
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
    taskDbPath: Bun.env.TASK_DB_PATH || resolve(CODE_ROOT, "data", "tasks.sqlite"),
    larkVerificationToken: Bun.env.LARK_VERIFICATION_TOKEN,
    larkEncryptKey: Bun.env.LARK_ENCRYPT_KEY,
    fixAllowedOpenIds: (Bun.env.FIX_ALLOWED_OPEN_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    userMentions,
  };
}
