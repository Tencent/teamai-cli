<p align="center">
  <img src="assets/teamai-cli-logo.svg" alt="teamai-cli">
</p>

# TeamAI — Make Every Team AI Native

> [English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/Tencent/teamai-cli/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![npm downloads](https://img.shields.io/npm/dm/teamai-cli.svg)](https://www.npmjs.com/package/teamai-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

TeamAI 统一管理团队的 Skills、Rules、MCP 和知识，驾驭 Claude Code、Codex、CodeBuddy、WorkBuddy、OpenCode、Cursor 等 AI Agents。

## 贡献者

感谢每一位为 TeamAI 贡献代码的伙伴！

<a href="https://github.com/Tencent/teamai-cli/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Tencent/teamai-cli" alt="Contributors" />
</a>

由 [contrib.rocks](https://contrib.rocks) 生成。

## 快速开始

### 安装

```bash
npm install -g teamai-cli
```

> **没用过 Git？** 把[接入提示词](docs/prompts/README.zh-CN.md)粘贴给当前的 AI 工具，让它代跑命令。

### 团队管理员 / 个人使用者

在 Git 托管平台（GitHub、GitLab、GitCode、CNB、TGit，或私有 Git 服务）创建共享经验仓库，**授予团队成员写权限**，然后运行 `teamai init https://github.com/yourorg/yourrepo`。

> **还没有团队仓库？** 可以从内置了成套 skills、rules、review agents 的模板起步。浏览 [teamai-hub](https://github.com/teamai-hub) org，点 **Use this template** 生成自己的仓库，再对它执行 `teamai init`。

### 团队成员

```bash
# 二选一：按你想要的安装范围选择其中一条

# 项目级初始化（默认，资源安装到项目目录下）
cd /path/to/my-project
teamai init https://github.com/yourorg/yourrepo

# 或者，用户级初始化（资源安装到 ~/ 下）
teamai init https://github.com/yourorg/yourrepo --scope user
```

初始化完成后，每次开启 AI 会话时都会自动拉取管理员发布的 skills / rules 等 Harness 更新，无需手动同步。

> **完整使用指南**：[docs/usage-guide.zh-CN.md](docs/usage-guide.zh-CN.md)（[English](docs/usage-guide.md)）— 涵盖从团队创建到日常使用的全流程。

## 产品架构

**Team Execution × Team Context (beta) × Team Improvement (beta)**：

| 层 | 要解决的问题 | 当前 CLI 中的体现 |
|----|--------------|-------------------|
| **Team Execution** | 让每个 Agent 按团队的方式工作 | `init` / `pull` / `push`，skills、rules、agents、hooks、MCP、env |
| **Team Context** (beta) | 让每个 Agent 理解整个团队 | recall、learnings、代码知识图谱、teamwiki... |
| **Team Improvement** (beta) | 让每一次执行都成为团队能力的积累 | 基于摩擦信号的经验分享、sessions、digest、dashboard... |

## 功能概览

<table>
  <thead>
    <tr>
      <th rowspan="2">Agent</th>
      <th colspan="7">Team Execution</th>
      <th colspan="3">Team Context (beta)</th>
      <th colspan="3">Team Improvement (beta)</th>
    </tr>
    <tr>
      <th>skills</th><th>rules</th><th>docs</th><th>env</th><th>agents</th><th>hooks</th><th>mcp</th>
      <th>learnings</th><th>codebase</th><th>teamwiki</th>
      <th>usage</th><th>sessions</th><th>dashboard</th>
    </tr>
  </thead>
  <tbody>
    <tr><td>Claude Code</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Codex</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Cursor</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>CodeBuddy</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>WorkBuddy</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>OpenCode</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>OpenClaw</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Hermes</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>DeepSeek Harness</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Qoder</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>ZCode</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
  </tbody>
</table>

**Git 托管平台** —— GitHub · GitLab · GitCode · CNB · TGit · 私有 Git 服务。

### 分发策略

管理员一次配置、随 `teamai pull` 分发给每位成员的团队级设置：

| 能力 | 命令 | 作用 |
|------|------|------|
| **项目（Projects）** | `teamai projects` | 将工作目录绑定到一个或多个逻辑项目，使其同步该项目的 skills、knowledge 以及隔离的 learnings。与角色正交。 |
| **角色（Roles）** | `teamai roles` | 定义「角色 → 命名空间」映射，让每位成员只同步与自身角色匹配的 skills。 |
| **标签（Tags）** | `teamai tags` | 给 skills / rules 打标签，成员只订阅自己需要的标签。 |
| **订阅源（Sources）** | `teamai source` | 订阅额外的 skill 仓库——其他团队的公开仓库，或本团队内的公共/共享仓库；已订阅的 skills 会在 pull 时自动同步。 |

learnings 隔离：仓库 `learnings/` 根目录对所有人共享；`learnings/<project-id>/` 为项目私有。详见[使用指南](docs/usage-guide.zh-CN.md#多项目project-作为与-role-正交的维度)。

## Team Execution

> One Team. One Harness. Every Agent.

TeamAI 把 skills、rules、docs、hooks 统一存放在共享 Git 仓库，通过「push → 评审合并 → pull」的流程分发到每位成员的本地 AI 工具，并支持订阅其他团队或公共仓库的 Harness。

### 工作原理

```
teamai push → 创建分支 + MR → reviewer 审批合并
                                    ↓
           SessionStart hook → teamai pull → 同步到本地 AI 工具
```

### 分发内容

每类资源分发到每个 Agent：

| 资源 | 团队仓库中的位置 | 备注 |
|------|------------------|------|
| **Skills** | `skills/<name>/SKILL.md` | |
| **Rules** | `rules/*.md` | |
| **Docs** | `docs/` | 项目基础文档，默认不全量加载（渐进式披露） |
| **Agents** | `agents/<name>.yaml` | |
| **Culture** | `culture.md` | 团队使命、价值观与协作准则——注入各 Agent 的 CLAUDE.md / AGENTS.md，成为每次会话的行事底色 |
| **CLAUDE.md** | `claudemd/*.md` | |
| **Env** | `env/` | 通用环境变量、团队级开关；不建议直接放密钥 |
| **Hooks** | `hooks/hooks.yaml` | |
| **MCP** | `mcp/mcp.yaml` | |
| **Packages** | `teamai.yaml` | 目前只支持 npm 包和 Claude 插件 |
| **Models** | — | 暂时没有对全部 provider 实现 |

文件格式与完整工作流见[使用指南](docs/usage-guide.zh-CN.md)。

## Team Context (beta)

> Every agent understands how the team works.

除了分发 Harness，TeamAI 还把团队沉淀的经验和代码结构组织成可检索的知识库，让 AI 在需要时自动召回。

### 自动经验沉淀

Session 结束时，Stop hook 按**摩擦信号**对 session 评分——这些信号表明本次 session 踩到了值得记录的东西：你打断或纠正了 AI、拒绝了某次工具调用，或 AI 反复重试出错的工具。又长又顺（工具调用很多但没有摩擦）的 session 不会触发；真正较劲过的 session 才会。达标后 AI 会显示如下英文提示：

```
[teamai] This session may contain a problem worth documenting: you interrupted the AI twice, the AI retried failing tools 8 times.

Task: Fix duplicate project-level Hook injection

Consider running /teamai-share-learnings to summarize what you learned and share it with your team.
```

提示会列出实际触发它的非零摩擦信号；如果能取得首个任务摘要，还会在脱敏、单行化后附上任务上下文。`/teamai-share-learnings` skill 自动总结 session 经验并推送到团队仓库。每个 session 最多提示一次。团队可在 `teamai.yaml` 设置 `sharing.contributeHint.enabled: false` 关闭该提示（成员可用本地配置 `contributeHintEnabled` 覆盖），Stop hook 的其余功能不受影响。

### 团队知识检索

让 AI 在执行任务前自动检索团队积累的知识。该功能**默认关闭**，需显式开启——团队可在 `teamai.yaml` 设 `sharing.recall.enabled: true` 作为默认值，成员也可本地覆盖：

```bash
teamai recall enable     # 开启：部署 teamai-recall 子 agent + 注入引导规则
teamai recall disable    # 关闭：移除子 agent 和规则
teamai recall status     # 查看生效状态（团队默认 + 用户覆盖）
```

**通过子 agent 检索**：开启后 `teamai pull` 会把内置的 `teamai-recall` 子 agent 部署到各 AI 工具的 `agents/` 目录。AI 在任务开始前调用它——由子 agent 提取关键词、执行检索、读取命中的源文件，最后返回结构化的团队知识摘要。subagent 会先做相关性预检（`teamai recall --check`），当任务与团队知识无关时直接跳过检索。子 agent 底层调用的仍是 `teamai recall` 命令，也可手动直接运行：

```bash
$ teamai recall "port conflict"
[1/2] MR review caught a port-conflict bug ★1 [user]
Author: member-a | Score: 18.5 | Tags: troubleshooting, networking

[2/2] Deployment configuration best practices [project]
Author: member-b | Score: 12.0 | Tags: deploy, config
Matched: conflict | Missing: port
```

### 代码知识图谱

`teamai import` 将源码仓库解析为 `teamwiki/` 下的结构化图谱，实现结构感知的检索：

```bash
teamai import --from-repo https://github.com/org/repo
teamai import --from-org myorg              # 批量导入所有仓库
teamai codebase --extract /path/to/repo     # 本地提取到 teamwiki/
teamai codebase --deep-enrich --project my-service --output /path/to/repo # 从提取结果生成深度知识文档
teamai codebase --reconcile --output /path/to/repo # 将产品文档映射到代码页面
teamai codebase --lint --output /path/to/repo # 检查本地提取的图谱
```

图谱存储组件、接口、配置和跨仓库依赖边。`teamai recall` 利用图谱进行增强排名。
当召回命中 codebase 页面时，结果会附带一行 `Sources:`，列出相关源文件路径，供 agent 直接作为代码改动的入口，无需重新探索代码库。

依赖边来自两条并行的提取轨道，重叠时以 AST 结果优先：

- **AST 轨**（TypeScript/JavaScript、Python、Go）：使用 WASM 版 [tree-sitter](https://tree-sitter.github.io/) 解析器，将 `import`/`require`、调用点、以及 TS `implements` 子句解析为精确的文件到文件 `DEPENDS_ON` / `REFERENCES` / `IMPLEMENTS` 边（标记为 `code-ast`，带置信度权重）。
- **启发式轨**（所有语言，含 Java/Rust）：基于正则的提取（标记为 `code-heuristic`），同时覆盖 AST 轨未支持的语言。

WASM 解析器是纯 JavaScript 依赖，无需任何原生编译工具链。若因任何原因加载失败，提取会降级到启发式轨并记录一条 `AST_UNAVAILABLE` gap。设置 `TEAMAI_SKIP_AST=1` 可强制仅使用启发式提取。

## Team Improvement (beta)

> Every execution makes the entire team smarter.

### Maintenance

随着 skills 和知识积累，可以把团队不再使用的内容清掉。`teamai recall maintenance` 会归档低置信度 learnings，并标出过时的 skills、rules 和 docs，供清理或更新：

```bash
teamai recall maintenance --prune --dry-run      # 预览
teamai recall maintenance --prune --archive      # 归档无用 learnings
teamai recall maintenance --update-quality       # 为过时 skills / docs 生成更新草稿
```

洞察团队实际如何使用 AI 工具，也是把 session 中的摩擦转化为共享 Skill、Rule 和知识的起点：

| 能力 | 命令 | 呈现内容 |
|------|------|----------|
| **用量（Usage）** | `teamai digest` | 团队周报——近 7 天成功率、对话、活跃时长、估算成本、缓存与纠偏趋势，以及历史累计数据。 |
| **会话（Sessions）** | `teamai session save` | 脱敏的单会话摘要（工具序列、对话轮次、干预次数），喂给周报的 Session Highlights。 |
| **看板（Dashboard）** | `teamai dashboard` | Web 看板，展示实时会话，以及本机近 7 天相对前 7 天的趋势。 |
| **知识库健康（KB Health）** | `teamai dashboard` → KB Health | 内置于看板的报告页面，展示知识库使用情况与健康状态——各类型覆盖率、高频召回条目、沉默条目、召回趋势、作者贡献及维护控制台。 |

## 命令一览

| 命令 | 说明 |
|------|------|
| `teamai init` | 初始化：OAuth 登录、关联仓库、注册成员、注入 hooks |
| `teamai pull` | 拉取团队资源并注入到本地 AI 工具 |
| `teamai push` | 推送本地资源到分支并创建合并请求 |
| `teamai packages [install] [target]` | 安装团队 npm 包和 Claude 插件。裸 `teamai packages` 安装全部；`teamai packages install <target>` 添加单个并更新声明 |
| `teamai status` | 显示本地与团队仓库的差异及资源数量，包含 namespace 下的技能和子目录中的文档 |
| `teamai contribute` | 将 session 经验分享到团队仓库 |
| `teamai recall <query>` | 搜索团队知识库（BM25 + 图谱增强） |
| `teamai recall enable/disable/status` | 开关或查看 recall 状态 |
| `teamai recall promote [learningId]` | 将高置信度 learning 晋升为正式知识（skills/rules/docs） |
| `teamai recall maintenance` | 维护知识库健康：清理低置信度 learnings、回写置信度、标记过时条目 |
| `teamai import` | 导入知识（`--dir`、`--from-repo`、`--from-org`、`--from-repo-list`、`--from-mr`） |
| `teamai codebase --extract [path]` | 提取代码事实并在 `teamwiki/` 下构建本地图谱 |
| `teamai codebase --deep-enrich` | 从已提取的 evidence 生成深度知识文档 |
| `teamai codebase --reconcile` | 将产品文档与提取的代码知识进行对账 |
| `teamai codebase --lint` | 知识图谱健康检查 |
| `teamai ci extract-mr --url <url>` | CI：从 MR 提取知识、发评论、合并后写入 |
| `teamai members` | 查看团队成员 |
| `teamai projects` | 将工作目录绑定到一个或多个逻辑项目 |
| `teamai roles` | 管理团队角色和命名空间 |
| `teamai tags` | 管理基于标签的 skill/rule 过滤 |
| `teamai skill exclude add/remove/list` | 管理不参与本地同步的 skills（[使用指南](docs/usage-guide.zh-CN.md#排除个人不需要的-skill)） |
| `teamai source` | 管理 skill 订阅源（其他团队或本团队公共仓库） |
| `teamai remove <type> <name>` | 删除资源并创建 MR |
| `teamai session save` | 将脱敏后的 session 摘要记录到月度日志（`--push` 可喂给 `digest`） |
| `teamai digest` | 生成团队周报 |
| `teamai doctor` | 诊断配置问题 |
| `teamai uninstall` | 移除所有 teamai 资源和 hooks |

## 许可证

[MIT](LICENSE)

## 贡献

欢迎提交 PR！请先阅读 [CONTRIBUTING.md](.github/CONTRIBUTING.md)。
