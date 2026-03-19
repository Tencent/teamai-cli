# Changelog

## [0.3.14] - 2026-03-19

### Added
- 自动更新功能：新增 `teamai update [--check]` 命令，支持从 tnpm 检查并安装最新版本
  - 24 小时版本检查缓存，避免频繁请求 registry
  - 可配置更新策略：`auto`（自动安装）、`prompt`（提示确认）、`skip`（跳过）
  - PID 文件锁防止并发安装冲突
- Session 结束自动检查更新：`teamai init` 自动注入 Stop/SessionEnd hook，AI 工具会话结束时自动检测新版本

## [0.3.13] - 2026-03-17

### Added
- OpenClaw 支持：skills 和 rules 自动同步到 `~/.openclaw/skills/` 和 `~/.openclaw/rules/` (!57)

### Changed
- Skills sync 改为自动检测已安装工具，不再依赖 `syncTargets` 配置 (!58)
  - 遍历所有 `toolPaths` 并通过 `isToolInstalled` 检测 `~/` 下目录是否存在
  - 新增工具无需修改 `teamai.yaml` 即可自动同步
  - 与 rules sync 行为保持一致

### Fixed
- Cursor skills 路径修正：`.cursor/skills-cursor` → `.cursor/skills` (!56)

## [0.3.12] - 2026-03-12

### Fixed
- `teamai pull` docs 数量显示修复：之前始终显示 "Synced 1 docs"，现在正确显示实际文件数（如 "Synced 2 docs"）
- `teamai status` docs 计数修复：之前用 `listDirs` 统计目录数（结果为 0），改为用 `listFiles` 统计实际文档文件数

## [0.3.11] - 2026-03-12

### Fixed
- 文件系统操作（目录扫描、内容比较、复制、mtime 计算）全局过滤 `__pycache__/`、`.pyc`、`.DS_Store`、`node_modules` 等无关文件，避免 push/pull 时产生误判的"已修改"diff

## [0.3.10] - 2026-03-11

### Added
- Rules 子目录支持：`teamai push`/`pull` 递归扫描 rules 目录，支持按语言/类别组织规则文件（如 `common/`、`python/`、`golang/`）(!52)
- 新增 `listFilesRecursive()` 工具函数用于递归文件遍历
- `teamai push` 默认显示每个资源的源文件路径

### Changed
- CLAUDE.md 引用从逐文件列举改为目录级引用（`~/.claude/rules/`），减少上下文占用
- CLAUDE.md 新增 docs 目录引用（`~/.teamai/docs/`）
- `teamai pull` 日志从 "Merged N rule(s) into CLAUDE.md" 改为 "Synced N rule(s)"

## [0.3.9] - 2026-03-10

### Fixed
- `teamai init --repo group/subgroup/repo` 多级路径支持：`gf repo clone` 不支持三级及以上路径，改为回退到带 OAuth token 的 `git clone`
- `gfCreateRepo` 查找 namespace 时使用 `full_path` 匹配，修复多级 group 下创建仓库 namespace 匹配失败的问题

## [0.3.8] - 2026-03-10

### Added
- `teamai push` skill 推送时自动维护 CONTRIBUTORS 文件，记录每个 skill 的贡献者 (!46)

### Fixed
- `gfGetOAuthToken` 返回用户密码而非 OAuth token (!47)
- OAuth token 改为从 `~/.netrc` 读取，替代不可靠的 `git credential fill` (!48)
- 修正 OAuth token 相关的误导性注释 (!49)
- `gf mr create` MR title/description 使用 shell 单引号，修复换行符丢失问题 (!50)
- 支持多级 group 路径的仓库 URL 解析（如 `group/subgroup/repo`）(!42)

### Changed
- 简化 README，按角色（管理员/成员）分离快速上手指南 (!43, !45)

## [0.3.7] - 2026-03-09

### Fixed
- `gf mr create` 创建 MR 时 PushNotFastForward 错误：`pushRepoBranch` 在 push 后切回 master，导致 gf 内部 push HEAD 时分支不匹配。现在保持 HEAD 在 source branch 直到 MR 创建完成

## [0.3.6] - 2026-03-09

### Fixed
- `teamai remove` 创建 MR 失败（"remote not found"）：`gfMrCreate` 调用缺少 `cwd` 参数，导致 gf CLI 在错误目录下执行

## [0.3.5] - 2026-03-09

### Fixed
- `teamai members` 读取前先 `git pull`，确保能看到远程新注册的成员
- `teamai init` 已配置 reviewer 的团队仓库，新成员加入时不再重复提示配置 reviewer

## [0.3.3] - 2026-03-09

### Fixed
- `teamai init` 新成员注册 push 失败：当团队仓库中缺少某些 `.gitkeep` 文件时，`git add` 报错导致整个 push 失败，成员注册信息无法推送到远程 (!36)

## [0.3.2] - 2026-03-09

### Added
- `teamai push`/`teamai status` 检测本地已修改的 rules，在差异扫描中标记 modified 状态 (!31)
- 新增 `src/utils/fs.ts` 文件内容比对工具函数，支持跨工具目录的内容一致性检查
- 新增 `fs-compare.test.ts`、`rules.test.ts`、`skills.test.ts`、`skip-uninstalled-tools.test.ts` 测试文件

