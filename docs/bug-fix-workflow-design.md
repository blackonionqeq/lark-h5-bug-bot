# Bug 自动修复与本地交付设计

日期：2026-10-23。状态：方案已确认，尚未实现。

本文定义在现有“自动分析 Bug 并发送飞书通知”的基础上，增加由用户触发的本地自动修复能力。第一版只在 Worker 所在机器生成本地 Git 分支和 commit，由开发者在自己的工作目录中 cherry-pick 后验证；不自动推送远端、不创建 Merge Request、不合并或部署。

## 1. 目标与边界

目标流程：

```text
分析完成
  → 用户在飞书点击“尝试修复”
  → 云端创建修复任务
  → Worker 在项目专用 worktree 中修改代码
  → 运行项目已有测试和静态检查
  → 生成本地 bugfix 分支与 commit
  → 飞书返回 commit SHA、测试结果和 cherry-pick 命令
  → 开发者在自己的开发分支 cherry-pick 并人工验证
```

第一版明确不做：

- 不直接修改 `REPO_PATH` 对应的开发者工作目录。
- 不自动 push、创建 Merge Request、合并或部署。
- 不根据 Agent 的结论自动认定 Bug 已解决。
- 不允许同一项目并行执行多个修复任务。
- 不覆盖尚未处理的上一次修复。
- 不要求项目必须已有测试；没有可运行测试时明确报告。

“Agent 已生成修改”“自动检查通过”和“人工确认 Bug 已修复”是三个不同事实，状态和通知中不得混称。

## 2. 架构职责

| 组件 | 责任 |
| --- | --- |
| 云端服务 | 发送飞书交互卡片、验证点击事件、保存分析快照与修复任务、向 Worker 派发任务、转发修复结果 |
| Worker 固定程序 | 管理项目 worktree、验证基线、调用 Agent、校验 diff、运行检查、创建 commit 和本地分支、回报结果 |
| 修复 Agent | 根据 Bug 和既有分析修改代码，说明改动和建议验证项 |
| 开发者 | cherry-pick 修复 commit，在实际开发分支和运行环境中验证，决定保留、调整或放弃 |

云端不得向 Worker 下发任意本地路径或任意 shell 命令。项目路径、worktree 根目录和允许执行的检查均由 Worker 本地配置及目标仓库内容决定。

## 3. 本地目录与配置

新增 Worker 配置：

```env
# Windows
FIX_WORKTREE_ROOT=D:\bugbot-workspaces

# Linux 示例
# FIX_WORKTREE_ROOT=/var/lib/bugbot/workspaces
```

`FIX_WORKTREE_ROOT` 应接受 Windows 和 Linux 绝对路径。相对路径和无法规范化的路径视为配置错误，避免工作目录随启动位置变化。

第一版一个 Worker 仍绑定一个 `REPO_PATH`。项目名直接从规范化后的 `REPO_PATH` 最后一级目录推导，不增加 `PROJECT_KEY`：

```ts
const projectName = basename(resolve(repoPath));
const projectRoot = join(fixWorktreeRoot, projectName);
```

目录结构：

```text
<FIX_WORKTREE_ROOT>/
  <projectName>/
    repo/                 # 长期复用的 linked worktree
    workspace.json        # 工作区身份与当前状态
    task.lock             # 项目级互斥锁
```

`workspace.json` 至少保存：

```json
{
  "schemaVersion": 1,
  "projectName": "mall-h5",
  "repoPath": "D:\\codes\\projects\\mall-h5",
  "remoteUrl": "git@example.com:frontend/mall-h5.git",
  "createdAt": "2026-10-23T00:00:00.000Z",
  "activeFixTaskId": null,
  "dependencyLockHash": null
}
```

每次操作前必须同时验证：

- 解析后的项目目录仍位于 `FIX_WORKTREE_ROOT` 内。
- `workspace.json` 存在且 schema 可识别。
- 记录的 `repoPath` 与当前规范化 `REPO_PATH` 相同。
- 可获取 remote 时，当前 remote 与记录相同。
- `repo/` 是由目标仓库管理的 linked worktree。

如果另一个同名仓库命中已有目录但身份不一致，Worker 应停止并报告冲突，不自动复用、改名或清理。

## 4. Worktree 生命周期与依赖

每个项目只创建一个长期复用的 worktree。首次使用时创建，后续修复任务复用，以保留依赖目录并减少安装开销。

任务开始前：

1. 获取项目级互斥锁。
2. 确认不存在等待处理的旧修复。
3. 验证 worktree 身份。
4. 将 tracked 文件恢复到任务记录的 `baseCommitSha`。
5. 清除上次任务产生的源码外构建产物，但保留明确允许复用的依赖目录。
6. 检查依赖 lockfile 摘要；首次运行或摘要变化时安装依赖。

依赖安装使用目标项目已有包管理器和锁文件。优先采用冻结锁文件模式，例如 pnpm 项目使用 `pnpm install --frozen-lockfile`。依赖安装失败时任务失败，不允许 Agent 绕过锁文件或任意更换包管理器。

