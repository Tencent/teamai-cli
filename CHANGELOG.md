# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [0.9.1](https://git.woa.com/teamai/teamai-cli/compare/v0.9.0...v0.9.1) (2026-03-30)

### 🔧 修复 debug.log 始终为空的问题

`~/.teamai/debug.log` 现在能正确记录所有 hook 运行时的调试和错误信息，方便排查 teamai 后台行为。

#### 问题根因

Hook 命令通过 `2>>~/.teamai/debug.log` 捕获 stderr，但代码中所有日志（包括错误）都写到 stdout（`console.log`），且 `--verbose` 默认关闭——三重静默导致 debug.log 永远为空。

#### 修复方案

- **File Transport**：所有 `log.debug()` 和 `log.error()` 调用现在同时写入 `~/.teamai/debug.log`，不再依赖 shell 的 stderr 重定向
- **ISO 时间戳**：每行日志带 `2026-03-30T06:32:14.123Z [DEBUG]` 格式前缀
- **错误级别拆分**：catch 块中的失败信息从 `log.debug` 改为 `log.error`，方便 `grep ERROR ~/.teamai/debug.log` 快速定位问题
- **自动 Rotation**：debug.log 超过 5MB 自动轮转为 `debug.log.1`，总占用不超过 10MB
- **同步写入**：使用 `appendFileSync` 确保短命 hook 进程不丢日志

#### 使用方式

```bash
# 查看最近的调试日志
tail -20 ~/.teamai/debug.log

# 快速找错误
grep ERROR ~/.teamai/debug.log
```

---

## [0.9.0](https://git.woa.com/teamai/teamai-cli/compare/v0.8.1...v0.9.0) (2026-03-29)

### 🔌 内置规则自动部署 — AI 工具零配置接入团队知识库

`teamai pull` 现在会自动将 CLI 内置的 AI 规则（rules）部署到所有已安装的 AI 工具目录中，**团队成员无需手动配置**，pull 一次即可让 Claude Code / Cursor 等工具自动搜索团队知识库。

#### 工作原理

1. `teamai pull` 执行时，自动检测已安装的 AI 工具（Claude Code、Cursor 等）
2. 将内置规则写入各工具的 `rules/` 目录：
   - `~/.claude/rules/teamai-recall.md`
   - `~/.claude-internal/rules/teamai-recall.md`
   - `~/.cursor/rules/teamai-recall.md`
3. 规则内容随 CLI 版本更新，每次 pull 自动同步最新版本

#### 首个内置规则：`teamai-recall`

该规则指导 AI 在遇到错误、部署问题或不熟悉的模式时，**先搜索团队知识库**再从零开始解决：

```bash
teamai recall "API timeout retry"
teamai recall "K8s OOM pod restart"
```

#### 设计要点

- **零配置** — pull 即生效，团队成员不需要手动复制规则文件
- **跳过未安装工具** — 自动检测，只部署到已安装的 AI 工具
- **与团队规则隔离** — `teamai push` 不会误将内置规则推送到团队仓库
- **可扩展** — 后续可轻松添加更多内置规则

#### 完善知识飞轮闭环

```
contribute(写入) → pull(同步+索引+部署规则) → AI 自动 recall(搜索) → upvote(投票)
                                    ↑ NEW
```

## [0.8.1](https://git.woa.com/teamai/teamai-cli/compare/v0.8.0...v0.8.1) (2026-03-28)

### Digest 隐私改进 + Skill 动态展示

#### 隐私改进

* **移除 digest 中的个人可推断信息** — `(142 uses by 3 member(s))` → `(142 uses)`，小团队中不再能反推谁用了什么
* **移除 skill 推荐中的百分比** — `used by 57% of team` → `popular with your team`，同理保护隐私

#### 新功能

* **Digest 新增 Skill 动态** — `teamai digest` 现在展示近 7 天新增和更新的 Skill
  - 🆕 New Skills This Week — 新创建的 skill，显示作者
  - 🔄 Recently Updated Skills — 有内容更新的 skill
  - 数据来源：team repo 的 git log，零额外配置

