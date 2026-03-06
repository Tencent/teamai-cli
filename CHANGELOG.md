# Changelog

## [0.1.13] - 2026-03-06

### Added
- `teamai pull` 输出详情：显示 skills/instincts 的新增/更新数量（如 `3 new, 29 updated`），hooks 显示实际条目数 (!20)
- TGit API `fileExistsInRepo` 辅助函数：检查远程仓库文件是否存在 (!18)

### Fixed
- `teamai --version` 从 `package.json` 动态读取版本号，不再硬编码（修复 0.1.12 版本号不一致问题）
- 修复 MR 创建时 `web_url` 返回 undefined 及 reviewer 未设置的问题（TGit v3 API 兼容） (!17)
- `teamai init` 对已有 teamai 仓库/已注册成员跳过多余确认提示 (!18, !19)
- `teamai init` 使用 `default_branch` 替代硬编码 `master` 检查远程文件 (!19)
- Session start hook 去掉 `--silent`，新会话启动时可见 pull 输出；`teamai init` 自动更新旧版 hook command (!20)
- `teamai pull` docs 目录只有 `.gitkeep` 时跳过同步，复制时过滤 dot 文件 (!20)

## [0.1.11] - 2026-03-05

### Added
- CodeBuddy IDE 支持：hooks/skills/rules 同步覆盖 CodeBuddy 工具目录 (!15)
- 分支 + MR 工作流：`teamai push` 改为创建独立分支并自动创建 Merge Request，支持 reviewer 审批 (!14)
- Tombstone 机制：已删除的资源不会被 `teamai push` 重新推送 (!12)

### Changed
- 简化成员管理：移除 readonly/write 角色系统，所有成员统一权限 (!13)

## [0.1.9] - 2026-03-05

### Added
- `teamai remove <type> <name>` 命令：从团队仓库和本地删除 skills/rules 资源 (!10)
- Cursor hooks 支持：`teamai init` 自动注入 `.cursor/hooks.json` 格式的 SessionStart hook (!9)

### Fixed
- 文档与代码对齐 (!11)

## [0.1.7] - 2026-03-05

### Added
- `teamai push` 支持推送 rules 到团队仓库 (!6)
- 成员角色管理：支持 readonly/write 角色区分 (!5)
- `teamai init --repo` 支持短格式 `owner/repo` (!1)

### Changed
- Rules 分发改为独立文件同步到各工具 rules 目录，不再内联到 CLAUDE.md (!7)

### Fixed
- `teamai init` 自动配置 git user (!4)
- TGIT_TOKEN 获取链接更新为 `/profile/account` (!2)

## [0.1.0] - 2026-03-03

### Added
- 初始发布
- `teamai init` — 初始化团队仓库关联、注册成员、注入 SessionStart hooks
- `teamai push` — 推送本地 skills 到团队仓库
- `teamai pull` — 拉取团队资源（skills、rules、hooks、docs）到本地 AI 工具目录
- `teamai sync` — 双向同步（push + pull）
- `teamai status` — 查看本地与团队仓库的差异
- `teamai list` — 列出团队资源
- `teamai members` — 列出团队成员
- `teamai doctor` — 诊断配置问题
- 支持 Claude Code、Codex、Claude Code Internal、Cursor 四种 AI 工具
- SessionStart hook 自动拉取团队最新内容
