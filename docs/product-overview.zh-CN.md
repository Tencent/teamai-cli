# TeamAI 产品概览

安装和日常使用在[使用指南](usage-guide.zh-CN.md)。

TeamAI 把团队的 skills、rules、agents、learnings、models、MCP 等 AI 资产放在一个 git 仓库里，同步到每个人的 AI 工具。

---

## 三层

| 层 | 做什么 | 看哪里 |
|----|--------|--------|
| **Team Execution** | 每台机器上同一套 skills、rules、hooks | [基础 Harness](guide/zh-CN/sharing.md)、[分发管理机制](guide/zh-CN/distribution.md)、[工作流](guide/zh-CN/workflow.md) |
| **Team Context** (beta) | Agent 能搜到团队记下的经验和代码结构 | [团队上下文](guide/zh-CN/knowledge.md) |
| **Team Improvement** (beta) | 会话里的经验写回团队，看团队怎么用 AI | [Dashboard](guide/zh-CN/dashboard.md)、[使用统计上报](guide/zh-CN/reporting.md)、[评分器](guide/zh-CN/scorers.md) |

各 Agent 支持哪些能力，见 README 的[产品概览](../README.zh-CN.md#产品概览)。Git 平台支持 GitHub、GitLab、GitCode、CNB、TGit 和私有 Git 服务。

## 怎么流转

```
teamai push → 分支 + PR → 评审合并
                              ↓
SessionStart hook → teamai pull → 各个 AI 工具
```

## 团队仓库里有什么

| 资源 | 位置 |
|------|------|
| Skills | `skills/<name>/SKILL.md` |
| Rules | `rules/*.md` |
| 共享指令 | `claudemd/*.md` |
| Agents | `agents/<name>.yaml` |
| 团队文化 | `culture.md` |
| Env | `env/env.yaml` |
| Hooks | `hooks/hooks.yaml` |
| MCP | `mcp/mcp.yaml` |
| Models | `models/models.yaml` |
| 团队包 | `teamai.yaml` 的 `packages` |
| Docs | `docs/` |
| Learnings | `learnings/` |
| 代码知识图谱 | `teamwiki/` |

放进 `<namespace>/` 子目录的，只发给声明了它的角色和项目，见[分发管理机制](guide/zh-CN/distribution.md)。

## Team Context (beta)

```bash
teamai recall enable                                  # 默认关
teamai recall "port conflict"
teamai import --from-repo https://github.com/org/repo # 代码知识图谱
```

打开 recall 后，Agent 做任务前会先搜团队经验。会话里反复纠正或重试时，结束会提示把经验分享给团队。

## Team Improvement (beta)

```bash
teamai digest                                     # 团队周报
teamai session save                               # 保存脱敏的会话摘要
teamai session migrate                            # 在 AI 工具之间迁移完整会话；归档、检索并恢复团队会话
teamai dashboard                                  # 本地看板
teamai recall maintenance --prune --dry-run       # 找出没人用的经验
```