#### 示例

```
🆕 New Skills This Week:
  • hai-gpu-sold-report (by jeffyxu)
  • hai-prod-db (by keitewang)

🔄 Recently Updated Skills:
  • tke-deploy
  • hai-deploy-quick
  • tapd-tech-design
```

## [0.8.0](https://git.woa.com/teamai/teamai-cli/compare/v0.7.1...v0.8.0) (2026-03-28)

### 🧠 Git-Native Memory — 团队知识回忆系统

借鉴 [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight) 的 retain/recall 记忆模型，为 teamai 补全知识飞轮的"读出路径"。之前通过 `/teamai-share-learnings` 贡献的经验文档写了没人看，现在 AI 可以通过 `teamai recall` 自动搜索和引用。

**知识飞轮闭环：** `contribute(写入) → pull(同步+索引) → recall(搜索) → upvote(投票) → 排序优化`

#### 新功能

* **`teamai recall <query>`** — 搜索团队知识库，返回按相关性排名的结果 ([!81](https://git.woa.com/teamai/teamai-cli/-/merge_requests/81))
* **Pull 自动同步 learnings** — `teamai pull` 现在会同步 `learnings/` 目录到本地，并自动重建搜索索引
* **Hybrid 中英文搜索** — Intl.Segmenter 拆分英文词 + CJK bigrams 捕捉中文复合词（如"超时""排查"），解决纯 Segmenter 把中文拆成单字的问题
* **搜索自动投票** — recall 返回结果时自动为文档投票（`votes/<user>.yaml`），好文档随时间自然浮到顶部
* **Frontmatter 标准化** — SKILL.md 模板要求 AI 生成的文档包含 `title/author/date/tags` YAML frontmatter，提升搜索精准度

#### 搜索评分规则

| 匹配类型 | 分值 | 说明 |
|----------|------|------|
| 标题命中 | ×3 | frontmatter title 中的词匹配 |
| 标签命中 | ×2 | frontmatter tags 中的词匹配 |
| 正文命中 | ×1 | 文档正文（前 2000 字）中的词匹配 |
| 投票加分 | +0.5/票 | 每票 +0.5，上限 5 分 |

#### 示例

```bash
$ teamai recall "fuse 端口"
--- [teamai:recall:start] --- (1 result)

[1/1] MR 审查发现 FUSE 端口冲突 Bug 及 UpdateInferService 接口测试验证 ★1
Author: jeffyxu | Date: 2026-03-28 | Score: 18.5
Tags: troubleshooting, code-review, tdd, hai_flow, fuse, k8s
File: ~/.teamai/learnings/mr审查发现fuse端口冲突bug及...md

--- [teamai:recall:end] ---
```

#### 技术细节

| 文件 | 说明 |
|------|------|
| `src/utils/search-index.ts` | 搜索引擎核心：hybrid tokenize, buildIndex, loadIndex, search |
| `src/recall.ts` | recall CLI 命令 + autoUpvote |
| `src/types.ts` | LearningDoc, SearchIndex, UserVotes 类型 |
| `src/pull.ts` | learnings 同步 + 索引重建（内联实现，不继承 ResourceHandler） |
| `src/team-push.ts` | auto-report 扩展：投票数据随 pull 捎带推送 |

**测试：** 29 个新测试，全量 444 通过。
**设计文档：** `docs/designs/git-native-memory.md`

## [0.7.1](https://git.woa.com/teamai/teamai-cli/compare/v0.7.0...v0.7.1) (2026-03-28)

### 改进 contribute 经验分享系统

**目录重命名：** `ai-docs/` → `learnings/`，语义更清晰。

**smartScore 评分修复：** 之前的评分逻辑导致提醒从未触发（13 个 session，0 个达标）。
- 新增 toolCount 梯度维度（30→10, 50→15, 80+→20，max 20 分）
- Skill/Error 权重从 25 分降至 15 分（大多数有价值 session 不一定用到）
- 阈值从 60 降至 35
- 真实数据验证：7 个历史 session 中 6 个可触发（之前 0 个）

**文件名格式：** `data-<slug>-<random>.md` → `<slug>-<date>-<random>.md`，加入日期便于辨识。

**中文文档模板：** SKILL.md 改为中文模板，AI 生成的经验文档默认中文撰写。

**测试：** 新增 2 个测试用例（toolCount gradient + 典型 session 集成），全量 12 个 contribute-check 测试通过。

## [0.7.0](https://git.woa.com/teamai/teamai-cli/compare/v0.6.2...v0.7.0) (2026-03-28)

### 🚀 `teamai hooks` 子命令 + update 钩子刷新修复

CLI 升级后新钩子永远无法自动注入的 bug 终于修复。根因：`update.ts` 在 `npm install -g` 后直接调用内存中的 `injectHooksToAllTools()`，但 Node.js 进程仍加载旧版代码，新版代码在磁盘上却不会被重新加载。

**新命令：**
- `teamai hooks inject` — 将 teamai 钩子注入所有 AI 工具的 settings 文件（支持 `--silent` 静默模式）
- `teamai hooks remove` — 从所有 AI 工具的 settings 文件中移除 teamai 钩子

**Bug Fix：**
- `teamai update` 安装新版后，改为 spawn `teamai hooks inject --silent` 子进程，确保加载磁盘上的新版代码，而非旧进程内存中的过时代码

**Doctor 增强：**
- `teamai doctor` 钩子检查从只检查 `pull` / description prefix 改为校验全部 6 个子命令（pull, update, track, track-slash, dashboard-report, contribute-check）
- 缺失子命令时建议运行 `teamai hooks inject`

**新 CLI 命令：**
| Command | Description |
|---------|-------------|
| `teamai hooks inject` | 注入 teamai 钩子到所有 AI 工具 settings |
| `teamai hooks remove` | 移除所有 AI 工具 settings 中的 teamai 钩子 |

**测试：**
- 新增 11 个测试用例（hooks-cmd 7 + doctor 4），全量 413 测试通过

**For Existing Users：**
无需手动操作。下次 `teamai update` 时新版代码会正确刷新钩子。如需手动修复，运行 `teamai hooks inject`。

### [0.6.2](https://git.woa.com/teamai/teamai-cli/compare/v0.6.1...v0.6.2) (2026-03-27)


### Improvements

* **contribute-check**: rename `hinted` → `evaluated`, add `smartScore` field ([!78](https://git.woa.com/teamai/teamai-cli/-/merge_requests/78))
  - `hinted` 语义不准确（实际含义是"已评估"而非"已提示用户"），重命名为 `evaluated`
  - 新增 `smartScore` 字段，持久化评估分数便于排查 session 为何未触发 hint
  - `readContributeState` 向后兼容旧格式，自动迁移 `hinted` → `evaluated`
  - Cursor 端补上遗漏的 `contribute-check` hook

### [0.6.1](https://git.woa.com/teamai/teamai-cli/compare/v0.6.0...v0.6.1) (2026-03-27)


### Bug Fixes

* **contribute-check**: per-session state files to prevent multi-window overwrite ([!77](https://git.woa.com/teamai/teamai-cli/-/merge_requests/77))
  - `contribute-state.json` 单文件被多窗口互相覆盖，toolCount 反复归零
  - 改为 `~/.teamai/sessions/{sessionId}.json`，每个 session 独立文件，零竞争
  - 写入时自动清理超过 24h 的旧 session 文件
  - `CONTRIBUTE_BASE_THRESHOLD` 从 100 降到 50，匹配实际 session 工具调用分布

## [0.6.0](https://git.woa.com/teamai/teamai-cli/compare/v0.5.2...v0.6.0) (2026-03-27)

### 🚀 Session 经验自动分享

AI coding session 中使用超过 100 次工具调用时，系统智能评估 session 价值并提示用户分享经验给团队。

**工作原理：**

```
AI coding session
    │
    ▼  PostToolUse hook 每次工具调用自动计数（~1ms）
    │
    ├─ < 100 次 → 静默计数
    │
    ▼  达到 100 次 → 智能评分
    │
    ├─ 分数不够（只是重复调用同一个工具）→ 不打扰
    │
    ▼  分数达标（工具多样、用了 skill、有错误重试、session 够长）
    │
    AI 提示："本次 session 内容丰富，建议运行 /teamai-share-learnings 分享经验"
    │
    ▼  用户同意 → AI sub-agent 生成摘要 → push 到团队仓库 ai-docs/
```

**新命令：**
- `teamai contribute --file <path> --title <title>` — 将经验文档推送到团队仓库 `ai-docs/` 目录
- `teamai contribute-check --stdin` — hook 内部使用，智能阈值检测

**内置 Skill：**
- `/teamai-share-learnings` — AI sub-agent 总结 session 经验并推送到团队仓库
- 随 `teamai pull/init` 自动部署到本地，CLI 升级时 skill 内容跟着更新
- `teamai push` 自动排除内置 skill，不会推到团队 repo

**智能评分机制：**
- 工具多样性（用了多少种不同工具）— 最高 30 分
- Skill 使用（触发了复杂工作流）— 25 分
- 错误和重试（踩坑经验更有价值）— 25 分
- Session 时长（> 30 分钟）— 20 分
- 总分 ≥ 60 才触发提示

**性能设计：**
- 两层检测：前 99 次只读写小 JSON state 文件（~1ms），不读 events.jsonl
- 达到 100 次时一次性读取 events.jsonl 做智能评估
- 每个 session 最多提示一次（去重），用户可忽略

**技术细节：**
- 新增 `contribute-check.ts`（阈值检测 + STDOUT hint）、`contribute.ts`（push 命令）、`builtin-skills.ts`（内置 skill 自动部署）
- 修改 `hooks.ts`（新增 PostToolUse contribute-check hook）、`pull.ts`/`init.ts`（内置 skill 部署）
- 15 个新单测 + 更新现有 hooks 测试

### [0.5.2](https://git.woa.com/teamai/teamai-cli/compare/v0.5.1...v0.5.2) (2026-03-26)

### Bug Fixes

* clean up stale local rule files during pull (merge request !71) ([30a4662](https://git.woa.com/teamai/teamai-cli/commit/30a466271394b2a7b2ca3d229aada3ea8cb57f17))
  - `teamai pull` 现在会自动清理本地已从 team repo 删除的 rule 文件
  - 之前从 team repo 删除 rule 后，本地 `~/.claude/rules/` 等目录会残留过期副本
  - 清理逻辑：对比本地 `.md` 文件与 team repo，删除上游已不存在的文件
  - 自动清理删除后留下的空子目录
  - 仅影响 `.md` 文件，其他文件类型不受影响
  - 新增 5 个测试用例覆盖各种清理场景

## [0.5.1](https://git.woa.com/teamai/teamai-cli/compare/v0.5.0...v0.5.1) (2026-03-25)

### Bug Fixes

* skip tracking slash commands for non-existent skills (merge request !70) ([8eb2778](https://git.woa.com/teamai/teamai-cli/commit/8eb2778))
  - 输入 `/data` 等不存在的 skill 不再被计入 `teamai stats` 统计
  - 新增 `skillExistsOnDisk()` 检查，验证 SKILL.md 存在后才记录
  - 仅影响 slash command 路径，Skill tool 调用不受影响

## [0.5.0](https://git.woa.com/teamai/teamai-cli/compare/v0.4.5...v0.5.0) (2026-03-25)

### 🚀 AI Coding Session Dashboard (Phase 1)

新增 `teamai dashboard` 命令，在浏览器中实时展示所有 AI coding session 的状态。解决多窗口 Alt+Tab 切换的痛点。

**新命令：**
- `teamai dashboard` — 启动本地 Web UI（默认 localhost:3721），展示 session 状态卡片
- `teamai dashboard -p <port>` — 自定义端口
- `teamai dashboard-report --stdin --tool <name>` — hook 内部使用，上报 session 事件

**Dashboard 功能：**
- 🟢🟡🔴⚪ 状态灯：running / waiting / error / idle
- Session 卡片展示：工作目录 (cwd)、首个 prompt 摘要、最后使用工具、活动时间
- SSE 实时推送，延迟 < 3 秒
- Session 识别：session_id 优先 + PID+cwd fallback
- 自动清理：Stop hook + 5 分钟 idle 超时 + 30 分钟移除
- JSONL 事件日志 + 超过 10,000 行自动 compact
- 暗色主题 Web UI，零新依赖（Node.js 内置 http 模块）

**Hook 变更：**
- 新增 4 个独立 dashboard hooks（SessionStart / PostToolUse / UserPromptSubmit / Stop）
- 与现有 usage tracking hooks 完全解耦，可独立开关

### Features

* add AI coding session dashboard (Phase 1) (merge request !69) ([25308dd](https://git.woa.com/teamai/teamai-cli/commit/25308dd08a32ed52a3a43aa661475c0e6893c0ea))


### Bug Fixes

* cleanup all teamai hooks (including outdated descriptions) before re-inject ([8352449](https://git.woa.com/teamai/teamai-cli/commit/8352449fed58398a008440cd80b9760602431bf7))
* usage tracking tool field + auto hook cleanup (merge request !68) ([3086278](https://git.woa.com/teamai/teamai-cli/commit/30862780f86e883de5bd74c710e94ab502b8cf16))
* usage tracking tool field correctly identifies each AI tool (merge request !67) ([dfd51ca](https://git.woa.com/teamai/teamai-cli/commit/dfd51ca197729b14eea5e9977f37114f02c04c42))

## [0.4.7] - 2026-03-24

### Fixed
- **彻底清理重复 hooks**：`cleanupLegacyHooks` 现在清理所有命令含 teamai 的条目（无论有无 description），修复了 description 关键词改名（如 "Check for updates" → "Auto-update"）导致的重复问题

### Tests
- 新增过时 description 清理测试，全量 340 测试通过

## [0.4.6] - 2026-03-24

### Fixed
- **Usage tracking `tool` 字段归因修复**：hook 命令从 `teamai track --stdin` 改为 `teamai track --stdin --tool <name>`，每个工具的 settings.json 注入各自标识（claude / claude-internal / codebuddy 等），usage 数据不再全部记为 `'claude'`
- **清理遗留重复 hooks**：早期版本注入的 hook 无 `description` 字段导致重复堆积，新增 `cleanupLegacyHooks()` 在注入前自动清理，非 teamai hook（如 continuous-learning）不受影响

### Added
- **Update 后自动刷新 hooks**：`teamai update` 成功安装新版后自动调用 `injectHooksToAllTools()`，老用户无需重新 `teamai init`，未初始化则静默跳过
- `track` / `track-slash` CLI 命令新增 `--tool <name>` option，缺省默认 `'claude'`（向后兼容）

### Tests
- 新增 17 个测试：--tool 参数传递、向后兼容、hook 命令字符串验证、遗留 hook 清理、非 teamai hook 保留、update 后 hooks 刷新
- 全量 317 测试通过，零回归

### For Existing Users
无需任何手动操作。下次 session 结束时 Stop hook 触发 `teamai update` → 自动安装新版 → 自动刷新 hooks + 清理重复条目。

## [0.4.5] - 2026-03-24

### Added
- **Slash Command 使用追踪**：新增 `UserPromptSubmit` hook 检测 `/slash-command` 调用（如 `/plan-eng-review`、`/tdd`），自动记录到 `usage.jsonl`
  - 新增 `teamai track-slash --stdin` CLI 命令，解析 Claude Code 的 `UserPromptSubmit` hook JSON
  - 支持冒号命名空间格式（如 `/gstack:tdd`）
  - `teamai init` 自动注入 `UserPromptSubmit` hook 到 Claude Code settings.json

### Fixed
- **Usage 上报竞态条件**：`reportUsageToTeam` 改为先 `git pull` 获取最新远端 stats 再合并本地数据，防止并发 push 时相互覆盖导致数据丢失

### Changed
- **Hooks 注入重构**：`hooks.ts` 从 200+ 行嵌套 if/else 重构为数据驱动的 `CLAUDE_HOOKS[]` 数组 + 通用 `ensureClaudeHook()` 函数，新增 hook 只需加一行定义
- `stats.ts` 和 `team-push.ts` 之间新增交叉引用注释，标注两处 merge 逻辑的关联

### Tests
- 新增 8 个 trackSlashCommand 测试：合法追踪、冒号命名空间、非 slash 忽略、空 prompt、空 STDIN、畸形 JSON、known-skills 更新
- 全量 302 测试通过，零回归

### For Existing Users
存量用户下次 `teamai pull` 或重新运行 `teamai init` 后，`UserPromptSubmit` hook 会自动注入，无需手动操作。

## [0.4.4] - 2026-03-22

### Added
- **Cursor Skill 使用追踪**：通过 postToolUse hook (matcher: `Read`) 检测 SKILL.md 文件读取，自动记录 Cursor 用户的 skill 使用到 `usage.jsonl`
  - `teamai init` 自动注入 postToolUse hook 到 Cursor 的 `hooks.json`
  - `UsageEvent.tool` 字段区分 `cursor` / `claude`，支持按工具来源分析使用数据
  - 适配 Cursor 原生 STDIN 格式（`file_path` 字段），经实际 hook 触发验证
- **Hook 自动更新**：stop hook 从 `teamai update --check` 改为 `teamai update`，支持根据 updatePolicy 自动安装更新（不再仅打印提示）
  - `doUpdate` 通过 TTY 检测区分 hook/手动模式，非 TTY 环境下 prompt 策略自动降级为提示

### Tests
- 新增 7 个测试：Cursor Read + SKILL.md 路径追踪、file_path 原生格式、非 SKILL.md 忽略、工具来源标记验证
- 全量 294 测试通过，零回归

### For Existing Users
存量 Cursor 用户需重新运行 `teamai init` 以注入 postToolUse hook。Claude Code 用户无需操作，hook 会在下次会话结束时自动更新。

## [0.4.3] - 2026-03-22

### Fixed
- **Stats 数据每次上报后丢失（Critical）**：`reportUsageToTeam` 每次 `teamai pull` 时直接覆写 `stats/<user>.yaml`，不与历史数据合并，导致之前累积的统计全部丢失。修复后先读取已有 stats 文件，count 累加、lastUsed 取更新值
- **`teamai stats` 在 pull 后显示空数据**：`showStats` 只读 `usage.jsonl`（每次成功上报后被 truncate 清空），导致用户看到 "No skill usage data yet"。修复后同时读取本地 `usage.jsonl`（未上报事件）+ 团队仓库 `stats/<user>.yaml`（已上报历史），合并展示完整统计
- **Skill 名提取字段兼容性不足**：`extractSkillName` 仅检查 `skill`/`name` 字段，遗漏部分 AI 工具的 hook 格式
  - 新增 `skill_name`、`command` 字段支持
  - 支持从 SKILL.md 文件路径（如 `/root/.cursor/skills/tdd/SKILL.md`）中自动提取 skill 目录名

### Tests
- 新增 17 个测试用例：mergeStats 合并逻辑（4）、extractSkillName 多格式提取（9）、边界条件（4）
- 全量 288 测试通过，零回归

## [0.4.2] - 2026-03-20

### Fixed
- **Skill 使用追踪完全失效**：PostToolUse hook 通过环境变量 (`$CLAUDE_TOOL_NAME`) 读取数据，但 Claude Code 实际通过 STDIN JSON 传递。hook 每次收到空参数，从未记录任何真实 skill 使用事件
  - 新增 `teamai track --stdin` 模式，从 STDIN 读取 Claude Code hook JSON 并解析 `tool_name`/`tool_input`
  - Hook 命令从 `'teamai track "$CLAUDE_TOOL_NAME" ...'` 改为 `'teamai track --stdin'`
  - 旧 CLI 参数方式仍兼容，支持手动测试
- **Skill 推荐始终显示 "you haven't tried it"**：`usage.jsonl` 上报到团队仓库后被 truncate 清空，但推荐引擎只读 `usage.jsonl`，丢失全部历史数据
  - 新增 `~/.teamai/known-skills.json` 持久化已用 skill 集合，不受 truncate 影响
  - 推荐引擎合并 `usage.jsonl`（未上报事件）+ `known-skills.json`（历史记录）两个数据源
- Hook 错误不再静默丢弃：stderr 从 `/dev/null` 改为追加到 `~/.teamai/debug.log`，方便排查

### For Existing Users
存量用户下次 `teamai pull` 时 hook 会自动升级为 `--stdin` 模式，无需手动操作。

## [0.4.1] - 2026-03-20

### Fixed
- `scanLocalForPush()` crash bug：遍历 `toolPaths` 时缺少 `toolPath.skills` null 检查，当工具配置没有 `skills` 字段时 `teamai push` 会崩溃 (TypeError)。该 bug 在 v0.3.13 重构时遗漏 (!61)
- `ToolPathsSchema.skills` 从 required 改为 optional，与运行时防御性检查一致

### Removed
- 清理 `syncTargets` 僵尸配置：v0.3.13 已改为自动检测工具，但 `syncTargets` 残留在 schema、init、28+ 处测试中。全部清除
- `init` 生成的 `teamai.yaml` 不再包含 `sharing.skills.syncTargets` 字段

## [0.4.0] - 2026-03-19

### Added
- **Skill Usage Tracking**: PostToolUse hook 自动追踪 Skill 工具调用，写入 `~/.teamai/usage.jsonl`
  - `teamai track <toolName> [toolInput]` — hook 调用的底层命令，自带 skill name 校验（防 path traversal）
  - `teamai stats` — 查看本地 skill 使用统计（次数 + 最近使用时间）
  - `teamai init` 自动注入 PostToolUse hook 到 Claude Code / Claude Internal / CodeBuddy 的 settings.json
- **团队 Usage 自动上报**: `teamai pull` 时自动聚合本地 usage 数据为 `stats/<user>.yaml` 并 git push 到团队仓库
  - Best-effort 策略，5s 超时，失败不阻塞 session 启动
  - 上报成功后自动截断本地 JSONL，文件永远很小
- **Skill Health Score**: 两维评分 = usage(0-60) + freshness(0-40)，0-100 分显示为 ★★★★★
- **Skill 推荐**: `teamai pull` 后自动推荐团队热门但用户未使用的 skill
- **Session 记录**: `teamai save-session [--summary "..."]` 收集会话工具使用记录并评估价值
  - 有价值（含错误/重试/踩坑）的 session 标记为可推送
  - 按月聚合存储到 `~/.teamai/sessions/<year-month>.md`
- **团队周报**: `teamai digest` 生成团队 AI 工具使用周报（最热 skill、活跃成员、session 摘要）
- 新增设计文档 `docs/designs/team-intelligence-platform.md`
- 新增 `TODOS.md` 记录延迟工作项

### New CLI Commands
| Command | Description |
|---------|-------------|
| `teamai track` | 追踪工具使用（PostToolUse hook 调用） |
| `teamai stats` | 查看本地 skill 使用统计 |
| `teamai save-session` | 保存会话工具使用摘要 |
| `teamai digest` | 生成团队周报 |

### For Existing Users
存量用户需重新运行 `teamai init` 以注入 PostToolUse hook。

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
