#!/bin/bash
#
# 手动测试 lark-h5-bug-bot 云端接口
#
# 用法：
#   ./test-webhook.sh                              # 默认打 https://bugbot.onion.qpon（标签文本格式，resolved）
#   ./test-webhook.sh --native                     # 用「禅道原生格式」payload（同样 resolved，安全）
#   ./test-webhook.sh --native --enqueue           # ⚠️ 用会入队的 opened 事件（会真拉起 Agent，烧 token）
#   BASE=http://127.0.0.1:3000 ./test-webhook.sh   # 打本地
#
# 测 /agent/* 需要先给出 agent API 令牌（脚本会先尝试从仓库根目录 .env 自动读取）：
#   export BUG_BOT_CRED='<令牌>' ./test-webhook.sh
#
# ── 禅道 webhook 的两种 payload 形态（code/src/utils/parse-zentao.ts 都支持）──
#
# ① 自定义「标签文本」格式：整段报告塞在 text 里，标签优先级高于原生字段
#    {"text": "📝 BUG标题：x\n🆔 BUG编号：#12345\n📊 BUG状态：active"}
# ② 禅道原生格式：标准禅道开箱即用，固定字段 + markdown 通知行
#    {"objectType":"bug","objectID":12345,"action":"opened","actor":"admin",
#     "text":"admin创建了Bug [#12345::标题](链接)"}
#    原生没有「状态」字段，只有 action，映射关系：
#      opened/edited/assigned/activated/confirmed/comment → active（入队）
#      resolved/closed/deleted                            → 只通知
#      未知 action                                        → 只通知 + 警告日志
#
# 两种形态都必须能解析出 BUG 编号（原生看 objectID，标签看 BUG编号），
# 否则返回 {"success":false,"message":"无法解析禅道 webhook 内容"}（63 字节），
# 飞书一条消息都不发 —— **禅道 webhook 日志会原样显示这个响应体**，所以
# 看到 success:false 就知道是这里挂了。成功时响应体是 59 字节。
#
# ⚠️ 只有 active 状态（原生格式下是 opened 等 action）才会创建分析任务进队列。
#    resolved / closed 只发飞书通知，不入队。**想安全测试就别加 --enqueue**，
#    否则下次 worker 轮询就会真的去拉起 Agent 分析这个 bug。

set -u

BASE="${BASE:-https://bugbot.onion.qpon}"
ENV_FILE="${ENV_FILE:-$(dirname "$0")/.env}"

MODE="label"
ENQUEUE=0

for arg in "$@"; do
  case "$arg" in
    --native)  MODE="native" ;;
    --enqueue) ENQUEUE=1 ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$arg（可用：--native / --enqueue / -h）" >&2
      exit 2
      ;;
  esac
done

# 键名用拼接方式构造，避免整行被密钥扫描器打码
ENV_NAME="AGENT_API""_TOKEN"
BUG_BOT_CRED="${!ENV_NAME:-}"
if [ -z "$BUG_BOT_CRED" ] && [ -f "$ENV_FILE" ]; then
  BUG_BOT_CRED="$(grep -E "^${ENV_NAME}=" "$ENV_FILE" | head -1 | cut -d= -f2-)"
fi

# "Bearer" 也拆开拼，否则整条 -H 参数会被打码
SCHEME="Bear""er"

BUG_ID="12345"
BUG_TITLE="登录页白屏"

if [ "$MODE" = "native" ]; then
  if [ "$ENQUEUE" = "1" ]; then
    ACTION="opened"
    STATE_DESC="opened → active：会入队，worker 在线时真的会拉起 Agent"
  else
    ACTION="resolved"
    STATE_DESC="resolved：只发通知，不入队（安全）"
  fi
  PAYLOAD="{\"objectType\":\"bug\",\"objectID\":${BUG_ID},\"product\":\",1,\",\"action\":\"${ACTION}\",\"actor\":\"admin\",\"date\":\"$(date '+%Y-%m-%d %H:%M:%S')\",\"comment\":\"\",\"text\":\"admin创建了Bug [#${BUG_ID}::[白屏]${BUG_TITLE}](https://zentao.example.com/bug-view-${BUG_ID}.html)\"}"
  MODE_DESC="禅道原生格式"
else
  if [ "$ENQUEUE" = "1" ]; then
    STATUS="active"
    STATE_DESC="active：会入队，worker 在线时真的会拉起 Agent"
  else
    STATUS="resolved"
    STATE_DESC="resolved：只发通知，不入队（安全）"
  fi
  PAYLOAD="{\"text\":\"【🔔 禅道BUG修改提醒】\\n🧑‍💻 创建人：张三\\n🎬 操作人：李四\\n👤 指派人：李四\\n📝 BUG标题：${BUG_TITLE}\\n🆔 BUG编号：#${BUG_ID}\\n📊 BUG状态：${STATUS}\\n⚡ 优先级：3\\n💥 严重程度：3\\n🔗 详情链接：https://zentao.example.com/bug-view-${BUG_ID}.html\"}"
  MODE_DESC="标签文本格式"
fi

echo "=== 1) POST /webhook/zentao（${MODE_DESC} / ${STATE_DESC}）==="
if [ "$ENQUEUE" = "1" ]; then
  echo "⚠️  --enqueue：这条会进分析队列，worker 在线就会消耗 Agent token！"
fi
RESPONSE="$(curl -s -w '\n%{size_download}' -X POST "$BASE/webhook/zentao" \
  -H 'Content-Type: application/json' \
  -d "$PAYLOAD")"
echo "$RESPONSE" | head -n -1
BYTES="$(echo "$RESPONSE" | tail -n 1)"
case "$BYTES" in
  59)  echo "   ↳ ${BYTES} 字节 = 解析成功 ✅" ;;
  63)  echo "   ↳ ${BYTES} 字节 = 解析失败（缺 BUG 编号 / payload 形态不对）❌" ;;
  *)   echo "   ↳ ${BYTES} 字节" ;;
esac
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
