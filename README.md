# 飞书机器人：禅道 Webhook 与分析结果回调转发到飞书

这个项目当前是一个基于 **TypeScript + Bun + Elysia** 的轻量服务，用于：

- 接收禅道 Webhook：`POST /webhook/zentao`
- 接收异步分析结果回调：`POST /callback/analysis-result`
- 将事件内容转发到指定飞书群聊
- 为后续本地任务 / 异步任务扩展保留统一事件处理入口

## 当前技术栈

- Runtime: Bun
- Language: TypeScript
- HTTP framework: Elysia
- Package manager: pnpm

项目代码位于：
- `code/`

环境变量文件位于：
- `.env`（仓库根目录）

---

## 一、飞书侧准备

1. 登录飞书[开发者后台](https://open.feishu.cn/app)，创建企业自建应用。
2. 在**应用能力 > 添加应用能力**页面，添加**机器人**能力。
3. 在**开发配置 > 权限管理**页面，申请以下 API 权限：
   - 以应用的身份发消息（`im:message:send_as_bot`）
4. 在**应用发布 > 版本管理与发布**页面，创建版本并发布应用，使权限生效。
5. 将应用机器人添加到目标群聊中，确保机器人在群内可发言。

---

## 二、获取目标群聊 chat_id

参考[群 ID 说明](https://go.feishu.cn/s/64KYvl2N802)获取目标群的 `chat_id`。

---

## 三、环境变量配置

在仓库根目录创建 `.env`：

```env
APP_ID=your_app_id
APP_SECRET=your_app_secret
CHAT_ID=your_chat_id
PORT=3000
```

说明：
- `APP_ID`：飞书应用 ID
- `APP_SECRET`：飞书应用密钥
- `CHAT_ID`：目标群 ID
- `PORT`：服务监听端口，可选，默认 `3000`

---

## 四、本地启动

先进入项目目录：

```bash
cd code
```

安装依赖：

```bash
pnpm install
```

启动服务：

```bash
pnpm start
```

开发模式：

```bash
pnpm dev
```

类型检查：

```bash
pnpm typecheck
```

当前启动命令实际会使用 Bun 并显式加载上级目录 `.env`：

```bash
bun --env-file ../.env src/index.ts
```

---

## 五、可用接口

### 1. 禅道 Webhook

路径：

```http
POST /webhook/zentao
```

示例：

```bash
curl -X POST "http://127.0.0.1:3000/webhook/zentao" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "BUG-123",
    "title": "登录失败",
    "status": "open"
  }'
```

成功返回示例：

```json
{
  "success": true,
  "message": "消息已转发到飞书群聊"
}
```

### 2. 分析结果回调

路径：

```http
POST /callback/analysis-result
```

示例：

```bash
curl -X POST "http://127.0.0.1:3000/callback/analysis-result" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "task-001",
    "issueId": "BUG-123",
    "traceId": "trace-001",
    "summary": "analysis done",
    "result": {
      "severity": "high",
      "rootCause": "demo"
    }
  }'
```

成功返回示例：

```json
{
  "success": true,
  "message": "分析结果已转发到飞书群聊",
  "traceId": "trace-001"
}
```

---

## 六、服务当前行为

### 禅道 Webhook 流程

1. 接收 `POST /webhook/zentao`
2. 将请求体转换为内部统一事件
3. 调用本地任务 stub
4. 调用飞书接口发送消息到目标群聊

### 分析结果回调流程

1. 接收 `POST /callback/analysis-result`
2. 将请求体转换为内部统一事件
3. 调用飞书接口发送结果到目标群聊

---

## 七、部署说明

### 1. 服务器要求

至少需要：

- Bun
- pnpm
- 可访问飞书开放平台的网络环境
- 正确的 `.env` 配置
- 一个可被外部系统访问的域名或公网入口

如果需要接收外部 Webhook，请确保服务有公网可访问地址，并将该地址配置到禅道或上游系统中。

例如：
- `https://your-domain.com/webhook/zentao`
- `https://your-domain.com/callback/analysis-result`

### 2. 推荐部署目录

假设服务器部署目录为：

```bash
/opt/lark-h5-bug-bot/
├── .env
└── code/
```

这样可以继续复用当前脚本中的相对路径：

```bash
bun --env-file ../.env src/index.ts
```

### 3. 直接在服务器拉代码部署

先安装依赖：

```bash
cd /opt/lark-h5-bug-bot/code
pnpm install
```

启动服务：

```bash
pnpm start
```

如果只想先验证服务是否能启动：

```bash
pnpm typecheck
pnpm start
```

### 4. 打包后通过 SSH 上传部署

如果你不想在服务器上直接拉代码，可以在本地打包后上传。

在项目根目录执行：

```bash
tar --exclude='code/node_modules' --exclude='.git' -czf lark-h5-bug-bot.tar.gz .
```

上传到服务器：

```bash
scp lark-h5-bug-bot.tar.gz your-user@your-server:/opt/
```

登录服务器后解压：

```bash
ssh your-user@your-server
cd /opt
tar -xzf lark-h5-bug-bot.tar.gz
cd lark-h5-bug-bot/code
pnpm install
```

然后启动：

```bash
pnpm start
```

如果你已经在服务器上放好了旧版本，也可以改用 `rsync` 做增量同步。

### 5. 后台运行

开发期可以直接前台运行，正式环境建议使用进程管理器守护进程，例如 `pm2` 或 `systemd`。

例如用 pm2：

```bash
cd /opt/lark-h5-bug-bot/code
pm2 start "pnpm start" --name lark-h5-bug-bot
pm2 save
```

### 6. 反向代理

如果你希望通过 80/443 端口对外提供服务，建议在前面加 Nginx 反向代理到应用实际监听端口，例如 `3000`。

### 7. 部署后验证

服务启动后，可以先在服务器本机测试：

```bash
curl -X POST "http://127.0.0.1:3000/webhook/zentao" \
  -H "Content-Type: application/json" \
  -d '{"id":"DEPLOY-1","title":"deploy test","status":"open"}'
```

确认服务响应正常、飞书群能收到消息后，再把公网地址配置给禅道或上游系统。

开发阶段若没有公网地址，可以使用反向代理工具临时暴露本地端口，但不建议用于生产环境。

---

## 八、注意事项

1. 向同一群组发送消息存在限频，请控制调用频率。
2. 飞书发送消息接口仅支持应用机器人，自定义机器人不可直接使用该接口。
3. 若 `APP_ID`、`APP_SECRET`、`CHAT_ID` 缺失，服务会在启动阶段直接报错。
4. 当前服务已保留统一事件处理结构，后续可继续扩展更多输入源或异步任务处理链路。