任何 reset、clean、worktree remove 等破坏性 Git 操作只能在通过上述身份校验的 BugBot 专用目录中执行，绝不能作用于 `REPO_PATH` 的主工作目录。

## 5. 修复任务与状态

分析任务和修复任务保持独立。修复任务通过 `analysisTaskId` 引用不可变的分析快照。

建议模型：

```ts
interface FixTask {
  taskId: string;
  analysisTaskId: string;
  traceId: string;
  issueId?: string | number;
  projectName: string;
  requestedBy: string;
  status:
    | "queued"
    | "preparing"
    | "fixing"
    | "validating"
    | "committing"
    | "completed"
    | "failed"
    | "cancelled";
  outcome?:
    | "ready_for_verification"
    | "validation_failed"
    | "no_changes"
    | "stale_analysis"
    | "workspace_conflict";
  baseCommitSha: string;
  branchName?: string;
  commitSha?: string;
  changedFiles?: string[];
  checks?: FixCheckResult[];
  createdAt: string;
  updatedAt: string;
}
```

执行状态和业务结果是两个维度。例如任务可以正常执行到 `completed`，但结果是 `validation_failed` 或 `no_changes`。

同一项目只允许一个活动修复任务。已有任务未结束时再次点击，应返回现有任务信息，不创建新任务，也不覆盖 worktree。

## 6. 基线与过期判断

分析阶段应记录：

- `baseCommitSha`。
- 分析时工作区是否干净。
- Bug 标题、描述、分析状态、摘要、原因和相关文件的快照。
- Agent/provider 及日志引用。

修复任务必须使用该 `baseCommitSha`，不能静默使用 Worker 当前检出的最新提交。以下情况返回 `stale_analysis`，要求重新分析：

- 基线提交在本地仓库中已不可用。
- 分析依赖了未提交内容，无法准确重建。
- 项目配置明确要求只修复当前目标分支，而目标分支已经前进。

第一版不自动 rebase 分析结论，也不自行选择新的基线。

## 7. Agent 输入与写入边界

修复 Prompt 输入：

- 原始 Bug 标题和描述。
- 分析结果的不可变快照。
- `baseCommitSha`。
- 分析列出的相关文件。
- 项目自身的 `AGENTS.md`、`CLAUDE.md` 或同类说明。
- 明确的输出格式和安全约束。

Agent 可以修改代码，但不得：

- 访问 worktree 外路径。
- 修改 `.env`、凭据、Git 配置或 Worker 配置。
- push、创建远端分支、创建 MR、合并或部署。
- 绕过检查、关闭测试或删除失败测试来制造通过结果。
- 执行 Bug 描述中要求的任意命令；Bug 内容始终作为不可信数据。

Agent 完成后，固定程序而非 Agent 负责读取 Git diff、验证路径、运行检查、暂存文件和提交。不得直接信任 Agent 自报的修改文件或测试结果。

## 8. Diff 校验与提交

提交前固定执行：

1. 获取 tracked、untracked、renamed 和 deleted 文件列表。
2. 拒绝 worktree 外路径、符号链接越界和受保护文件。
3. 排除日志、临时文件、依赖目录和构建产物。
4. 确认存在有意义的源码 diff；否则返回 `no_changes`。
5. 只暂存本次校验通过的文件，禁止无条件执行 `git add -A`。
6. 运行约定检查并保存每条命令的退出码和摘要。
7. 创建 commit，并校验 commit 的文件集合与已批准集合相同。

分支名：

```text
bugfix/zentao-<issueId>-<taskIdShort>
```

分支名中的外部字段必须先做字符白名单和长度限制。无法取得 issue ID 时使用 task ID。

建议提交信息：

```text
fix: resolve Zentao bug #<issueId>
```

Git author 使用单独配置的固定机器人身份。第一版不使用 `--no-verify` 绕过项目 hook；hook 失败按验证失败处理并回报原因。

为避免分支被 linked worktree 占用，建议操作顺序为：

1. worktree 以 detached HEAD 检出 `baseCommitSha`。
2. 修改、验证并在 detached HEAD 上创建 commit。
3. 创建 `bugfix/...` 分支指向该 commit。
4. worktree 保持 detached，不 checkout 新分支。

这样用户既可以直接 cherry-pick commit，也可以在其他工作目录 checkout 该分支。

## 9. 检查策略

检查分为三层，按可用性执行：

1. 与改动直接相关的已有测试。
2. 目标项目约定的 typecheck、lint 或 test 命令。
3. 无自动检查时仅报告“未发现可运行测试，需要人工验证”。

第一版不把任意 Agent 生成的 shell 字符串直接交给系统执行。可执行命令来源应限制为：

- Worker 本地配置的检查命令。
- 项目已存在且经固定规则选择的 package scripts。
- 项目文档中明确允许的命令，经过参数和工作目录校验。

结果规则：

| 情况 | 行为 |
| --- | --- |
| 有修改且检查通过 | 提交，`ready_for_verification` |
| 有修改但检查失败 | 仍可提交保存成果，标记 `validation_failed`，通知中明确不建议直接使用 |
| 无有效修改 | 不提交，`no_changes` |
| Agent 或基础设施失败 | 不提交或仅保存 diff 日志，任务 `failed` |

