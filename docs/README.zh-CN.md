# TeamAI CLI 文档

> [English](README.md) | [简体中文](README.zh-CN.md)

`docs/` 下所有文档的总目录。AI Agent 读到的是 `/teamai` skill（`skills/teamai/` 与 `skill-data/`），不在此列。

## 面向用户

第一次用 TeamAI？先看[快速开始](guide/zh-CN/getting-started.md)。

| 文档 | 内容 |
| --- | --- |
| [使用指南](usage-guide.zh-CN.md) | 安装、配置示例、Git Provider、成员接入、日常流程、命令与配置参考、Windows、FAQ |
| [产品概览](product-overview.zh-CN.md) | 产品架构、核心概念、三层能力、支持的 Agent |
| [CI 示例](../examples/ci/README.md) | MR 知识提炼与 teamwiki 一致性检查的流水线示例 |

## 面向维护者

| 文档 | 内容 |
| --- | --- |
| [贡献指南](../.github/CONTRIBUTING.md) | 开发环境、项目结构、代码风格、测试规范 |
| [CI E2E 配置](dev/ci-e2e-setup.md) | GitHub Actions 上 `e2e` job 需要的 secrets 与 fixture 仓库 |
| [CI 代码侵蚀检测](dev/ci-code-erosion.md) | 每个 PR 上的 SlopCodeBench 信息性报告 |
| [更新日志](../CHANGELOG.md) | 版本发布说明 |

## 设计文档

[`designs/`](designs/README.md) 每个功能设计一篇。目录页逐篇标明该设计是已实现、实施中还是提案。
