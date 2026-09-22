# 禅道 Bug 完整字段接入方案

本文说明为什么标准禅道 Webhook 缺少 Bug 重现步骤，以及两种补全方式：修改禅道 Webhook 源码，或在 Bug Bot 收到 Webhook 后调用禅道 Web API 查询详情。

当前验证基线是 **禅道开源版 22.1**。其他版本在采用下面方案前，应先核对相应源码和 API 响应。

## 1. 问题背景

标准“其他”类型 Webhook 的 JSON 主要来自禅道 action 记录，可选字段包括 `objectType`、`objectID`、`action`、`actor`、`comment` 和 `text` 等。Bug 的标题、重现步骤、优先级和严重程度属于 Bug 实体，不属于 action，因此默认 payload 通常只有标题链接，没有 `steps`。

禅道在构造 Webhook 时其实已经查询了完整 Bug 对象，只是默认没有把这些字段放进通用 Webhook JSON。Bug Bot 因此支持以下三种输入，并按兼容方式逐级取值：

1. 自定义标签文本，例如 `BUG标题：`、`重现步骤：`；
2. 扩展后的顶层 Bug 字段，例如 `title`、`steps`；
3. 标准原生字段以及 `text` 中的 Markdown 标题链接。

所有扩展字段都是可选字段。未修改的禅道仍走原来的解析路径；`action` 仍优先决定任务状态，避免扩展字段改变 `resolved`、`closed` 等事件的入队语义。

## 2. 方案一：扩展禅道 Webhook 源码

### 2.1 适用场景

该方案适合快速验证，或者 Cloud 服务无法反向访问禅道的场景。优点是没有额外 HTTP 请求和账号配置；缺点是修改会被禅道升级覆盖。

当前项目采用的是这个方案。

### 2.2 修改位置

禅道文件：

```text
<zentao-root>/module/webhook/model.php
```

修改 `webhookModel::buildData()`。该方法已经通过 `$objectID` 查询到了完整 `$object`，在调用 `getDataByType()` 后，仅对 Bug 的“其他”类型 Webhook 扩展 JSON：

```php
$postData = $this->getDataByType(
    $webhook,
    $action,
    $title,
    $text,
    $mobile,
    $email,
    $objectType,
    $objectID
);

/* “其他”类型在数据库中保存为 default。不要改动钉钉、微信、飞书的消息结构。 */
if($objectType == 'bug' && $webhook->type == 'default')
{
    $data = json_decode($postData);
    if(is_object($data))
    {
        $data->title      = $object->title;
        $data->steps      = $object->steps;
        $data->status     = $object->status;
        $data->pri        = $object->pri;
        $data->severity   = $object->severity;
        $data->openedBy   = $object->openedBy;
        $data->assignedTo = $object->assignedTo;
        $postData = json_encode($data);
    }
}

return $postData;
```

扩展后的示例 payload：

```json
{
  "objectType": "bug",
  "objectID": 12,
  "action": "opened",
  "actor": "admin",
  "comment": "",
  "text": "admin创建了Bug [#12::列表页白屏](http://zentao.example.com/bug-view-12.html)",
  "title": "列表页白屏",
  "steps": "<p>打开列表页后页面白屏</p>",
  "status": "active",
  "pri": "2",
  "severity": "1",
  "openedBy": "tester",
  "assignedTo": "dev"
}
```

### 2.3 操作与验证

1. 修改前备份 `model.php`，文件名中注明日期和禅道版本。
2. 应用补丁后执行 PHP 语法检查：

   ```bash
   php -l <zentao-root>/module/webhook/model.php
   ```

3. 新建一个包含重现步骤的 Bug。
4. 在禅道 Webhook 日志或 Bug Bot 云端日志中确认请求体包含 `steps`。
5. 确认飞书消息和 Worker 任务描述中出现重现步骤。
6. PHP 通常会直接加载新文件；如果 payload 未变化，再重启禅道服务以刷新 Opcode 缓存。

### 2.4 风险和回滚

- 禅道升级、修复或重新安装可能覆盖该文件；升级后必须重新核对 `buildData()`。
- 补丁只应作用于 `objectType == bug` 且 `type == default`，不能向钉钉、企业微信或飞书机器人消息结构直接塞字段。
- `steps` 通常是 HTML，可能包含图片地址和内部信息。日志、飞书通知及 Agent Prompt 都应按实际安全要求处理。
- 回滚时恢复备份的 `model.php`。Bug Bot 无需回滚：新字段均为可选字段，缺失后会自动退回标准原生解析。

## 3. 方案二：通过禅道 Web API 查询 Bug 详情

### 3.1 适用场景

该方案适合长期维护和多禅道环境部署。它不修改禅道源码，禅道升级影响较小，但要求运行 `code/` 的 Cloud 服务能够访问禅道，并需要维护一个受限的禅道 API 账号。

本节是后续实现设计，**当前代码尚未实现 API 补全**。

### 3.2 22.1 API 依据

已验证的禅道 22.1 源码定义了以下路由：

```http
POST /api.php/v1/tokens
GET  /api.php/v1/bugs/:id
```

登录请求：

