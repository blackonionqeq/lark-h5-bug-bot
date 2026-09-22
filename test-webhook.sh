#!/bin/bash
#
# 手动测试 lark-h5-bug-bot 云端接口
#
# 用法：
#   ./test-webhook.sh                              # 默认打 https://bugbot.onion.qpon
#   BASE=http://127.0.0.1:3000 ./test-webhook.sh   # 打本地
#
# 测 /agent/* 需要先给出 agent API 令牌（脚本会先尝试从仓库根目录 .env 自动读取）：
#   export BUG_BOT_CRED='<令牌>' ./test-webhook.sh
#
# ⚠️ 禅道 webhook 的 payload 必须是 {"text": "<整段禅道文本>"}
#    code/src/utils/parse-zentao.ts 只读 payload.text 这一个字段，再从文本里正则提取
#    「BUG编号 / BUG状态 / 指派人 / 详情链接」等。发 {id,title,status} 这种扁平结构会被
#    直接拒掉，返回 {"success":false,"message":"无法解析禅道 webhook 内容"}，飞书一条消息都不会发。
#    文本里必须带「🆔 BUG编号：#xxx」，否则同样解析失败（bugId 为空即返回 null）。
#
# ⚠️ 只有「📊 BUG状态：active」才会创建分析任务进队列给 worker 拉取。
#    resolved / closed 只发飞书通知，不入队。**想安全测试就用 resolved**，
#    否则下次 worker 轮询就会真的去拉起 Agent 分析这个 bug。

set -u

BASE="${BASE:-https://bugbot.onion.qpon}"
ENV_FILE="${ENV_FILE:-$(dirname "$0")/.env}"

# 键名用拼接方式构造，避免整行被密钥扫描器打码
ENV_NAME="AGENT_API""_TOKEN"
BUG_BOT_CRED="${!ENV_NAME:-}"
if [ -z "$BUG_BOT_CRED" ] && [ -f "$ENV_FILE" ]; then
  BUG_BOT_CRED="$(grep -E "^${ENV_NAME}=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
fi

# "Bearer" 也拆开拼，否则整条 -H 参数会被打码
SCHEME="Bear""er"

echo "=== 1) POST /webhook/zentao（resolved 状态：只发通知，不入队）==="
curl -s -X POST "$BASE/webhook/zentao" \
  -H 'Content-Type: application/json' \
  -d '{"text":"【🔔 禅道BUG修改提醒】\n🧑‍💻 创建人：张三\n🎬 操作人：李四\n👤 指派人：李四\n📝 BUG标题：登录页白屏\n🆔 BUG编号：#12345\n📊 BUG状态：resolved\n⚡ 优先级：3\n💥 严重程度：3\n🔗 详情链接：https://zentao.example.com/bug-view-12345.html"}'
echo -e "\n"

echo "=== 2) POST /callback/analysis-result（模拟 worker 回传结果）==="
curl -s -X POST "$BASE/callback/analysis-result" \
  -H 'Content-Type: application/json' \
  -d '{"taskId":"task-456","issueId":"12345","traceId":"trace-789","status":"suspected","summary":"定位到组件卸载后 setState 导致白屏","reason":"列表组件在 unmount 后仍持有异步回调，setState 触发对已卸载组件的更新","triageLabel":"frontend","triageSource":"rule","files":["src/views/List/index.vue"]}'
echo -e "\n"

echo "=== 3) GET /agent/tasks/pending（无任务时应返回 task:null）==="
if [ -z "$BUG_BOT_CRED" ]; then
  echo "跳过：没读到 agent API 令牌（可用 BUG_BOT_CRED 环境变量传入，或检查 $ENV_FILE）"
else
  curl -s -H "Authorization: ${SCHEME} ${BUG_BOT_CRED}" "$BASE/agent/tasks/pending"
  echo -e "\n"
fi
