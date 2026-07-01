---
name: teamai-workflow
description: "TeamAI 命令速查与工作流路由 — 快速找到正确的 teamai 命令。当用户泛泛提到 teamai、团队知识库、或不确定该用哪个命令时触发。"
---

# TeamAI 命令速查

teamai CLI 的完整功能索引。每个功能区有对应的专项 skill，此处仅做路由指引。

## 环境初始化

```bash
teamai init --repo <团队仓库地址>   # 首次配置
teamai doctor                       # 诊断环境问题
```

## 命令速查表

| 需求 | 命令 | 详细引导 |
|------|------|----------|
| 搜索团队知识 | `teamai recall "<关键词>"` | 见 rule: `teamai-recall` |
| 深度检索 | `teamai recall --depth lookup "<问题>"` | 同上 |
| 同步团队知识 | `teamai pull [--force]` | 无需额外指引 |
| 推送本地资源 | `teamai push` | 无需额外指引 |
| 导入代码仓库 | `teamai import --from-repo <url>` | 见 skill: `teamai-import` |
| 批量导入 | `teamai import --from-repo-list <yaml>` | 见 skill: `teamai-import` |
| 导入 iWiki | `teamai import --from-iwiki <space>` | 见 skill: `teamai-import` |
| 导入 MR 经验 | `teamai import --from-mr <url> --all` | 见 skill: `teamai-import` |
| 分享经验 | `teamai contribute --file <f> --title <t>` | 见 skill: `teamai-share-learnings` |
| 知识库检查 | `teamai codebase --lint` | 无需额外指引 |
| 查看差异 | `teamai status` | 无需额外指引 |
| 列出知识 | `teamai list [skills\|rules\|docs]` | 无需额外指引 |
| 代码知识图谱 | `teamai import --from-repo <url>` | 见 skill: `team-wiki-codebase` |

## AI 调用标注

带 `*` 的命令会 spawn AI CLI 子进程（claude/codex/codebuddy）：
- `teamai import --from-repo` *
- `teamai import --from-repo-list` *
- `teamai import --from-mr` *
- `teamai import --from-iwiki` *
- `teamai import --dir` *

无 AI CLI 时加 `--skip-enrich`，然后按 `teamai-import` skill 的 Chat 适配流程手动完成。

## 典型工作流

```
新成员入职 → init → pull → doctor
开始任务   → recall (每次必做)
导入新仓库 → import (见 teamai-import skill)
任务完成   → contribute (见 teamai-share-learnings skill)
定期维护   → pull → codebase --lint
```
