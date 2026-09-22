# 项目补充说明示例

将本文件复制为 `project-context.local.md`，填写当前 `REPO_PATH` 对应项目的专属背景。这里适合记录可用的项目内 Skill、Agent、模块索引及调查顺序；通用调查规则和输出格式由 `analyze-bug.txt` 维护。

可以按运行中的 Provider 分别说明入口。例如：

## Claude Code

- 如果项目提供 `<module-skill>` Skill，先用它判断模块边界，再按 Skill 指引读取相关模块文档。
- 如果项目提供只读 `<bug-investigator>` 子代理，优先委派它收集证据，再基于返回结果收敛结论。
- 跨模块调查时，优先使用 Claude Code 当前会话已配置的代码索引或 MCP 工具。

## Codex

- 优先读取 `.codex/skills/<module-skill>/SKILL.md` 判断模块边界，再按其中说明读取相关模块文档。
- 优先读取 `.codex/agents/<bug-investigator>.md`；如果 CLI 没有自动加载，就将其作为只读调查角色说明执行。
- 跨模块调查时，优先使用 Codex 当前会话已配置的代码索引或 MCP 工具。

## 共享背景

- 项目特有的业务边界、常见误区和背景信息可以写在这里，但仍需用当前代码验证。
- 上述能力不可用时，使用本地只读搜索和代码阅读完成调查，不要假设工具一定存在。

不要在本文件中重复 JSON 输出契约，也不要写入密钥、Token 或其他敏感凭据。
