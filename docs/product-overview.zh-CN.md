# TeamAI 产品概览

> [English](product-overview.md) | [简体中文](product-overview.zh-CN.md)

本文介绍 TeamAI 的产品架构、Agent 支持范围和核心能力。安装与日常使用流程请参阅[使用指南](usage-guide.zh-CN.md)。

---

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
    <tr><td>GitHub Copilot CLI</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>CodeBuddy</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>WorkBuddy</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>OpenCode</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>OpenClaw</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Hermes</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>DeepSeek Harness</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
    <tr><td>Qoder</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Kiro</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>ZCode</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">—</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td></tr>
    <tr><td>Oh My Pi</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">✓</td><td align="center">—</td><td align="center">—</td><td align="center">—</td></tr>
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

learnings 隔离：仓库 `learnings/` 根目录对所有人共享；`learnings/<project-id>/` 为项目私有。详见[使用指南](usage-guide.zh-CN.md#多项目project-作为与-role-正交的维度)。

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
| **Agents** | `agents/<name>.yaml`、`agents/<namespace>/<name>.yaml` | 根目录 agents 对所有人生效；namespace 子目录只同步给在 `agents:` 中列出它的角色/项目 |
| **Culture** | `culture.md` | 团队使命、价值观与协作准则——注入各 Agent 的 CLAUDE.md / AGENTS.md，成为每次会话的行事底色 |
| **CLAUDE.md** | `claudemd/*.md` | |
| **Env** | `env/` | 通用环境变量、团队级开关；不建议直接放密钥 |
| **Hooks** | `hooks/hooks.yaml` | 每条 hook 可加 `roles:`，只分发给持有这些角色的成员 |
| **MCP** | `mcp/mcp.yaml` | 每个 server 可加 `roles:`，只分发给持有这些角色的成员 |
| **Packages** | `teamai.yaml` | 目前只支持 npm 包和 Claude 插件 |
| **Models** | — | 暂时没有对全部 provider 实现 |

文件格式与完整工作流见[使用指南](usage-guide.zh-CN.md)。

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

只要 extract 发现了组件，就会写入 `teamwiki/evidence/code/<project>/_manifest.json`（包括跳过 AI 增强或增强没有产出的情况），因此 `--deep-enrich` 可以接着跑。

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
| **看板（Dashboard）** | `teamai dashboard` | 统一的 Overview / Team Execution / Team Context / Team Improvement 界面，保留本机实时会话、近 7 天趋势、每会话估算费用，支持中英文及日间/夜间/跟随系统主题。 |
| **知识库健康（KB Health）** | `teamai dashboard` → Team Context / Team Improvement | 保留各类型覆盖率、高频召回与沉默条目、最近召回月份统计、作者贡献及维护控制台；完整 `/kb-report` 报告仍可访问。 |
