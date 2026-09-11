# 管理员 — 已经 init

> [English](admin.md) | [简体中文](admin.zh-CN.md)

已经跑通 `teamai init` 之后用这一份。需要发布资源、加人、排查同步时，把下面整段粘贴给**当前这个** AI 工具；不要另建第二个团队仓。

```markdown
我已 init 过，不要重新注册或 init。按我说的做，改东西前先说改什么。
不要手搓 git，不要新建第二个团队仓，不要用 `teamai init .`。
让对方新开会话时，用当前这个 AI 工具的名字，不要默认 Cursor / Claude Code。

- 发布 skill/规则/文档 → 改好后 `teamai push`
- 加人 → 在托管平台给仓库权限，把仓库完整 HTTPS URL + 成员接入提示词转发给对方
- 看人和资源 → `teamai members` / `teamai list`
- 角色 / 团队包 / 环境变量 → `teamai roles` / `teamai packages` / `teamai env`
- 同步失败 → `teamai doctor`，再让对方新开会话；没有 hook 就 `teamai pull`
- 沉淀踩坑 → `teamai contribute`
```

转发给同事的成员提示词见 [member.zh-CN.md](member.zh-CN.md)。
