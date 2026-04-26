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

export function triage(title?: string, description?: string): TriageResult {
  const text = `${title ?? ""} ${description ?? ""}`;
  const matchedRules: string[] = [];
  let score = 0;

  for (const re of FRONTEND_SIGNALS) {
    if (re.test(text)) {
      score++;
      matchedRules.push(`frontend:${re.source}`);
    }
  }

  for (const re of BACKEND_SIGNALS) {
    if (re.test(text)) {
      score--;
      matchedRules.push(`backend:${re.source}`);
    }
  }

  const label = score < 0 ? "non-frontend" : "frontend";
  const reason =
    matchedRules.length > 0
      ? `命中规则: ${matchedRules.join(", ")}`
      : "没有命中任何规则，默认归类为前端";

  return { label, source: "rules", reason, matchedRules };
}
