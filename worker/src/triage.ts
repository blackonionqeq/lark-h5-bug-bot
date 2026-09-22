import type { TriageResult } from "../../code/src/types";

const FRONTEND_SIGNALS = [
  /页面/, /样式/, /布局/, /渲染/, /显示/, /UI/,
  /按钮/, /点击/, /弹窗/, /表单/, /输入/, /下拉/,
  /前端/, /浏览器/, /兼容/, /控制台/, /console/,
  /loading/, /闪/, /白屏/, /刷新/, /滚动/, /适配/,
];

const BACKEND_SIGNALS = [
  /接口/, /API/, /数据库/, /SQL/, /后端/, /服务端/,
  /nginx/, /服务器/, /部署/, /定时任务/, /队列/,
  /redis/, /缓存/, /权限.{0,4}(配置|错误)/, /docker/,
];

/** Bun 的转译器会把正则字面量里的非 ASCII 字符改写成 \uXXXX 转义，而
 *  RegExp#source 返回的是「模式原文」—— 于是分诊理由会输出
 *  `backend:\u63A5\u53E3` 这种不可读的东西（匹配本身正常，只是展示难看）。
 *  这里把转义解回可读文本；Node/V8 下 source 本来就是中文，转换对它无害。 */
function readableSource(re: RegExp): string {
  return re.source.replace(
    /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g,
    (_, codePoint: string, code: string) => String.fromCodePoint(parseInt(codePoint ?? code, 16))
  );
}

export function triage(title?: string, description?: string): TriageResult {
  const text = `${title ?? ""} ${description ?? ""}`;
  const matchedRules: string[] = [];
  let score = 0;

  for (const re of FRONTEND_SIGNALS) {
    if (re.test(text)) {
      score++;
      matchedRules.push(`frontend:${readableSource(re)}`);
    }
  }

  for (const re of BACKEND_SIGNALS) {
    if (re.test(text)) {
      score--;
      matchedRules.push(`backend:${readableSource(re)}`);
    }
  }

  const label = score < 0 ? "non-frontend" : "frontend";
  const reason =
    matchedRules.length > 0
      ? `命中规则: ${matchedRules.join(", ")}`
      : "没有命中任何规则，默认归类为前端";

  return { label, source: "rules", reason, matchedRules };
}
