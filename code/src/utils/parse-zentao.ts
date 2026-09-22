import type { ZentaoParsedFields, ZentaoWebhookPayload } from "../types";

/**
 * 禅道 webhook 有两种 payload 形态，这里都支持：
 *
 * 1) 「标签文本」格式（自定义模板，整份报告塞在 text 里）
 *    📝 BUG标题：xxx / 🆔 BUG编号：#12345 / 📊 BUG状态：active ...
 *    —— 老格式，信息最全，优先级最高。
 *
 * 2) 禅道原生格式（标准禅道开箱即用的固定字段）
 *    {
 *      objectType: "bug", objectID: 5, product: ",1,", action: "opened",
 *      actor: "admin", date: "...", comment: "",
 *      text: "admin创建了Bug [#5::[白屏]标题](http://zentao/bug-view-5.html)"
 *    }
 *    原生格式**没有状态字段**，只有 action，需要映射：
 *      opened / edited / assigned / ... → active（会入队分析）
 *      resolved / closed / deleted      → 原状态（只通知，不入队）
 *      未知 action                      → 原样保留（只通知，不入队）并打日志
 *
 * 两种形态同时存在时逐字段取「标签优先、原生兜底」，因此禅道里把模板改成
 * 带 BUG描述/BUG状态 的自定义文本后，也能自动拿到更多字段。
 */

/** 禅道原生 text 里的通知行：`admin创建了Bug [#5::标题](链接)` */
const NATIVE_LINK_RE = /\[#(\d+)::([\s\S]*?)\]\(([^)]*)\)/;

/** 等价于「进行中」的 action → 会入队分析 */
const ACTIVE_ACTIONS = new Set([
  "opened",
  "edited",
  "assigned",
  "activated",
  "confirmed",
  "commented",
  "comment",
]);

/** 收尾/移除类 action → 只通知不入队 */
const INACTIVE_ACTIONS = new Set(["resolved", "closed", "deleted"]);

type PartialParsed = Partial<ZentaoParsedFields> & { bugId?: string };

/** 取第一个非空值（用于「标签优先、原生兜底」的合并），只接受字符串/数字 */
function first(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string" && typeof value !== "number") continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

/** 禅道原生字段是否在场（objectType / objectID / action 任一命中即可） */
function hasNativeShape(payload: ZentaoWebhookPayload): boolean {
  return ["objectType", "objectID", "objectId", "action"].some((key) => {
    const value = (payload as Record<string, unknown>)[key];
    return value !== undefined && value !== null && String(value).trim() !== "";
  });
}

/** 禅道 action → 本项目的状态字段 */
function mapActionToStatus(action: unknown): string {
  const normalized = typeof action === "string" ? action.trim().toLowerCase() : "";
  if (!normalized) return "";
  if (INACTIVE_ACTIONS.has(normalized)) return normalized;
  if (ACTIVE_ACTIONS.has(normalized)) return "active";
  console.warn(`未知禅道 action「${normalized}」：仅发通知，不进入分析队列`);
  return normalized;
}

/** 禅道那边可能配成不带 scheme 的域名（如 `100.98.41.37/zentao/...`），补上以便点击 */
function normalizeLink(link: string): string {
  if (!link) return "";
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(link) ? link : `http://${link}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 形态 1：从整段文本里抠中文标签 */
function parseLabelFormat(text: string): PartialParsed {
  const extract = (label: string): string | undefined => {
    const regex = new RegExp(`(?:^|\\n).*${escapeRegex(label)}[：:]\\s*([^\\n]*(?:\\n(?!.*[：:]).*)*)`);
    const match = text.match(regex);
    return match?.[1]?.trim();
  };

  const bugIdRaw = extract("BUG编号") ?? "";

  return {
    bugId: bugIdRaw.replace(/^#/, ""),
    title: extract("BUG标题"),
    status: extract("BUG状态"),
    priority: extract("优先级"),
    severity: extract("严重程度"),
    creator: extract("创建人"),
    operator: extract("操作人"),
    assignee: extract("指派人"),
    description: extract("BUG描述") ?? extract("描述") ?? extract("需求描述"),
    steps: extract("重现步骤") ?? extract("复现步骤") ?? extract("操作步骤"),
    expected: extract("期望结果") ?? extract("预期结果"),
    actual: extract("实际结果") ?? extract("实际情况"),
    link: extract("详情链接"),
  };
}

/** 形态 2：禅道原生固定字段 + text 里的 markdown 通知行 */
function parseNativeFormat(payload: ZentaoWebhookPayload, text: string): PartialParsed {
  const raw = payload as Record<string, unknown>;
  const linkMatch = text.match(NATIVE_LINK_RE);
  const bugId = first(raw.objectID, raw.objectId, raw.id, linkMatch?.[1]).replace(/^#/, "");
  const action = typeof raw.action === "string" ? raw.action.trim().toLowerCase() : "";
  const actor = first(raw.actor);
  const comment = first(raw.comment);
  // 没有 markdown 链接时退回纯文本标题（把链接语法还原成标题本身）
  const fallbackTitle = text.replace(NATIVE_LINK_RE, "$2").trim().slice(0, 120);

  return {
    bugId,
    title: first(linkMatch?.[2], fallbackTitle),
    status: mapActionToStatus(raw.action),
    creator: action === "opened" ? actor : "",
    operator: actor,
    link: linkMatch?.[3],
    description: comment,
  };
}

export function parseZentaoText(payload: ZentaoWebhookPayload): ZentaoParsedFields | null {
  const text = typeof payload.text === "string" ? payload.text : "";
  const native = hasNativeShape(payload);

  if (!text && !native) return null;

  const fromLabels: PartialParsed = text ? parseLabelFormat(text) : {};
  const fromNative: PartialParsed = native ? parseNativeFormat(payload, text) : {};

  const merged: ZentaoParsedFields = {
    bugId: first(fromLabels.bugId, fromNative.bugId),
    title: first(fromLabels.title, fromNative.title),
    // 状态是个例外：原生 action 是机器可读的事实，优先于模板里写死的文本，
    // 否则模板里一句写死的「BUG状态：active」会让 resolved/closed 事件也入队白烧 token
    status: first(fromNative.status, fromLabels.status),
    priority: first(fromLabels.priority, fromNative.priority),
    severity: first(fromLabels.severity, fromNative.severity),
    creator: first(fromLabels.creator, fromNative.creator),
    operator: first(fromLabels.operator, fromNative.operator),
    assignee: first(fromLabels.assignee, fromNative.assignee),
    link: normalizeLink(first(fromLabels.link, fromNative.link)),
  };

  // BUG 编号是硬要求：没有它无法定位 issue，整条丢弃
  if (!merged.bugId) return null;

  const description = first(fromLabels.description, fromNative.description);
  const steps = first(fromLabels.steps);
  const expected = first(fromLabels.expected);
  const actual = first(fromLabels.actual);

  if (description) merged.description = description;
  if (steps) merged.steps = steps;
  if (expected) merged.expected = expected;
  if (actual) merged.actual = actual;

  return merged;
}