### Fixed
- `teamai pull` 跳过未安装的 AI 工具，不再向不存在的工具目录同步资源 (!34)
- `teamai push` 扫描改为跨所有工具目录比对内容，修复时间戳比较的 timing bug (!33)
- `teamai doctor` 不再误报 Cursor hook 缺失 (!32)

### Changed
- 项目名称由 "Team AI DevKit" 更名为 "团队 AI 经验共享框架 TeamAI" (!35)

## [0.3.1] - 2026-03-08

### Added
- `teamai pull` env 变量注入改为 source 文件引用方式，避免直接修改 shell profile (!30)
- env push 改为 deferred 模式，减少不必要的 MR 创建

## [0.3.0] - 2026-03-08

### Changed
- **重构资源类型**：移除 hooks 和 instincts 资源类型，简化架构 (!26)

### Fixed
- `teamai init` 处理不存在和空仓库的场景 (!27)
- `teamai init` clone path 修复及误判仓库不存在的问题 (!28)

### Removed
- 删除 `teamai sync` 命令（不安全的双向同步） (!29)
- 删除 `src/resources/hooks-config.ts` 和 `src/resources/instincts.ts`

## [0.2.4] - 2026-03-08

### Removed
- 删除 `teamai sync` 命令：该命令在 pull 阶段会无提示覆盖本地修改，存在数据丢失风险。请分别使用 `teamai push` 和 `teamai pull`

## [0.2.3] - 2026-03-08

### Fixed
- `teamai init` clone path 不再交互确认，直接使用默认路径 `~/.teamai/team-repo`
- 修复仓库存在却误判为"不存在"的问题：git 对象统计中的 `reused 404` 被误匹配为 HTTP 404

## [0.2.2] - 2026-03-07

### Fixed
- `teamai init` 不存在的远程仓库自动创建：检测到仓库不存在时询问用户确认，通过 TGit API 自动创建
- `teamai init` 空仓库克隆兜底：克隆空仓库后目录不存在时，自动 `git init` + 配置 remote
- `pushRepoDirectly` 首次 push 设置 upstream (`git push -u origin <branch>`)，兼容 main/master 等分支名

### Added
- `gfGetOAuthToken()` 从 git credential store 提取 OAuth token
- `gfCreateRepo()` 通过 TGit REST API (Bearer auth) 创建远程仓库
- `RepoNotFoundError` 错误类型，区分"仓库不存在"和其他克隆错误
- `initRepo()` 本地 git 初始化 + 添加 remote 的工具函数
- `init.test.ts` 覆盖空仓库兜底、自动创建、用户拒绝、创建失败等场景

## [0.2.1] - 2026-03-07

### Fixed
- 修复 gf CLI 下载地址错误：改为从 `mirrors.tencent.com` 官方源下载
- 修复平台架构名称：x64/arm64（之前误用 amd64）

## [0.2.0] - 2026-03-07

### Changed
- **认证方式改造**：使用工蜂 CLI (`gf`) 替代手动 Private Token 配置
  - `teamai init` 自动安装 gf CLI 到 `~/.teamai/gf/`（无需 sudo）
  - 通过 `gf auth login` 交互式 OAuth 登录（支持 iOA、浏览器设备码、手动 Token）
  - 不再需要手动获取和配置 `TGIT_TOKEN`
- **Clone 方式改造**：使用 `gf repo clone` 替代 simple-git clone
  - gf clone 自动将 OAuth token 嵌入 remote URL，后续 git pull/push 无需额外认证
- **MR 创建改造**：使用 `gf mr create` 替代 TGit v3 REST API
  - reviewer 直接传 username，不再需要查询 user ID
  - 影响 `teamai push`、`teamai remove`、`teamai env add/remove`

### Removed
- 删除 `src/utils/tgit-api.ts`（TGit v3 REST API 客户端）及其测试文件
- 不再需要 `TGIT_TOKEN` 环境变量
- 移除手动 token 配置流程（`askSecret`、`openBrowser`、`saveTokenToEnvFile`）
- 移除 `resolveRepo` 预检查（`getProject`、`isRepoEmpty`、`fileExistsInRepo`）

### Added
- 新增 `src/utils/gf-cli.ts`：gf CLI 安装、认证、clone、MR 创建的完整封装
- `teamai doctor` 新增 gf CLI 安装和认证状态检查

## [0.1.14] - 2026-03-06

### Added
- 团队环境变量同步：新增 `env` 资源类型，支持从团队仓库 `env/env.yaml` 同步环境变量到成员的 shell 配置文件 (!23)
- `teamai env list` — 列出团队环境变量
- `teamai env add <key> <value>` — 添加/更新环境变量（通过 branch + MR 流程）
- `teamai env remove <key>` — 删除环境变量（通过 branch + MR 流程）
- `teamai pull` 自动将 env 变量注入 ~/.bashrc 或 ~/.zshrc，使用标记注释 `[teamai:env:start/end]` 实现幂等更新
- `teamai pull` 同时写入 `~/.teamai/env` 作为 KEY=VALUE 格式备份
- `teamai status` 显示 env 变量计数，`teamai list env` 显示变量详情
- `teamai doctor` 新增 shell profile env 注入检查项
- `teamai init` 创建 `env/` 目录，默认配置含 `env: { injectShellProfile: true }`
- 支持 `sharing.env.shellProfilePath` 自定义注入路径，`sharing.env.injectShellProfile: false` 禁用注入

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
