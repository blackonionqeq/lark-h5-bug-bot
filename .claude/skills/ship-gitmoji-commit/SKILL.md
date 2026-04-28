---
name: ship-gitmoji-commit
description: Summarize staged git changes, propose a gitmoji-style commit message for user confirmation, then commit and push the current branch after approval. Use this only when the user explicitly wants a manual slash command to review staged changes and then ship them.
disable-model-invocation: true
allowed-tools: [Bash]
---

# Ship Gitmoji Commit

Use this skill only when the user manually invokes `/ship-gitmoji-commit`.

## Goal

Turn the current **staged** git changes into a concise gitmoji-style commit proposal, ask the user to confirm it, and only after confirmation:

1. create the git commit
2. push the current branch to its tracked remote

This skill is intentionally manual because it has side effects.

## Workflow

1. Inspect **staged changes only**.
   - Run git status to confirm staged files.
   - Run git diff --cached to inspect what will be committed.
   - Run recent git log entries to match the repository's commit style if useful.

2. Draft a commit proposal.
   - Summarize the staged changes in 1-3 short bullets.
   - Propose **one** gitmoji commit message.
   - Keep it concise and specific to the staged diff.
   - Prefer the repository's existing style when obvious.

3. Ask for confirmation before doing anything irreversible.
   - Show the summary and proposed commit message.
   - Ask the user to confirm, or provide an edited message.
   - Do not commit or push until the user clearly approves.

4. After approval, commit the staged changes.
   - Commit only what is already staged.
   - Use the approved message exactly.
   - Pass the message via HEREDOC so formatting is preserved.

5. Push the current branch.
   - Push only after the commit succeeds.
   - Push the current branch to its configured upstream.
   - If no upstream exists, explain the issue and show the exact push command you need approval to run.

6. Report the result briefly.
   - Share the final commit message.
   - Confirm the branch was pushed, or explain the blocker.

## Output format before confirmation

Use this structure:

```markdown
已暂存改动摘要：
- ...
- ...

建议 commit message：
`<gitmoji message>`

回复”确认”即可提交并 push；如果你想改文案，直接发我新的 commit message。
（如果 --no-push 生效，改为：回复”确认”即可提交（不 push）；如果你想改文案，直接发我新的 commit message。）
```

## Commit message guidance

- Start with one gitmoji.
- Then a short Chinese message unless the repo clearly uses another style for the touched area.
- Focus on why/useful intent, not low-level file operations.
- Avoid inventing scope labels unless the repo already uses them consistently.

## Common gitmoji reference

Prefer the closest match from this list:

- ✨ New feature or capability
- 🐛 Bug fix
- 🚑️ Hotfix for urgent production-impacting issue
- ♻️ Refactor without changing intended behavior
- ⚡️ Performance improvement
- 💄 UI or style adjustment
- 📝 Documentation update
- ✅ Test added or updated
- 🔧 Configuration change
- ⬆️ Dependency upgrade
- ⬇️ Dependency downgrade
- 🔒️ Security fix
- 🌐 i18n or translation change
- 🚚 Rename or move files/modules
- 🔥 Remove dead code or unused files
- 🏷️ Type fix or type declaration adjustment

If more than one gitmoji fits, choose the one that best explains **why the change matters**, not the file operation itself.

## Safety rules

- Never include unstaged changes in the commit.
- Never create an empty commit.
- Never use `--amend`, `--force`, `--no-verify`, or other bypass flags unless the user explicitly asks.
- If pre-commit hooks fail, stop and show the failure. Do not bypass hooks.
- If there are no staged changes, tell the user and stop.

## Arguments

`$ARGUMENTS` supports the following:

- `--no-push`：只 commit，不 push。传入后跳过 workflow 第 5 步（push），确认提示也相应调整。
- 其余非 flag 文本视为用户提供的 commit message 草稿，仍需确认后才提交。

解析规则：从 `$ARGUMENTS` 中提取 `--no-push` flag，剩余文本（去掉 flag 后 trim）作为 commit message 草稿。如果草稿为空则正常走 draft 流程。

当 `--no-push` 生效时：
- 确认提示改为：`回复"确认"即可提交（不 push）；如果你想改文案，直接发我新的 commit message。`
- 完成后只报告 commit 结果，不执行 push。

## Notes

- 如果 `$ARGUMENTS` 去掉 flags 后为空，按正常 draft 流程提议 commit message。
- 如果去掉 flags 后有非空文本，将其作为用户偏好的 commit message 草稿，但仍需确认。