```http
POST https://zentao.example.com/api.php/v1/tokens
Content-Type: application/json

{
  "account": "bugbot-reader",
  "password": "********"
}
```

成功时返回 HTTP `201`，响应体直接包含会话 Token：

```json
{
  "token": "session-token"
}
```

查询 Bug：

```http
GET https://zentao.example.com/api.php/v1/bugs/12
Token: session-token
Accept: application/json
```

这里使用的是名为 `Token` 的请求头，不是本项目 Agent API 使用的 `Authorization: Bearer ...`。在 22.1 源码中，该 Header 会被作为 PHP Session ID 恢复登录状态。

Bug 详情响应是 Bug 对象，包含 `title`、`steps`、`status`、`pri`、`severity`、`openedBy`、`assignedTo` 等字段。不同禅道版本可能改变路由、鉴权或响应包装，接入其他版本时必须用实际环境验证。

### 3.3 建议实现流程

建议在 Cloud 服务中新增 `code/src/services/zentao.ts`，并在 `code/src/routes/zentao.ts` 中完成解析后、创建事件前调用：

```text
Webhook 到达
  -> 解析 objectType / objectID / action
  -> 仅对 objectType=bug 查询详情
  -> 使用缓存 Token 请求 GET /bugs/:id
  -> 将详情映射到 ZentaoParsedFields
  -> API 失败则保留原 Webhook 数据继续处理
  -> 创建事件、通知飞书、active Bug 入队
```

建议增加以下环境变量；名称只是设计建议，尚未进入当前配置：

```env
ZENTAO_URL=https://zentao.example.com
ZENTAO_ACCOUNT=bugbot-reader
ZENTAO_PASSWORD=change-me
ZENTAO_API_ENRICHMENT=true
```

实现要求：

- 使用专用、最小权限、只读账号；密码只放 `.env`，禁止写入日志。
- Token 在进程内缓存，不要每个 Webhook 都重新登录。
- 详情请求设置 3～5 秒超时。
- 遇到 `401` 或会话失效时，清除 Token、重新登录并只重试一次。
- API 查询失败、超时或响应字段缺失时，记录告警并降级到原 Webhook，不应让 Webhook 返回 `500`。
- 如果 Cloud 无法访问禅道内网或 Tailscale 地址，应先解决网络连通性；否则只能把查询放到本地 Worker，届时需要扩展任务协议。
- 可以在启用前做一段时间的 shadow 日志对比，确认 API 数据与源码扩展 payload 一致。

### 3.4 字段映射

| 禅道来源 | Webhook/API 字段 | Bug Bot 字段 | Worker 中的用途 |
|---|---|---|---|
| Bug ID | `objectID` 或 `id` | `bugId` | `AnalysisTask.issueId` |
| Bug 标题 | `title` | `title` | 分诊、Agent Prompt、飞书标题 |
| 重现步骤 | `steps` | `steps` | 写入任务描述的“重现步骤” |
| 当前状态 | `status` | `status` | 是否进入分析队列 |
| 优先级 | `pri` | `priority` | 飞书通知和分析上下文 |
| 严重程度 | `severity` | `severity` | 飞书通知和分析上下文 |
| 创建人 | `openedBy` | `creator` | 飞书通知和分析上下文 |
| 当前指派人 | `assignedTo` | `assignee` | 飞书通知和人员映射 |
| 本次操作者 | Webhook `actor` | `operator` | 飞书通知 |
| 本次备注 | Webhook `comment` | `description` | 补充上下文；不等同于 `steps` |
| 动作 | Webhook `action` | `status` 的首要判据 | `opened/edited/...` 映射为 `active`；`resolved/closed/deleted` 不入队 |
| 详情链接 | Webhook `text` 中的链接 | `link` | 飞书跳转及 Agent 参考 |

注意：禅道的“描述、重现步骤、实际结果、预期结果”通常共同保存在 `steps` HTML 中，并不保证存在独立的 `description`、`actual`、`expected` 字段。第一版 API 接入应先原样保留 `steps`；如果后续需要纯文本，再在明确保留换行和图片链接规则后统一转换。

### 3.5 从源码扩展迁移到 API

1. 保留现有 Bug Bot 对顶层扩展字段的兼容解析。
2. 实现 API Client、Token 缓存、超时和降级测试。
3. 在一个环境启用 API 补全，对比两种来源的字段。
4. 确认稳定后恢复禅道原始 `webhook/model.php`。
5. 升级禅道时重新验证 `/tokens`、`/bugs/:id`、`Token` Header 和响应字段。

## 4. 选择建议

| 条件 | 建议 |
|---|---|
| 需要立即验证，且可接受升级后重打补丁 | 方案一 |
| Cloud 无法访问禅道，但禅道能访问 Cloud | 方案一 |
| 多环境部署、希望长期维护 | 方案二 |
| 不希望在 Bug Bot 中保存禅道账号 | 方案一或禅道正式扩展插件 |
| 希望完全不修改禅道安装目录 | 方案二 |

当前阶段使用方案一成本最低；当接入更多禅道实例或准备频繁升级禅道时，再迁移到方案二更合适。
