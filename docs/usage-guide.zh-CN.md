# TeamAI CLI — 团队接入与使用指南

> [English](usage-guide.md) | [简体中文](usage-guide.zh-CN.md)

> **teamai-cli** — AI Agents 的团队协作层
>
> **让每个团队通过 AI 持续变得更聪明。** 统一工作方式（Team Execution）、共享团队 Context（Team Context），并把真实 Session 沉淀成团队能力（Team Improvement）。TeamAI 统一管理 Claude Code、Codex、GitHub Copilot CLI、CodeBuddy、WorkBuddy、OpenCode、Pi、Cursor 及其他受支持 Agent 的 Skills、Rules、Docs、Env、MCP 等资源。

第一次用 TeamAI？先看[快速开始](guide/zh-CN/getting-started.md)，按搭建团队、加入团队或分享 skill 选一条路径。

---

## 目录

- [快速开始](guide/zh-CN/getting-started.md) — 三条路径：搭建团队、加入团队或分享 skill
- [管理员初始化](guide/zh-CN/admin-setup.md) — 五份可复制配置：作用域、单仓、组织仓加项目仓、角色和项目
- [Git Provider](guide/zh-CN/providers.md) — GitHub、GitLab、GitCode、CNB、工蜂与通用 Git：检测与认证
- [成员使用](guide/zh-CN/member-guide.md) — 加入团队、日常使用、提交 Co-Author 署名
- [共享团队资源](guide/zh-CN/sharing.md) — 发布 skills、rules、docs、env、agents、hooks 与 MCP server
- [团队知识](guide/zh-CN/knowledge.md) — 知识沉淀与检索、知识库健康报告
- [团队文化](guide/zh-CN/team-culture.md) — 注入到每个 Agent 的公司与团队文化
- [代码知识图谱](guide/zh-CN/codebase-graph.md) — 把代码仓库导入团队知识图谱
- [Dashboard](guide/zh-CN/dashboard.md) — 本地看板与会话存档
- [Hooks](guide/zh-CN/hooks.md) — 内置钩子与团队钩子声明
- [Agents](guide/zh-CN/agents.md) — Agent 定义、模型别名，以及各工具的下发方式
- [跨团队订阅](guide/zh-CN/subscriptions.md) — 订阅其他团队的 skills，包括 HTTP 源
- [CI 集成](guide/zh-CN/ci.md) — 在 CI 里从合并请求提炼知识
- [团队仓库检出](guide/zh-CN/team-repo.md) — Git 子模块，以及 pull 之后运行的脚本
- [使用统计上报](guide/zh-CN/reporting.md) — 会话与用量统计会写回哪些内容
- [诊断与维护](guide/zh-CN/diagnostics.md) — `doctor`、统计、更新及相关命令
- [HTTP 契约](guide/zh-CN/http-contract.md) — 自建后端为 `init --http` 实现的接口
- [参考](guide/zh-CN/reference.md) — 命令参考、配置文件参考、模型配置
- [Windows](guide/zh-CN/windows.md) — 让 Agent 钩子在 Windows 上生效
- [卸载与常见问题](guide/zh-CN/faq.md) — 卸载 TeamAI 与常见问题

命令与 flag 的完整用法以 `teamai --help` 和 `teamai <command> --help` 为准。