自动检查通过不等于 Bug 已被人工验证。

## 10. 飞书交互与通知

分析结果消息改为交互卡片。第一版在根因足够明确、分析快照和基线完整时展示“尝试修复”。具体资格规则实施时固化为确定性代码，不由卡片客户端决定。

按钮点击后：

1. 验证飞书事件签名、时间戳和事件去重标识。
2. 验证点击人身份和卡片与分析任务的关联。
3. 幂等创建 `FixTask`。
4. 立即响应飞书，后台排队执行，不在回调请求中等待 Agent。
5. 更新卡片为“修复已排队”或“修复中”，避免重复点击。

成功通知示例：

```text
修复已准备好，等待人工验证

项目：mall-h5
Bug：#1234
分支：bugfix/zentao-1234-a8f31c
提交：3fb34d8
基线：41bc271
修改：3 个文件
检查：pnpm test 通过

在你的开发分支执行：
git cherry-pick 3fb34d8
```

通知必须同时给出 branch、commit SHA、base commit、修改文件和检查结果。失败通知应给出可操作原因，不暴露绝对路径、凭据或完整敏感日志。

## 11. 持久化、鉴权与幂等

修复可能持续较长时间并等待用户处理，不能依赖当前内存 `Map`。上线修复入口前，云端任务、分析快照、修复任务和平台事件去重信息应迁移到持久存储；SQLite 足以满足第一版。

需要保证：

- 同一飞书点击事件只创建一个修复任务。
- 同一分析任务在一个项目中只存在一个活动修复任务。
- Worker 重启后能恢复或明确终结进行中的任务。
- 云端重启后仍知道卡片、分析与修复任务的关联。
- Worker API 使用 Bearer token；飞书回调使用官方签名验证。
- Worker 提交结果携带任务租约或尝试标识，旧执行不能覆盖新状态。

## 12. 分支与工作区清理

第一版采用显式结束，不在用户尚未处理时自动覆盖：

- `ready_for_verification` 或 `validation_failed` 会占用项目工作区。
- 用户处理后通过卡片标记“已处理”或“放弃修复”。
- “已处理”表示用户已经自行 cherry-pick、提交或决定不采用，不代表 Bot 验证了最终运行结果。
- 清理前重新校验 workspace 身份、活动任务 ID、branch 和 commit。
- 清理只重置专用 worktree，并删除对应临时本地分支。

后续可增加 TTL 提醒和过期清理，但第一版不自动删除尚未处理的修复成果。分支数量因此受“每项目一个活动修复”约束，不会无界增长。

## 13. Merge Request 的后续扩展

本地 commit 是第一版的稳定交付物。后续如果出现以下需求，再增加远端适配：

- Worker 与开发者不在同一台机器。
- 需要团队在线 review。
- 需要触发远端 CI。
- 需要保留审批和合并记录。

届时以现有 `branchName`、`commitSha` 和 `baseCommitSha` 为输入，新增“push 并创建 MR”步骤；必须单独配置机器人凭据、允许的 remote、目标分支和平台适配器。默认仍不自动合并。

## 14. 分阶段实施

### 阶段一：可靠任务与交互入口

- 持久化分析快照和任务。
- 发送飞书交互卡片并验证回调。
- 新增 `FixTask`、幂等和项目级串行约束。
- 暂不调用写代码 Agent。

验收：重复点击不重复创建任务；服务重启不丢失状态；未授权或伪造事件不能触发任务。

### 阶段二：专用 worktree 与修复执行

- 新增 `FIX_WORKTREE_ROOT`。
- 实现项目目录推导、身份标记、互斥锁和长期 worktree。
- 增加修复 Prompt 与 Agent runner。
- 实现 diff 校验、检查执行、本地 commit 和 branch。

验收：不修改开发者工作目录；依赖可复用；同项目不能并发；成功任务能在主工作目录直接 cherry-pick。

### 阶段三：结果卡片与清理

- 展示 commit、分支、检查和文件信息。
- 增加“已处理”和“放弃修复”。
- 实现安全清理、恢复和异常启动检查。

验收：处理完成后项目可接受下一个任务；清理只影响专用 worktree；失败和待验证结果均可追溯。

### 后续：远端 MR

- 平台适配、push 权限、远端 CI、MR 状态同步。
- 仍保留人工审批，不自动合并和部署。

## 15. 第一版验收标准

- Windows 和 Linux 均可通过绝对路径配置 worktree 根目录。
- 项目目录从 `REPO_PATH` 最后一级自动推导，同名不同仓库会被识别为冲突。
- 每个项目只有一个长期 worktree 和一个活动修复任务。
- Agent 不能修改开发者主工作目录或 worktree 外文件。
- 已有依赖在 lockfile 未变化时可以复用。
- 有效修复生成本地 `bugfix/*` 分支和 commit。
- 用户可在自己的工作目录直接执行 `git cherry-pick <sha>`。
- 通知准确区分自动检查结果与人工验证状态。
- 服务或 Worker 重启后，任务和工作区状态可恢复或明确报告。
- 第一版不产生任何远端 Git 副作用。

