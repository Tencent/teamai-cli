# 可粘贴接入提示词

> [English](README.md) | [简体中文](README.zh-CN.md)

这三份提示词面向**没用过 Git** 的人。从对应文件里复制围栏中的整段，粘贴给 Claude Code、Codex、Cursor、CodeBuddy、WorkBuddy、OpenCode、Qoder 等已支持的 Agent。Agent 代跑命令，只在要网页登录或二选一时问你。

Agent 让你新开会话时，应使用**当前这个**工具的名字。

| 场景 | 提示词 |
|------|--------|
| 还没有团队仓库 URL | [建库（Getting started）](getting-started.zh-CN.md) |
| 已经拿到仓库 URL | [成员（Member）](member.zh-CN.md) |
| 已经 init，日常维护 | [管理员（Admin）](admin.zh-CN.md) |

建库结束时会交出仓库 URL，以及给同事的接入话（提示词 B 的短版）。转发明细见[成员提示词](member.zh-CN.md)。

围栏里的提示词只复用 `init` / `pull` / `push` / `doctor`（管理员日常另有 `members` / `list` / `roles` / `packages` / `env` / `contribute`）。不教 Git，不用 `owner/repo` 短地址，不按地区推荐平台，也不覆盖单仓模式（`teamai init .`）。
