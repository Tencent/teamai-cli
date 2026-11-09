# teamai-codebase-deep-enrich

[English](README.md) | 中文

为 `teamai import` 已提取到 teamwiki 的代码库编写深度知识文档，放在它的证据旁边：每个组件的设计文档、架构总览、图文档和跨组件场景。

`teamai codebase --deep-enrich` 会启动它，`teamai-import-from-repo` 对导入的每个仓库都会运行它。

## 文件

| 文件 | 是什么 | 读取什么 |
|---|---|---|
| `WORKFLOW.yaml` | 步骤 | |
| `component.md` | 为每个组件的设计文档向 AI 工具提的问题 | `inputs.project`，以及 `item.slug`、`item.responsibilities`、`item.facts`、`item.call_chains`、`item.deps` |
| `architecture.md` | 为架构总览提的问题 | `inputs.project`、`steps.plan.outputs.architecture.modules`、`.edges`、`.interfaces` |
| `scenarios.md` | 为场景时序图提的问题 | `inputs.project`、`steps.graph.outputs.scenarios.architecture`、`.call_chains`、`.modules` |

## 输入

| 输入 | 含义 |
|---|---|
| `wiki_root` | teamwiki 目录 |
| `project` | `evidence/code/` 下的代码库 |
| `max_modules` | 为多少个组件写文档；`0` 表示全部组件 |
| `concurrency` | 同时写多少份组件文档；`teamai codebase --deep-enrich` 传 `5` |
| `publish` | 把文档提交并推送到存放 `wiki_root` 的团队仓库。默认 `false` |

## 输出

| 输出 | 含义 |
|---|---|
| `text` | 命令打印的摘要 |
| `exit_code` | 有文档缺失时为 `1` |
| `complete` | 所有文档都已写完 |
| `missing_components` | 没有文档的组件，下一次运行会补写 |
| `missing_architecture` | 缺少架构总览 |

## 相关设置

- 编写文档的 AI 工具：你配置里的 `workflows.tools`、`TEAMAI_AI_TOOL` 或 `ai.tool`。这里指定的工具无法运行时，运行失败。

## 替换它

把这个目录复制到团队仓库的 `workflows/teamai-codebase-deep-enrich/`，修改后推送，再运行 `teamai pull`。团队的目录会整体替换这个目录：保留 `WORKFLOW.yaml` 引用的每个文件，并保留输入和输出，因为上面的调用方会传这些输入、读这些输出。
