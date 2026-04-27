#!/bin/bash

# 测试禅道 Webhook 接口
echo "=== 测试 /webhook/zentao ==="
curl -s -X POST https://onion.qpon/webhook/zentao \
#curl -s -X POST http://108.75.223.120:3000/webhook/zentao \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "BUG-123",
    "title": "登录页面白屏",
    "severity": "3",
    "priority": "高",
    "status": "active",
    "openedBy": "张三",
    "assignedTo": "李四",
    "product": "H5商城"
  }'
echo -e "\n"

# 测试分析结果回调接口
echo "=== 测试 /callback/analysis-result ==="
curl -s -X POST https://onion.qpon/callback/analysis-result \
#curl -s -X POST http://108.75.223.120:3000/callback/analysis-result \
  -H 'Content-Type: application/json' \
  -d '{
    "taskId": "task-456",
    "issueId": "BUG-123",
    "traceId": "trace-789",
    "result": "定位到问题：组件卸载后 setState 导致白屏",
    "confidence": 0.92
  }'
echo -e "\n"
