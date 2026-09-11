# 可粘贴接入提示词

> [English](README.md) | [简体中文](README.zh-CN.md)

这三份提示词面向**没用过 Git** 的人。把对应一段粘贴给 Claude Code、Codex、Cursor、CodeBuddy、WorkBuddy、OpenCode、Qoder 等已支持的 Agent。Agent 代跑 `teamai init` / `pull` / `push` / `doctor`，只在要网页登录或二选一时问你。

Agent 让你新开会话时，应使用**当前这个**工具的名字，不要默认 Cursor / Claude Code。

| 场景 | 提示词 |
|------|--------|
| 还没有团队仓库 URL | [建库（Getting started）](getting-started.zh-CN.md) |
| 已经拿到仓库 URL | [成员（Member）](member.zh-CN.md) |
| 已经 init，日常维护 | [管理员（Admin）](admin.zh-CN.md) |

建库结束时会交出仓库 URL，以及转发给同事的[成员提示词](member.zh-CN.md)。

不要用 `owner/repo` 短地址（会被当成 GitHub）。不要用 `teamai init .` —— 这三份提示词使用独立团队仓，不覆盖单仓模式。
