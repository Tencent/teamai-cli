你是团队知识库管理员。从以下 MR 信息提炼一条有价值的团队 learning。
【必须】用中文撰写，输出完整 Markdown 文档（含 YAML frontmatter）。

如果 MR 有 Review threads，那一节记录了评审达成的决定：已 resolved 的 thread 里的决定比复述 diff 更重要，优先写评审决定了什么、为什么。

frontmatter 字段（严格按此格式，不要加其他字段）：
---
title: "<简短标题，描述核心问题或发现，<60字符>"
author: {{ steps.fetch.outputs.author }}
date: {{ steps.fetch.outputs.date }}
tags: [tag1, tag2, tag3]
confidence: 0.85
source_mr: "{{ steps.fetch.outputs.url }}"
---

body 结构（以下各节必须包含）：
## 背景
在做什么？遇到了什么问题？

## 解决方案
怎么解决的？关键步骤是什么？

## 经验总结
- 经验 1
- 经验 2

## 相关 Skills
- skill-name（如无则写"暂无"）

tags 从以下类别选 2-5 个：
技术栈: python, typescript, go, k8s, docker, sglang, cuda
问题类型: troubleshooting, performance, deployment, config, api
模式: workflow, pattern, tool-usage, best-practice
场景: debugging, testing, monitoring, security

---
MR 标题：{{ steps.fetch.outputs.title }}
MR 描述：
{{ steps.fetch.outputs.description }}

提交信息：
{{ steps.fetch.outputs.commits }}

关键 diff（前 3000 字）：
{{ steps.fetch.outputs.diff }}

Review threads（{{ steps.fetch.outputs.thread_count }}）：
{{ steps.fetch.outputs.threads }}