import type { ZentaoParsedFields, ZentaoWebhookPayload } from "../types";

/**
 * Parse the Zentao webhook text into structured fields.
 *
 * Expected text format:
 *   【🔔 禅道BUG修改提醒】
 *   🧑‍💻 创建人：xxx
 *   🎬 操作人：xxx
 *   👤 指派人：xxx
 *   📝 BUG标题：xxx
 *   🆔 BUG编号：#12345
 *   📊 BUG状态：resolved
 *   ⚡ 优先级：3
 *   💥 严重程度：3
 *   🔗 详情链接：http://...
 */
export function parseZentaoText(payload: ZentaoWebhookPayload): ZentaoParsedFields | null {
  const text = payload.text;
  if (!text || typeof text !== "string") return null;

  const extract = (label: string): string | undefined => {
    // Match label (which may contain emoji) followed by Chinese/English colon and the value
    const regex = new RegExp(`${escapeRegex(label)}[：:]\\s*(.+)`);
    const match = text.match(regex);
    return match?.[1]?.trim();
  };

  const bugIdRaw = extract("BUG编号") ?? "";
  const bugId = bugIdRaw.replace(/^#/, "");

  const title = extract("BUG标题") ?? "";
  const status = extract("BUG状态") ?? "";
  const priority = extract("优先级") ?? "";
  const severity = extract("严重程度") ?? "";
  const creator = extract("创建人") ?? "";
  const operator = extract("操作人") ?? "";
  const assignee = extract("指派人") ?? "";
  const link = extract("详情链接") ?? "";

  if (!bugId) return null;

  return { bugId, title, status, priority, severity, creator, operator, assignee, link };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
